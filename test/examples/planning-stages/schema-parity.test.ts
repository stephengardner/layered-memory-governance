/**
 * Schema-parity tests for the planning-pipeline reference stages.
 *
 * Each stage adapter ships TWO schemas: a zod schema (the
 * source-of-truth runtime validator) and a JSON-schema (a derivative
 * passed to host.llm.judge that constrains the LLM at generation
 * time). The two MUST agree on every bounded field (max AND min on
 * strings/arrays/numbers), otherwise the LLM accepts the loose
 * JSON-schema, emits an out-of-bounds value, and the runner's zod
 * safeParse rejects it post-generation -- a wasted LLM round-trip the
 * operator pays for. Dogfeed-7 (pipeline-cto-1777614599370-8xgy3p)
 * halted on this exact pattern: a 500-char what_breaks_if_revisit
 * cleared a JSON-schema that imposed no maxLength but failed the zod
 * schema's `.max(MAX_STR_SHORT)`.
 *
 * The walker covers:
 *
 *   - z.string  -> minLength + maxLength
 *   - z.number  -> minimum + maximum
 *   - z.array   -> minItems + maxItems (and recurses into items)
 *   - z.object  -> property bag (and recurses into each property)
 *
 * Failure modes the suite catches:
 *
 *   - JSON-schema lacks a peer for a zod field present in the shape
 *     (drops a mirrored field entirely): expect.toBeDefined fires
 *     with the field path so the operator sees which side is missing.
 *   - JSON-schema bound disagrees with zod bound (any of min/max for
 *     strings, arrays, or numbers): expect.toBe fires with the path,
 *     bound name, and both values.
 *   - JSON-schema is unbounded where zod is bounded (the dogfeed-7
 *     pattern): expect.toBe fires with `null !== <number>`.
 *
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

type JsonSchemaNode = Readonly<Record<string, unknown>>;

function isJsonObjectSchema(node: unknown): node is JsonSchemaNode {
  return typeof node === 'object' && node !== null;
}

/**
 * Read a string-bound check from a ZodString.
 */
function zodStringBound(
  schema: z.ZodTypeAny,
  kind: 'min' | 'max',
): number | null {
  const def = schema._def as {
    typeName?: string;
    checks?: ReadonlyArray<{ kind: string; value?: number }>;
  };
  if (def.typeName !== 'ZodString') return null;
  for (const check of def.checks ?? []) {
    if (check.kind === kind && typeof check.value === 'number') {
      return check.value;
    }
  }
  return null;
}

/**
 * Read a number-bound check from a ZodNumber. The kind 'min' includes
 * the .nonnegative() shortcut (which sets min=0 inclusive).
 */
function zodNumberBound(
  schema: z.ZodTypeAny,
  kind: 'min' | 'max',
): number | null {
  const def = schema._def as {
    typeName?: string;
    checks?: ReadonlyArray<{
      kind: string;
      value?: number;
      inclusive?: boolean;
    }>;
  };
  if (def.typeName !== 'ZodNumber') return null;
  for (const check of def.checks ?? []) {
    if (check.kind === kind && typeof check.value === 'number') {
      return check.value;
    }
  }
  return null;
}

/**
 * Read an array-bound (.min/.max on the array itself) from a ZodArray.
 */
function zodArrayBound(
  schema: z.ZodTypeAny,
  kind: 'min' | 'max',
): number | null {
  const def = schema._def as {
    typeName?: string;
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
  };
  if (def.typeName !== 'ZodArray') return null;
  if (kind === 'min') return def.minLength?.value ?? null;
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
    const def = cursor._def as {
      typeName?: string;
      innerType?: z.ZodTypeAny;
      schema?: z.ZodTypeAny;
    };
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
      if (def.innerType === undefined) return cursor;
      cursor = def.innerType;
      continue;
    }
    if (def.typeName === 'ZodEffects') {
      if (def.schema === undefined) return cursor;
      cursor = def.schema;
      continue;
    }
    return cursor;
  }
}

/**
 * One parity entry compares a zod bound against a JSON-schema bound
 * at a specific path. `bound` names the JSON-schema keyword (so
 * failures print "minLength" / "maxItems" / etc.); `kind` names the
 * field shape so the message can disambiguate string vs array vs
 * number bounds at the same path.
 */
type ParityEntry = {
  readonly path: string;
  readonly kind: 'string' | 'array' | 'number';
  readonly bound: 'minLength' | 'maxLength' | 'minItems' | 'maxItems' | 'minimum' | 'maximum';
  readonly zod: number | null;
  readonly json: number | null;
};

/**
 * Recursive parity walker. Drives off the zod schema (the source of
 * truth) and probes the JSON-schema in parallel. When a property
 * present on the zod side is MISSING from the JSON-schema side, the
 * walker fails the test directly via expect; this is the load-bearing
 * tightening over the prior version, which silently dropped missing
 * fields and let drift slip past as "no entry to compare".
 *
 * The walker fails early via expect rather than returning entries
 * with a "missing" sentinel, because a missing field is a structural
 * drift (the schemas have a different SHAPE) rather than a bound
 * disagreement (same shape, different numbers). Conflating the two
 * makes the failure message harder to read.
 */
function walkObject(
  zodSchema: z.ZodTypeAny,
  jsonSchema: JsonSchemaNode,
  path: string,
  out: ParityEntry[],
): void {
  const def = zodSchema._def as {
    typeName?: string;
    shape?: () => Record<string, z.ZodTypeAny>;
  };
  if (def.typeName !== 'ZodObject' || typeof def.shape !== 'function') {
    return;
  }
  const shape = def.shape();
  const props = jsonSchema.properties as Record<string, JsonSchemaNode> | undefined;
  expect(
    props,
    `JSON-schema at path '${path === '' ? '<root>' : path}' is missing the \`properties\` map; the zod object expects field-by-field mirroring.`,
  ).toBeDefined();
  if (props === undefined) return;
  for (const [key, fieldZod] of Object.entries(shape)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    const fieldJson = props[key];
    expect(
      fieldJson,
      `JSON-schema is missing property '${childPath}' that exists on the zod schema. Schemas drifted in shape, not just in bounds.`,
    ).toBeDefined();
    if (fieldJson === undefined) continue;
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
      const zMin = zodStringBound(fieldZod, 'min');
      const zMax = zodStringBound(fieldZod, 'max');
      const jMin = typeof fieldJson.minLength === 'number' ? fieldJson.minLength : null;
      const jMax = typeof fieldJson.maxLength === 'number' ? fieldJson.maxLength : null;
      out.push({ path, kind: 'string', bound: 'minLength', zod: zMin, json: jMin });
      out.push({ path, kind: 'string', bound: 'maxLength', zod: zMax, json: jMax });
      return;
    }
    case 'ZodNumber': {
      const zMin = zodNumberBound(fieldZod, 'min');
      const zMax = zodNumberBound(fieldZod, 'max');
      const jMin = typeof fieldJson.minimum === 'number' ? fieldJson.minimum : null;
      const jMax = typeof fieldJson.maximum === 'number' ? fieldJson.maximum : null;
      out.push({ path, kind: 'number', bound: 'minimum', zod: zMin, json: jMin });
      out.push({ path, kind: 'number', bound: 'maximum', zod: zMax, json: jMax });
      return;
    }
    case 'ZodArray': {
      const zMin = zodArrayBound(fieldZod, 'min');
      const zMax = zodArrayBound(fieldZod, 'max');
      const jMin = typeof fieldJson.minItems === 'number' ? fieldJson.minItems : null;
      const jMax = typeof fieldJson.maxItems === 'number' ? fieldJson.maxItems : null;
      out.push({ path, kind: 'array', bound: 'minItems', zod: zMin, json: jMin });
      out.push({ path, kind: 'array', bound: 'maxItems', zod: zMax, json: jMax });
      // Recurse into items: the array's element schema (zod) and
      // the JSON-schema's `items` node. Items themselves may be a
      // string field (carrying its own min/max bound) or an object.
      const itemZod = def.type;
      const itemJson = fieldJson.items;
      expect(
        itemZod,
        `Zod array at path '${path}' is missing its element type; this is a zod-side defect, not a parity drift.`,
      ).toBeDefined();
      expect(
        isJsonObjectSchema(itemJson),
        `JSON-schema array at path '${path}' is missing the \`items\` node; the zod array expects element-by-element mirroring.`,
      ).toBe(true);
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
      // ZodEnum, ZodBoolean, ZodLiteral, etc. don't carry numeric
      // bounds; the walker has no parity to assert. The
      // buildJudgeSchema helper itself enforces type-keyword parity
      // for these (e.g. ZodEnum -> {type:'string', enum:[...]}); the
      // helper's unit tests cover that surface.
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
    if (entry.zod === null && entry.json === null) continue;
    expect(
      entry.json,
      `${entry.path} (${entry.kind} ${entry.bound}): zod bound ${String(entry.zod)} does not match JSON-schema bound ${String(entry.json)}`,
    ).toBe(entry.zod);
  }
}

/**
 * Walker self-test: build a known-bad pair (zod bounded but JSON
 * unbounded) and assert the walker surfaces the drift. Without this
 * meta-test, a future refactor that silently weakens the walker
 * (regressing toward the original "skip missing peers" failure mode)
 * could pass the per-stage suites trivially.
 */
describe('parity walker self-test', () => {
  it('flags a zod-bounded string when JSON-schema lacks maxLength', () => {
    const zSchema = z.object({ x: z.string().min(1).max(50) });
    const jSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
    } as const;
    const entries = collectParity(zSchema, jSchema);
    const maxEntry = entries.find((e) => e.path === 'x' && e.bound === 'maxLength');
    expect(maxEntry).toBeDefined();
    expect(maxEntry?.zod).toBe(50);
    expect(maxEntry?.json).toBeNull();
    // The expectParity helper MUST fail in this configuration.
    expect(() => expectParity(entries)).toThrow();
  });

  it('flags a missing JSON-schema property as a structural drift', () => {
    const zSchema = z.object({ x: z.string(), y: z.string() });
    const jSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
    } as const;
    expect(() => collectParity(zSchema, jSchema)).toThrow();
  });

  it('flags a zod-bounded number when JSON-schema lacks maximum', () => {
    const zSchema = z.object({ confidence: z.number().min(0).max(1) });
    const jSchema = {
      type: 'object',
      properties: { confidence: { type: 'number' } },
    } as const;
    const entries = collectParity(zSchema, jSchema);
    const maxEntry = entries.find((e) => e.path === 'confidence' && e.bound === 'maximum');
    expect(maxEntry?.zod).toBe(1);
    expect(maxEntry?.json).toBeNull();
    expect(() => expectParity(entries)).toThrow();
  });
});

describe('plan-stage schema parity', () => {
  it('PLAN_JUDGE_SCHEMA bounds mirror planPayloadSchema bounds', () => {
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    expectParity(entries);
  });

  it('every bounded zod string field has a JSON-schema maxLength', () => {
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const orphans = entries.filter(
      (e) =>
        e.kind === 'string'
        && e.bound === 'maxLength'
        && e.zod !== null
        && e.json === null,
    );
    expect(
      orphans,
      `plan-stage zod string fields with no JSON-schema maxLength: ${orphans.map((o) => o.path).join(', ')}`,
    ).toHaveLength(0);
  });

  it('every bounded zod number field has the matching JSON-schema range keyword', () => {
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const orphans = entries.filter(
      (e) => e.kind === 'number' && e.zod !== null && e.json === null,
    );
    expect(
      orphans,
      `plan-stage zod number bounds with no JSON-schema peer: ${orphans.map((o) => `${o.path}/${o.bound}`).join(', ')}`,
    ).toHaveLength(0);
  });

  it('what_breaks_if_revisit carries the dogfeed-7 maxLength bound', () => {
    // Targeted regression for dogfeed-7
    // (pipeline-cto-1777614599370-8xgy3p, halted at plan-stage on a
    // 500-char what_breaks_if_revisit). The bound MUST be present on
    // the JSON-schema so the LLM is constrained at generation time.
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const target = entries.find(
      (e) =>
        e.path === 'plans.[].what_breaks_if_revisit' && e.bound === 'maxLength',
    );
    expect(target).toBeDefined();
    expect(target?.json).toBe(500);
    expect(target?.zod).toBe(500);
  });

  it('confidence carries minimum=0 and maximum=1 (range-drift regression)', () => {
    // Range-drift failure mode: zod schema declares
    // .min(0).max(1) on confidence; the JSON-schema MUST mirror so the
    // LLM is fenced at generation time. Without this, an LLM emitting
    // confidence=1.5 clears the JSON-schema and fails the zod
    // safeParse downstream.
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const minEntry = entries.find(
      (e) => e.path === 'plans.[].confidence' && e.bound === 'minimum',
    );
    const maxEntry = entries.find(
      (e) => e.path === 'plans.[].confidence' && e.bound === 'maximum',
    );
    expect(minEntry?.json).toBe(0);
    expect(maxEntry?.json).toBe(1);
  });

  it('plans array carries minItems=1 (empty-plans regression)', () => {
    // Empty-array drift: zod's plans.min(1) rejects empty plan
    // arrays; the JSON-schema MUST mirror so the LLM is fenced.
    const entries = collectParity(planPayloadSchema, PLAN_JUDGE_SCHEMA);
    const target = entries.find(
      (e) => e.path === 'plans' && e.bound === 'minItems',
    );
    expect(target?.json).toBe(1);
    expect(target?.zod).toBe(1);
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
      (e) =>
        e.kind === 'string'
        && e.bound === 'maxLength'
        && e.zod !== null
        && e.json === null,
    );
    expect(
      orphans,
      `spec-stage zod string fields with no JSON-schema maxLength: ${orphans.map((o) => o.path).join(', ')}`,
    ).toHaveLength(0);
  });

  it('goal/body carry minLength=1 (empty-string drift regression)', () => {
    const entries = collectParity(specPayloadSchema, SPEC_JUDGE_SCHEMA);
    const goalMin = entries.find(
      (e) => e.path === 'goal' && e.bound === 'minLength',
    );
    const bodyMin = entries.find(
      (e) => e.path === 'body' && e.bound === 'minLength',
    );
    expect(goalMin?.json).toBe(1);
    expect(bodyMin?.json).toBe(1);
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
      (e) =>
        e.kind === 'string'
        && e.bound === 'maxLength'
        && e.zod !== null
        && e.json === null,
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
    operatorIntentContent: '',
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
