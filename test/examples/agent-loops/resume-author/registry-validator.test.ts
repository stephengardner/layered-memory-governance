/**
 * Tests for the Phase 3 Zod policy schema + validator helpers in
 * `examples/agent-loops/resume-author/registry.ts` (PR #308).
 *
 * The schema is the contract between the bootstrap script
 * (`scripts/bootstrap-pol-resume-strategy.mjs` / its lib factory) and
 * the runner-side `wrapAgentLoopAdapterIfEnabled` helper. A canon
 * payload that fails the schema MUST flip the wrapper to fresh-spawn
 * (fail-closed); a valid payload's `enabled: true` flag turns resume
 * on. These tests lock both behaviors.
 */

import { describe, it, expect } from 'vitest';
import {
  resumeStrategyPolicySchema,
  validatePolicy,
} from '../../../../examples/agent-loops/resume-author/registry.js';

describe('resumeStrategyPolicySchema', () => {
  it('accepts a minimal well-formed payload (enabled only)', () => {
    const result = resumeStrategyPolicySchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.max_stale_hours).toBeUndefined();
      expect(result.data.fresh_spawn_kinds).toBeUndefined();
    }
  });

  it('accepts a full well-formed payload (enabled + max_stale_hours + fresh_spawn_kinds)', () => {
    const result = resumeStrategyPolicySchema.safeParse({
      enabled: true,
      max_stale_hours: 12,
      fresh_spawn_kinds: ['budget-exhausted', 'stale-window-exceeded'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.max_stale_hours).toBe(12);
      expect(result.data.fresh_spawn_kinds).toEqual([
        'budget-exhausted',
        'stale-window-exceeded',
      ]);
    }
  });

  it('rejects payload missing enabled', () => {
    const result = resumeStrategyPolicySchema.safeParse({ max_stale_hours: 8 });
    expect(result.success).toBe(false);
  });

  it('rejects payload with non-boolean enabled', () => {
    const result1 = resumeStrategyPolicySchema.safeParse({ enabled: 'true' });
    expect(result1.success).toBe(false);
    const result2 = resumeStrategyPolicySchema.safeParse({ enabled: 1 });
    expect(result2.success).toBe(false);
  });

  it('rejects payload with non-positive max_stale_hours', () => {
    const result1 = resumeStrategyPolicySchema.safeParse({ enabled: true, max_stale_hours: 0 });
    expect(result1.success).toBe(false);
    const result2 = resumeStrategyPolicySchema.safeParse({ enabled: true, max_stale_hours: -1 });
    expect(result2.success).toBe(false);
  });

  it('rejects payload with non-integer max_stale_hours', () => {
    const result = resumeStrategyPolicySchema.safeParse({ enabled: true, max_stale_hours: 8.5 });
    expect(result.success).toBe(false);
  });

  it('rejects payload with empty string in fresh_spawn_kinds', () => {
    const result = resumeStrategyPolicySchema.safeParse({
      enabled: true,
      fresh_spawn_kinds: ['valid', ''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload with non-string in fresh_spawn_kinds', () => {
    const result = resumeStrategyPolicySchema.safeParse({
      enabled: true,
      fresh_spawn_kinds: ['valid', 42],
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload with extra unknown fields (strict closed schema)', () => {
    // The schema is `.strict()`: an extra field signals the bootstrap
    // and the schema have drifted, which should fail loudly rather
    // than silently accept and pass through the unknown field.
    const result = resumeStrategyPolicySchema.safeParse({
      enabled: true,
      max_stale_hours: 8,
      kill_switch: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects null and primitive non-objects', () => {
    expect(resumeStrategyPolicySchema.safeParse(null).success).toBe(false);
    expect(resumeStrategyPolicySchema.safeParse('not-an-object').success).toBe(false);
    expect(resumeStrategyPolicySchema.safeParse(42).success).toBe(false);
    expect(resumeStrategyPolicySchema.safeParse(true).success).toBe(false);
    expect(resumeStrategyPolicySchema.safeParse([]).success).toBe(false);
  });
});

describe('validatePolicy helper', () => {
  it('returns the parsed policy on a well-formed payload', () => {
    const result = validatePolicy({ enabled: true, max_stale_hours: 8 });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.max_stale_hours).toBe(8);
  });

  it('returns null on a malformed payload', () => {
    expect(validatePolicy({ max_stale_hours: 8 })).toBeNull(); // missing enabled
    expect(validatePolicy('not-an-object')).toBeNull();
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy(undefined)).toBeNull();
  });
});
