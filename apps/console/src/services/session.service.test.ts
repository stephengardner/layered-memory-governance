import { describe, it, expect } from 'vitest';
import { requireActorId } from './session.service';

/*
 * `requireActorId` is the fail-closed checkpoint that replaced the
 * hardcoded `'apex-agent'` literal in CanonCard, KillSwitchPill,
 * and ProposeAtomDialog (CodeRabbit Critical on PR #78). A write
 * attempt with no configured operator MUST throw loudly — never
 * silently attribute to a fallback.
 */

describe('requireActorId', () => {
  it('returns the actor id when set', () => {
    expect(requireActorId('principal-abc')).toBe('principal-abc');
  });

  it('throws on null', () => {
    expect(() => requireActorId(null)).toThrow(/LAG_CONSOLE_ACTOR_ID/);
  });

  it('throws on undefined (pre-fetch state)', () => {
    expect(() => requireActorId(undefined)).toThrow(/LAG_CONSOLE_ACTOR_ID/);
  });

  it('throws on empty string', () => {
    expect(() => requireActorId('')).toThrow(/LAG_CONSOLE_ACTOR_ID/);
  });

  it('throws with an actionable message (hints at the env var + restart step)', () => {
    try {
      requireActorId(null);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/LAG_CONSOLE_ACTOR_ID/);
      expect(msg).toMatch(/restart/);
    }
  });
});
