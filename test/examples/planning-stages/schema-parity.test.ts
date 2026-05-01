/**
 * Schema-parity tests for the planning-pipeline reference stages.
 *
 * Each stage adapter ships TWO schemas: a zod schema (the
 * source-of-truth runtime validator) and a JSON-schema (a derivative
 * passed to host.llm.judge that constrains the LLM at generation
 * time). The two MUST agree on every bounded field's max length and
 * every bounded array's max item count, otherwise the LLM accepts the
 * loose JSON-schema, emits an over-length string, and the runner's
 * zod safeParse rejects it post-generation -- a wasted LLM round-trip
 * the operator pays for. Dogfeed-7 (pipeline-cto-1777614599370-8xgy3p)
 * halted on this exact pattern: a 500-char what_breaks_if_revisit
 * cleared a JSON-schema that imposed no maxLength but failed the zod
 * schema's `.max(MAX_STR_SHORT)`.
 *
 * The tests here walk both schemas in parallel and assert agreement.
 * A new bounded field added to one schema and forgotten on the other
 * is a single-test failure with the file/line traced back to the
 * forgotten side.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BRAINSTORM_JUDGE_SCHEMA,
  brainstormPayloadSchema,
  brainstormStage,
} from '../../../examples/planning-stages/brainstorm/index.js';
import {
  PLAN_JUDGE_SCHEMA,
  planPayloadSchema,
  planStage,
} from '../../../examples/planning-stages/plan/index.js';
import {
  SPEC_JUDGE_SCHEMA,
  specPayloadSchema,
  specStage,
} from '../../../examples/planning-stages/spec/index.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { AtomId, PrincipalId } from '../../../src/types.js';
import type {
  PlanningStage,
  StageInput,
} from '../../../src/runtime/planning-pipeline/types.js';

/**
 * Walk a zod schema and a JSON-schema in parallel, returning the
 * pair of bounds for every leaf string + array field. The walker
 * recurses into z.object, z.array, and the JSON-schema mirror
 * structures (`type: 'object'` + properties, `type: 'array'` + items).
 *
 * Path encoding: dotted JSON-pointer-ish path with array entries
 * marked as `[]` so a parity failure prints e.g.
 * `plans.[].what_breaks_if_revisit` rather than the bare field name.
 *
 * Returns a list of {path, kind, zodMax, jsonMax} tuples; the test
 * asserts zodMax === jsonMax on every entry. Unbounded fields (no
 * .max() in zod, no maxLength/maxItems in JSON-schema) are emitted as
 * `{zodMax: null, jsonMax: null}` and pass parity trivially; this
 * avoids forcing ad-hoc "this field is intentionally unbounded"
 * exemptions from the test surface.
 */
type ParityEntry = {
  readonly path: string;
  readonly kind: 'string' | 'array';
  readonly zodMax: number | null;
  readonly jsonMax: number | null;
};

/**
 * Read the .max(N) bound from a z.ZodString. zod stores checks on the
 * internal `_def.checks` array; we walk for the 'max' check kind. A
 * ZodString without a max check returns null.
 */
function zodStringMax(schema: z.ZodTypeAny): number | null {
  const def = schema._def as { typeName?: string; checks?: ReadonlyArray<{ kind: string; value?: number }> };
  if (def.typeName !== 'ZodString') return null;
  for (const check of def.checks ?? []) {
    if (check.kind === 'max' && typeof check.value === 'number') {
      return check.value;
    }
  }
  return null;
}

/**
 * Read the .max(N) bound from a z.ZodArray. zod stores the array's
 * max-length on `_def.maxLength.value`. A ZodArray without a max bound
 * returns null.
 */
function zodArrayMax(schema: z.ZodTypeAny): number | null {
  const def = schema._def as { typeName?: string; maxLength?: { value: number } | null };
  if (def.typeName !== 'ZodArray') return null;
  return def.maxLength?.value ?? null;
}

/**
 * Unwrap zod wrapper types (ZodOptional, ZodNullable, ZodEffects from
 * .refine()) to reach the underlying schema. The reference stages
 * apply .refine() for INJECTION_TOKEN guards on body fields; the
 * effect wraps the ZodString and the parity walker needs to look
 * through.
 */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cursor = schema;
  for (;;) {
    const def = cursor._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
      if (def.innerType === undefined) return cursor;
      cursor = def.innerType;
      continue;
    }
    if (def.typeName === 'ZodEffects') {
      // ZodEffects (.refine() / .transform()) wraps the inner schema
      // under `_def.schema`. Walk through so the parity check sees the
      // underlying ZodString's .max() bound.
      if (def.schema === undefined) return cursor;
      cursor = def.schema;
      continue;
    }
    return cursor;
  }
}

/**
 * Recursively walk a zod object schema in parallel with the matching
 * JSON-schema literal. For every property whose unwrapped zod type is
 * a string or an array, emit a parity entry comparing the zod max
 * bound with the JSON-schema's maxLength / maxItems.
 */
type JsonSchemaNode = Readonly<Record<string, unknown>>;

function isJsonObjectSchema(node: unknown): node is JsonSchemaNode {
  return typeof node === 'object' && node !== null;
}

function walkObject(
  zodSchema: z.ZodTypeAny,
  jsonSchema: JsonSchemaNode,
  path: string,
  out: ParityEntry[],
): void {
  const def = zodSchema._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };
  if (def.typeName !== 'ZodObject' || typeof def.shape !== 'function') {
    return;
  }
  const shape = def.shape();
  const props = jsonSchema.properties as Record<string, JsonSchemaNode> | undefined;
  if (props === undefined) return;
  for (const [key, fieldZod] of Object.entries(shape)) {
    const fieldJson = props[key];
    if (fieldJson === undefined) continue;
    const childPath = path === '' ? key : `${path}.${key}`;
    walkField(fieldZod, fieldJson, childPath, out);
  }
}

function walkField(
  fieldZodRaw: z.ZodTypeAny,
  fieldJson: JsonSchemaNode,
  path: string,
  out: ParityEntry[],
): void {
  const fieldZod = unwrapZod(fieldZodRaw);
  const def = fieldZod._def as { typeName?: string; type?: z.ZodTypeAny };
  switch (def.typeName) {
    case 'ZodString': {
      const zMax = zodStringMax(fieldZod);
      const jMax = typeof fieldJson.maxLength === 'number' ? fieldJson.maxLength : null;
      out.push({ path, kind: 'string', zodMax: zMax, jsonMax: jMax });
      return;
    }
    case 'ZodArray': {
      const zMax = zodArrayMax(fieldZod);
      const jMax = typeof fieldJson.maxItems === 'number' ? fieldJson.maxItems : null;
      out.push({ path, kind: 'array', zodMax: zMax, jsonMax: jMax });
      // Recurse into items: the array's element schema (zod) and
      // the JSON-schema's `items` node. Items themselves may be a
      // string field (carrying its own maxLength bound) or an
      // object.
      const itemZod = def.type;
      const itemJson = fieldJson.items;
      if (itemZod !== undefined && isJsonObjectSchema(itemJson)) {
        const itemPath = `${path}.[]`;
        walkField(itemZod, itemJson, itemPath, out);
      }
      return;
    }
    case 'ZodObject': {
      walkObject(fieldZod, fieldJson, path, out);
      return;
    }
    default:
      // ZodNumber, ZodEnum, ZodBoolean, etc. don't carry length bounds
      // for the parity walker to compare. Skip silently.
      return;
  }
}

function collectParity(
  zodSchema: z.ZodTypeAny,
  jsonSchema: JsonSchemaNode,
): ReadonlyArray<ParityEntry> {
  const out: ParityEntry[] = [];
  walkObject(zodSchema, jsonSchema, '', out);
  return out;
}

/**
 * Parity assertion helper. For each entry, the zod and JSON-schema
 * bounds must agree exactly. A zod bound with no JSON-schema bound is
 * the dogfeed-7 failure mode (LLM unconstrained at generation time);
 * the reverse (JSON-schema tighter than zod) is also drift and is
 * rejected. Unbounded fields (both null) pass trivially.
 */
function expectParity(entries: ReadonlyArray<ParityEntry>): void {
  for (const entry of entries) {
    if (entry.zodMax === null && entry.jsonMax === null) continue;
    expect(
      entry.jsonMax,
      `${entry.path} (${entry.kind}): zod bound ${String(entry.zodMax)} does not match JSON-schema bound ${String(entry.jsonMax)}`,
    ).toBe(entry.zodMax);
  }
}

describe('plan-stage schema parity', () => {
  it('PLAN_JUDGE_SCHEMA bounds mirror planPayloadSchema bounds', () => {
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    expectParity(entries);
  });

  it('every bounded zod string field has a JSON-schema maxLength', () => {
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const orphans = entries.filter(
      (e) => e.kind === 'string' && e.zodMax !== null && e.jsonMax === null,
    );
    expect(
      orphans,
      `plan-stage zod string fields with no JSON-schema maxLength: ${orphans.map((o) => o.path).join(', ')}`,
    ).toHaveLength(0);
  });

  it('what_breaks_if_revisit carries the dogfeed-7 maxLength bound', () => {
    // Targeted regression for dogfeed-7
    // (pipeline-cto-1777614599370-8xgy3p, halted at plan-stage on a
    // 500-char what_breaks_if_revisit). The bound MUST be present on
    // the JSON-schema so the LLM is constrained at generation time.
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const target = entries.find(
      (e) => e.path === 'plans.[].what_breaks_if_revisit',
    );
    expect(target).toBeDefined();
    expect(target?.jsonMax).toBe(500);
    expect(target?.zodMax).toBe(500);
  });
});

describe('spec-stage schema parity', () => {
  it('SPEC_JUDGE_SCHEMA bounds mirror specPayloadSchema bounds', () => {
    const entries = collectParity(specPayloadSchema, SPEC_JUDGE_SCHEMA);
    expectParity(entries);
  });

  it('every bounded zod string field has a JSON-schema maxLength', () => {
    const entries = collectParity(specPayloadSchema, SPEC_JUDGE_SCHEMA);
    const orphans = entries.filter(
      (e) => e.kind === 'string' && e.zodMax !== null && e.jsonMax === null,
    );
    expect(
      orphans,
      `spec-stage zod string fields with no JSON-schema maxLength: ${orphans.map((o) => o.path).join(', ')}`,
    ).toHaveLength(0);
  });
});

describe('brainstorm-stage schema parity', () => {
  it('BRAINSTORM_JUDGE_SCHEMA bounds mirror brainstormPayloadSchema bounds', () => {
    const entries = collectParity(
      brainstormPayloadSchema,
      BRAINSTORM_JUDGE_SCHEMA,
    );
    expectParity(entries);
  });

  it('every bounded zod string field has a JSON-schema maxLength', () => {
    const entries = collectParity(
      brainstormPayloadSchema,
      BRAINSTORM_JUDGE_SCHEMA,
    );
    const orphans = entries.filter(
      (e) => e.kind === 'string' && e.zodMax !== null && e.jsonMax === null,
    );
    expect(
      orphans,
      `brainstorm-stage zod string fields with no JSON-schema maxLength: ${orphans.map((o) => o.path).join(', ')}`,
    ).toHaveLength(0);
  });
});

/**
 * End-to-end wiring tests: the schema reaching host.llm.judge MUST be
 * the bounded one. A future refactor that splits the stage into a
 * different shape can pass the parity test on the constants alone but
 * still ship an unbounded schema if runStage is forgotten. The capture
 * tests below close that gap by re-running the stage with a stub LLM
 * and asserting the schema-as-passed.
 */
async function captureJudgeSchema<TIn, TOut>(args: {
  readonly stage: PlanningStage<TIn, TOut>;
  readonly stubOutput: TOut;
  readonly stageInput: StageInput<TIn>;
}): Promise<JsonSchemaNode | null> {
  let captured: JsonSchemaNode | null = null;
  const host = args.stageInput.host as ReturnType<typeof createMemoryHost>;
  host.llm.judge = (async (
    schema: unknown,
    _system: unknown,
    _data: unknown,
    _options: unknown,
  ) => {
    captured = schema as JsonSchemaNode;
    return {
      output: args.stubOutput,
      metadata: { latency_ms: 1, cost_usd: 0 },
    };
  }) as typeof host.llm.judge;
  await args.stage.run(args.stageInput);
  return captured;
}

function mkRunInput<TIn>(
  host: ReturnType<typeof createMemoryHost>,
  priorOutput: TIn,
): StageInput<TIn> {
  return {
    host,
    principal: 'tester' as PrincipalId,
    correlationId: 'corr',
    priorOutput,
    pipelineId: 'p' as AtomId,
    seedAtomIds: [],
    verifiedCitedAtomIds: [],
    verifiedSubActorPrincipalIds: [],
  };
}

describe('runStage wiring asserts the bounded schema', () => {
  it('plan-stage runStage passes a JSON-schema with maxLength on what_breaks_if_revisit (dogfeed-7 regression)', async () => {
    const host = createMemoryHost();
    const captured = await captureJudgeSchema({
      stage: planStage,
      stubOutput: {
        plans: [
          {
            title: 't',
            body: 'b',
            derived_from: ['x'],
            principles_applied: [],
            alternatives_rejected: [{ option: 'X', reason: 'r' }],
            what_breaks_if_revisit: 'short',
            confidence: 0.5,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'r',
              implied_blast_radius: 'framework' as const,
            },
          },
        ],
        cost_usd: 0,
      },
      stageInput: mkRunInput<unknown>(host, null),
    });
    expect(captured).not.toBeNull();
    if (captured === null) return;
    // Drill into the captured schema to find what_breaks_if_revisit.
    // The path is properties.plans.items.properties.what_breaks_if_revisit.
    const plansProp = (captured.properties as Record<string, JsonSchemaNode>)
      ?.plans;
    expect(plansProp).toBeDefined();
    const planItems = plansProp?.items as JsonSchemaNode | undefined;
    expect(planItems).toBeDefined();
    const wbrSchema = (planItems?.properties as Record<string, JsonSchemaNode>)
      ?.what_breaks_if_revisit;
    expect(wbrSchema).toBeDefined();
    expect(wbrSchema?.maxLength).toBe(500);
  });

  it('spec-stage runStage passes a JSON-schema with maxLength on body', async () => {
    const host = createMemoryHost();
    const captured = await captureJudgeSchema({
      stage: specStage,
      stubOutput: {
        goal: 'g',
        body: 'b',
        cited_paths: [],
        cited_atom_ids: [],
        alternatives_rejected: [],
        cost_usd: 0,
      },
      stageInput: mkRunInput<unknown>(host, null),
    });
    expect(captured).not.toBeNull();
    if (captured === null) return;
    const props = captured.properties as Record<string, JsonSchemaNode>;
    expect(props.body?.maxLength).toBe(64 * 1024);
    expect(props.goal?.maxLength).toBe(4096);
  });

  it('brainstorm-stage runStage passes a JSON-schema with maxLength on alternatives_surveyed.items.option', async () => {
    const host = createMemoryHost();
    const captured = await captureJudgeSchema({
      stage: brainstormStage,
      stubOutput: {
        open_questions: [],
        alternatives_surveyed: [],
        decision_points: [],
        cost_usd: 0,
      },
      stageInput: mkRunInput<unknown>(host, null),
    });
    expect(captured).not.toBeNull();
    if (captured === null) return;
    const props = captured.properties as Record<string, JsonSchemaNode>;
    const altItems = props.alternatives_surveyed?.items as
      | JsonSchemaNode
      | undefined;
    const optionSchema = (altItems?.properties as Record<string, JsonSchemaNode>)
      ?.option;
    expect(optionSchema?.maxLength).toBe(4096);
  });
});
