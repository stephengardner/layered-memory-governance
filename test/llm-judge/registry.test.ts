/**
 * Schema registry conformance.
 *
 * Verifies each registered schema:
 *   - Has required metadata (id, version, prompt, zodSchema, jsonSchema).
 *   - jsonSchema is a well-formed JSON Schema fragment.
 *   - zodSchema accepts the example outputs expected from the LLM.
 *   - zodSchema rejects obviously invalid outputs.
 *   - Registry lookup by id returns the same object.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASSIFY_ATOM,
  DETECT_ANOMALY,
  DETECT_CONFLICT,
  getSchema,
  JUDGE_SCHEMAS,
  SUMMARIZE_DIGEST,
  VALIDATE_CLAIM,
  type JudgeSchemaId,
  type JudgeSchemaSet,
} from '../../src/llm-judge/index.js';

const allSchemas: ReadonlyArray<[JudgeSchemaId, JudgeSchemaSet<unknown>]> = [
  ['detect-conflict', DETECT_CONFLICT as JudgeSchemaSet<unknown>],
  ['validate-claim', VALIDATE_CLAIM as JudgeSchemaSet<unknown>],
  ['classify-atom', CLASSIFY_ATOM as JudgeSchemaSet<unknown>],
  ['summarize-digest', SUMMARIZE_DIGEST as JudgeSchemaSet<unknown>],
  ['detect-anomaly', DETECT_ANOMALY as JudgeSchemaSet<unknown>],
];

describe('Judge schema registry', () => {
  it.each(allSchemas)('%s has complete metadata', (_id, schema) => {
    expect(schema.id).toBeTypeOf('string');
    expect(schema.id.length).toBeGreaterThan(0);
    expect(schema.version).toBeGreaterThanOrEqual(1);
    expect(schema.systemPrompt.length).toBeGreaterThan(20);
    expect(schema.zodSchema).toBeDefined();
    expect(schema.jsonSchema).toBeDefined();
    const js = schema.jsonSchema as Record<string, unknown>;
    expect(js['type']).toBe('object');
    expect(Array.isArray(js['required'])).toBe(true);
  });

  it('registry maps ids to the same objects as named exports', () => {
    expect(JUDGE_SCHEMAS['detect-conflict']).toBe(DETECT_CONFLICT);
    expect(JUDGE_SCHEMAS['validate-claim']).toBe(VALIDATE_CLAIM);
    expect(JUDGE_SCHEMAS['classify-atom']).toBe(CLASSIFY_ATOM);
    expect(JUDGE_SCHEMAS['summarize-digest']).toBe(SUMMARIZE_DIGEST);
    expect(JUDGE_SCHEMAS['detect-anomaly']).toBe(DETECT_ANOMALY);
  });

  it('getSchema returns the same object', () => {
    expect(getSchema('detect-conflict')).toBe(DETECT_CONFLICT);
  });

  it('ids are unique across the registry', () => {
    const ids = allSchemas.map(([, s]) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DETECT_CONFLICT zod validation', () => {
  it('accepts well-formed detector output', () => {
    const parsed = DETECT_CONFLICT.zodSchema.safeParse({
      kind: 'semantic',
      explanation: 'Two atoms contradict each other.',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown kind', () => {
    const parsed = DETECT_CONFLICT.zodSchema.safeParse({
      kind: 'unknown',
      explanation: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty explanation', () => {
    const parsed = DETECT_CONFLICT.zodSchema.safeParse({
      kind: 'none',
      explanation: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects explanation over 500 chars', () => {
    const parsed = DETECT_CONFLICT.zodSchema.safeParse({
      kind: 'none',
      explanation: 'a'.repeat(501),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('VALIDATE_CLAIM zod validation', () => {
  it('accepts all three verdicts', () => {
    for (const verdict of ['verified', 'invalid', 'unverifiable']) {
      const parsed = VALIDATE_CLAIM.zodSchema.safeParse({
        verdict,
        reasoning: 'r',
      });
      expect(parsed.success).toBe(true);
    }
  });
  it('rejects bogus verdict', () => {
    const parsed = VALIDATE_CLAIM.zodSchema.safeParse({
      verdict: 'perhaps',
      reasoning: 'r',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('CLASSIFY_ATOM zod validation', () => {
  it('accepts every declared atom_type', () => {
    for (const atom_type of [
      'directive',
      'observation',
      'decision',
      'preference',
      'reference',
      'ephemeral',
    ]) {
      const parsed = CLASSIFY_ATOM.zodSchema.safeParse({
        atom_type,
        reasoning: 'r',
      });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('SUMMARIZE_DIGEST zod validation', () => {
  it('accepts a well-formed digest', () => {
    const parsed = SUMMARIZE_DIGEST.zodSchema.safeParse({
      summary: 'hello',
      key_points: ['a', 'b'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty key_points', () => {
    const parsed = SUMMARIZE_DIGEST.zodSchema.safeParse({
      summary: 'hello',
      key_points: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects more than 10 key_points', () => {
    const parsed = SUMMARIZE_DIGEST.zodSchema.safeParse({
      summary: 'hello',
      key_points: Array.from({ length: 11 }, (_, i) => `${i}`),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('DETECT_ANOMALY zod validation', () => {
  it('accepts valid anomaly report', () => {
    const parsed = DETECT_ANOMALY.zodSchema.safeParse({
      has_anomaly: true,
      severity: 'warn',
      description: 'something',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts severity=null', () => {
    const parsed = DETECT_ANOMALY.zodSchema.safeParse({
      has_anomaly: false,
      severity: null,
      description: 'all good',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown severity', () => {
    const parsed = DETECT_ANOMALY.zodSchema.safeParse({
      has_anomaly: true,
      severity: 'nuclear',
      description: 'x',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('arbitration/detect still exports identical schema via registry', async () => {
  it('re-exports point to the registry object', async () => {
    const detect = await import('../../src/substrate/arbitration/detect.js');
    expect(detect.DETECT_SCHEMA).toBe(DETECT_CONFLICT.jsonSchema);
    expect(detect.DETECT_SYSTEM).toBe(DETECT_CONFLICT.systemPrompt);
  });
});
