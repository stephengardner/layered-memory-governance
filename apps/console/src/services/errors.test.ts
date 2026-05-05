import { describe, it, expect } from 'vitest';
import { toErrorMessage } from './errors';

/*
 * `toErrorMessage` is the shared helper that replaced inline
 *   query.error instanceof Error ? query.error.message : String(query.error)
 * across every isError branch in the Console (per canon
 * dev-extract-at-n-equals-2). The contract: Error instances surface
 * `.message`; everything else falls back to String() coercion.
 */

describe('toErrorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns Error subclass message (TypeError, RangeError, etc.)', () => {
    expect(toErrorMessage(new TypeError('not a function'))).toBe('not a function');
  });

  it('coerces a string to itself', () => {
    expect(toErrorMessage('plain string')).toBe('plain string');
  });

  it('coerces a number to its string form', () => {
    expect(toErrorMessage(42)).toBe('42');
  });

  it('coerces null to "null"', () => {
    expect(toErrorMessage(null)).toBe('null');
  });

  it('coerces undefined to "undefined"', () => {
    expect(toErrorMessage(undefined)).toBe('undefined');
  });

  it('coerces a plain object via String() (yields "[object Object]")', () => {
    expect(toErrorMessage({ code: 'x' })).toBe('[object Object]');
  });

  it('preserves an empty Error message as the empty string', () => {
    expect(toErrorMessage(new Error(''))).toBe('');
  });
});
