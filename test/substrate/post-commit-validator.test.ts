import { describe, it, expect } from 'vitest';
import {
  runPostCommitValidators,
  type PostCommitValidator,
  type PostCommitValidatorInput,
  type PostCommitValidatorResult,
} from '../../src/substrate/post-commit-validator.js';

// Minimal valid input shape reused across cases. Validators in the
// sequencer tests do not inspect these fields; the input is
// load-bearing only as the object the sequencer threads through.
const BASE_INPUT: PostCommitValidatorInput = Object.freeze({
  commitSha: 'a'.repeat(40),
  branchName: 'code-author/plan-test-abc123',
  repoDir: '/tmp/repo',
  diff: '',
  touchedPaths: Object.freeze(['src/example.ts']),
  plan: Object.freeze({
    id: 'plan-test',
    target_paths: Object.freeze(['src/example.ts']),
    delegation: null,
  }),
  authorIdentity: Object.freeze({
    name: 'lag-ceo',
    email: 'lag-ceo[bot]@users.noreply.github.com',
  }),
});

function buildValidator(
  name: string,
  result: PostCommitValidatorResult | (() => never),
): PostCommitValidator {
  return {
    name,
    async validate() {
      if (typeof result === 'function') return result();
      return result;
    },
  };
}

describe('runPostCommitValidators (sequencer)', () => {
  it('returns ok with no findings for an empty validator array', async () => {
    const out = await runPostCommitValidators([], BASE_INPUT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings).toEqual([]);
    }
  });

  it('returns ok with no findings when a single validator returns ok', async () => {
    const v = buildValidator('only', { ok: true });
    const out = await runPostCommitValidators([v], BASE_INPUT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings).toEqual([]);
    }
  });

  it('returns the failure when a single critical validator fires', async () => {
    const v = buildValidator('blocker', {
      ok: false,
      severity: 'critical',
      reason: 'fence breach',
    });
    const out = await runPostCommitValidators([v], BASE_INPUT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.criticalValidatorName).toBe('blocker');
      expect(out.reason).toBe('fence breach');
      expect(out.findings).toEqual([]);
    }
  });

  it('returns ok with no findings when all validators in a chain return ok', async () => {
    const validators = [
      buildValidator('v1', { ok: true }),
      buildValidator('v2', { ok: true }),
      buildValidator('v3', { ok: true }),
    ];
    const out = await runPostCommitValidators(validators, BASE_INPUT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings).toEqual([]);
    }
  });

  it('does NOT short-circuit before a critical failure; runs validators in order', async () => {
    // The second validator returns critical. Earlier validators must
    // have been called; later validators must NOT be called.
    let v3WasCalled = false;
    const validators: PostCommitValidator[] = [
      buildValidator('v1', { ok: true }),
      buildValidator('v2', {
        ok: false,
        severity: 'critical',
        reason: 'v2 said no',
      }),
      {
        name: 'v3',
        async validate() {
          v3WasCalled = true;
          return { ok: true };
        },
      },
    ];
    const out = await runPostCommitValidators(validators, BASE_INPUT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.criticalValidatorName).toBe('v2');
      expect(out.reason).toBe('v2 said no');
    }
    expect(v3WasCalled).toBe(false);
  });

  it('accumulates major findings and still returns critical when a later validator fires', async () => {
    const validators = [
      buildValidator('v1-major', {
        ok: false,
        severity: 'major',
        reason: 'minor concern',
      }),
      buildValidator('v2-minor', {
        ok: false,
        severity: 'minor',
        reason: 'cosmetic',
      }),
      buildValidator('v3-critical', {
        ok: false,
        severity: 'critical',
        reason: 'blocker reached',
      }),
    ];
    const out = await runPostCommitValidators(validators, BASE_INPUT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.criticalValidatorName).toBe('v3-critical');
      expect(out.reason).toBe('blocker reached');
      expect(out.findings).toHaveLength(2);
      expect(out.findings[0]).toEqual({
        validatorName: 'v1-major',
        severity: 'major',
        reason: 'minor concern',
      });
      expect(out.findings[1]).toEqual({
        validatorName: 'v2-minor',
        severity: 'minor',
        reason: 'cosmetic',
      });
    }
  });

  it('wraps a thrown validator into a critical result carrying the error message', async () => {
    const validators: PostCommitValidator[] = [
      {
        name: 'thrower',
        async validate() {
          throw new Error('boom');
        },
      },
    ];
    const out = await runPostCommitValidators(validators, BASE_INPUT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.criticalValidatorName).toBe('thrower');
      expect(out.reason).toContain('thrower');
      expect(out.reason).toContain('boom');
    }
  });

  it('wraps a malformed validator return into a critical result (defensive)', async () => {
    const validators: PostCommitValidator[] = [
      {
        name: 'malformed',
        // Cast through unknown: a dynamic-loaded adapter could
        // produce this shape; the sequencer must refuse rather than
        // silently treat it as ok.
        validate: (async () => ({ status: 'maybe' })) as unknown as PostCommitValidator['validate'],
      },
    ];
    const out = await runPostCommitValidators(validators, BASE_INPUT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.criticalValidatorName).toBe('malformed');
      expect(out.reason).toContain('unrecognized result shape');
    }
  });

  it('does not mutate input (deep-frozen object survives the call)', async () => {
    // BASE_INPUT is already frozen at module scope; if the sequencer
    // tried to mutate, the throw would surface here. We additionally
    // assert structural fields are intact.
    const validators = [buildValidator('v', { ok: true })];
    const snapshotBefore = JSON.stringify(BASE_INPUT);
    await runPostCommitValidators(validators, BASE_INPUT);
    expect(JSON.stringify(BASE_INPUT)).toBe(snapshotBefore);
  });

  it('is concurrency-safe: two parallel calls do not interfere', async () => {
    // Build two distinct validator chains; the sequencer is a pure
    // async function so running them in parallel must produce the
    // same shape as serial.
    const chainA = [
      buildValidator('a1', { ok: true }),
      buildValidator('a2', {
        ok: false,
        severity: 'critical',
        reason: 'A blocked',
      }),
    ];
    const chainB = [
      buildValidator('b1', { ok: false, severity: 'major', reason: 'B major' }),
      buildValidator('b2', { ok: true }),
    ];
    const [outA, outB] = await Promise.all([
      runPostCommitValidators(chainA, BASE_INPUT),
      runPostCommitValidators(chainB, BASE_INPUT),
    ]);
    expect(outA.ok).toBe(false);
    if (!outA.ok) {
      expect(outA.criticalValidatorName).toBe('a2');
    }
    expect(outB.ok).toBe(true);
    if (outB.ok) {
      expect(outB.findings).toHaveLength(1);
      expect(outB.findings[0]?.validatorName).toBe('b1');
    }
  });
});
