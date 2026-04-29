/**
 * PLAN_CLASSIFY schema tests.
 *
 * Pins the discriminator outcome set for the plan-classify judge
 * schema. The deep planning pipeline requires a `requires-deep-pipeline`
 * outcome (per spec section 10) so the single-pass driver can detect
 * the drift signal -- a request that needs the deep pipeline but was
 * invoked without --mode=substrate-deep -- and emit an escalation
 * atom rather than silently producing a thin draft.
 *
 * The schema literal is the load-bearing addition; the prompt-engineering
 * surface that teaches the classifier WHEN to emit the new outcome ships
 * separately so the existing classifier accuracy is not regressed in
 * the same change-domain.
 */

import { describe, expect, it } from 'vitest';
import { PLAN_CLASSIFY } from '../../src/schemas/index.js';

describe('PLAN_CLASSIFY discriminator', () => {
  it('accepts the existing six outcomes', () => {
    const outcomes = ['greenfield', 'modification', 'reversal', 'research', 'emergency', 'ambiguous'];
    for (const kind of outcomes) {
      const result = PLAN_CLASSIFY.zodSchema.safeParse({
        kind,
        rationale: 'fixture',
        applicable_directives: [],
      });
      expect(result.success, `kind=${kind}`).toBe(true);
    }
  });

  it('accepts the new requires-deep-pipeline outcome (drift signal)', () => {
    const result = PLAN_CLASSIFY.zodSchema.safeParse({
      kind: 'requires-deep-pipeline',
      rationale: 'request scope is greenfield + architectural; deep pipeline required',
      applicable_directives: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown discriminator values', () => {
    const result = PLAN_CLASSIFY.zodSchema.safeParse({
      kind: 'turbo',
      rationale: 'fixture',
      applicable_directives: [],
    });
    expect(result.success).toBe(false);
  });

  it('jsonSchema enum mirrors the zod enum literally', () => {
    const props = PLAN_CLASSIFY.jsonSchema as { properties: { kind: { enum: ReadonlyArray<string> } } };
    const enumValues = props.properties.kind.enum;
    expect(enumValues).toContain('requires-deep-pipeline');
    expect(enumValues).toContain('greenfield');
    expect(enumValues).toContain('ambiguous');
    expect(enumValues.length).toBe(7);
  });
});
