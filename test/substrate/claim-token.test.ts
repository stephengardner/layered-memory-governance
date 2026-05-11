import { describe, expect, it } from 'vitest';
import {
  generateClaimToken,
  rotateClaimToken,
  constantTimeEqual,
} from '../../src/substrate/claim-token.js';

describe('claim-secret-token helpers', () => {
  it('generates a 43+ char base64url token', () => {
    const t = generateClaimToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it('rotateClaimToken returns a distinct token', () => {
    const a = generateClaimToken();
    const b = rotateClaimToken();
    expect(a).not.toBe(b);
  });

  it('constantTimeEqual returns true on match, false on mismatch, false on length mismatch', () => {
    const t = generateClaimToken();
    expect(constantTimeEqual(t, t)).toBe(true);
    expect(constantTimeEqual(t, generateClaimToken())).toBe(false);
    expect(constantTimeEqual(t, t.slice(0, -1))).toBe(false);
  });

  it('constantTimeEqual does not throw on length mismatch', () => {
    expect(() => constantTimeEqual('abc', 'abcdef')).not.toThrow();
    expect(constantTimeEqual('abc', 'abcdef')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('a', '')).toBe(false);
  });

  it('constantTimeEqual returns true on two empty strings (equal length, both zero)', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('generateClaimToken yields independent tokens across calls', () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).not.toBe(b);
  });
});
