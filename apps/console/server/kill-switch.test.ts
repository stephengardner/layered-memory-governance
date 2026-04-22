import { describe, it, expect } from 'vitest';
import { parseAutonomyDial } from './index';

/*
 * autonomyDial is documented as [0..1] (see handleKillSwitchTransition
 * callers in src/services/kill-switch.service.ts). A malformed state
 * file (NaN, Infinity, out-of-range, non-number) must not escalate
 * the runtime posture. Clamp silently to the legal range.
 */
describe('parseAutonomyDial', () => {
  it('accepts values in [0..1]', () => {
    expect(parseAutonomyDial(0)).toBe(0);
    expect(parseAutonomyDial(0.5)).toBe(0.5);
    expect(parseAutonomyDial(1)).toBe(1);
    expect(parseAutonomyDial(0.01)).toBe(0.01);
  });

  it('clamps below zero to zero', () => {
    expect(parseAutonomyDial(-0.1)).toBe(0);
    expect(parseAutonomyDial(-999)).toBe(0);
  });

  it('clamps above one to one', () => {
    expect(parseAutonomyDial(1.5)).toBe(1);
    expect(parseAutonomyDial(2.5)).toBe(1);
    expect(parseAutonomyDial(Number.MAX_SAFE_INTEGER)).toBe(1);
  });

  it('rejects non-finite numbers (fallback to 1, the absent-state default)', () => {
    expect(parseAutonomyDial(Number.NaN)).toBe(1);
    expect(parseAutonomyDial(Number.POSITIVE_INFINITY)).toBe(1);
    expect(parseAutonomyDial(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('rejects non-number inputs (string, null, undefined, object)', () => {
    expect(parseAutonomyDial(undefined)).toBe(1);
    expect(parseAutonomyDial(null)).toBe(1);
    expect(parseAutonomyDial('0.5')).toBe(1);
    expect(parseAutonomyDial({})).toBe(1);
    expect(parseAutonomyDial([0.5])).toBe(1);
  });
});
