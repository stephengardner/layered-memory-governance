import { describe, it, expect } from 'vitest';
import { parseAutonomyDial } from './kill-switch-state';

/*
 * parseAutonomyDial is the sanitizer-half of kill-switch state parsing.
 * It answers "is this a well-formed number in range?": returns the
 * clamped number if so, `null` if malformed. The call site in
 * server/index.ts then does the three-way fallback (valid ->
 * passthrough; malformed -> fail closed to 0; file absent -> 1).
 *
 * Null is the malformed-input signal; it lets the caller distinguish
 * missing-file from torn-payload and fail appropriately for each.
 */
describe('parseAutonomyDial', () => {
  it('returns values in [0..1] unchanged', () => {
    expect(parseAutonomyDial(0)).toBe(0);
    expect(parseAutonomyDial(0.5)).toBe(0.5);
    expect(parseAutonomyDial(1)).toBe(1);
    expect(parseAutonomyDial(0.01)).toBe(0.01);
  });

  it('clamps below-zero finite numbers to 0', () => {
    expect(parseAutonomyDial(-0.1)).toBe(0);
    expect(parseAutonomyDial(-999)).toBe(0);
  });

  it('clamps above-one finite numbers to 1', () => {
    expect(parseAutonomyDial(1.5)).toBe(1);
    expect(parseAutonomyDial(2.5)).toBe(1);
    expect(parseAutonomyDial(Number.MAX_SAFE_INTEGER)).toBe(1);
  });

  it('returns null for non-finite numbers (NaN, Infinity)', () => {
    expect(parseAutonomyDial(Number.NaN)).toBeNull();
    expect(parseAutonomyDial(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseAutonomyDial(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('returns null for non-number inputs (string, null, undefined, object)', () => {
    expect(parseAutonomyDial(undefined)).toBeNull();
    expect(parseAutonomyDial(null)).toBeNull();
    expect(parseAutonomyDial('0.5')).toBeNull();
    expect(parseAutonomyDial({})).toBeNull();
    expect(parseAutonomyDial([0.5])).toBeNull();
  });
});
