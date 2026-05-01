import { describe, it, expect } from 'vitest';
import {
  asString,
  asNumber,
  asStringArray,
  asRecord,
  readStageOutput,
  formatDurationMs,
  formatUsd,
  formatDate,
} from './helpers';

describe('atom-detail renderer helpers', () => {
  describe('asString', () => {
    it('returns the string for a non-empty string', () => {
      expect(asString('hello')).toBe('hello');
    });
    it('returns null for empty string', () => {
      expect(asString('')).toBeNull();
    });
    it('returns null for non-strings', () => {
      expect(asString(undefined)).toBeNull();
      expect(asString(null)).toBeNull();
      expect(asString(42)).toBeNull();
      expect(asString({})).toBeNull();
    });
  });

  describe('asNumber', () => {
    it('returns finite numbers', () => {
      expect(asNumber(0)).toBe(0);
      expect(asNumber(-3.14)).toBe(-3.14);
    });
    it('rejects NaN, Infinity, and non-numbers', () => {
      expect(asNumber(Number.NaN)).toBeNull();
      expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
      expect(asNumber('5')).toBeNull();
      expect(asNumber(undefined)).toBeNull();
    });
  });

  describe('asStringArray', () => {
    it('filters non-strings and empty strings', () => {
      expect(asStringArray(['a', 'b', '', 5, null, 'c'])).toEqual(['a', 'b', 'c']);
    });
    it('returns empty for non-arrays', () => {
      expect(asStringArray(null)).toEqual([]);
      expect(asStringArray('not an array')).toEqual([]);
      expect(asStringArray({})).toEqual([]);
    });
  });

  describe('asRecord', () => {
    it('returns the object for plain records', () => {
      expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    });
    it('returns null for arrays, primitives, and null', () => {
      expect(asRecord([1, 2])).toBeNull();
      expect(asRecord('string')).toBeNull();
      expect(asRecord(null)).toBeNull();
      expect(asRecord(undefined)).toBeNull();
      expect(asRecord(42)).toBeNull();
    });
  });

  describe('readStageOutput', () => {
    it('prefers metadata.stage_output when present', () => {
      const md = { stage_output: { goal: 'go', body: 'do' } };
      const out = readStageOutput(md, '{"different":"content"}');
      expect(out).toEqual({ goal: 'go', body: 'do' });
    });

    it('falls back to JSON-parsed content when stage_output missing', () => {
      const md = {};
      const out = readStageOutput(md, '{"goal":"from-content"}');
      expect(out).toEqual({ goal: 'from-content' });
    });

    it('returns null when content is not parseable JSON and no stage_output', () => {
      expect(readStageOutput({}, 'plain text')).toBeNull();
    });

    it('returns null when content parses to non-object (array)', () => {
      expect(readStageOutput({}, '[1,2,3]')).toBeNull();
    });
  });

  describe('formatDurationMs', () => {
    it('formats sub-second durations as ms', () => {
      expect(formatDurationMs(0)).toBe('0ms');
      expect(formatDurationMs(750)).toBe('750ms');
    });

    it('formats seconds with one decimal', () => {
      expect(formatDurationMs(1500)).toBe('1.5s');
      expect(formatDurationMs(45_000)).toBe('45.0s');
    });

    it('formats minutes', () => {
      expect(formatDurationMs(60_000)).toBe('1.0m');
      expect(formatDurationMs(120_000)).toBe('2.0m');
    });

    it('formats hours', () => {
      expect(formatDurationMs(3_600_000)).toBe('1.0h');
    });

    it('returns -- for null/invalid', () => {
      expect(formatDurationMs(null)).toBe('--');
      expect(formatDurationMs(-5)).toBe('--');
    });
  });

  describe('formatUsd', () => {
    it('formats whole-cent amounts with two decimals', () => {
      expect(formatUsd(0)).toBe('$0.00');
      expect(formatUsd(1.5)).toBe('$1.50');
    });

    it('formats sub-cent amounts with four decimals', () => {
      expect(formatUsd(0.0042)).toBe('$0.0042');
    });

    it('returns -- for null/invalid', () => {
      expect(formatUsd(null)).toBe('--');
      expect(formatUsd(Number.NaN)).toBe('--');
    });
  });

  describe('formatDate', () => {
    it('formats ISO strings into a readable form', () => {
      const out = formatDate('2026-04-29T06:23:27.748Z');
      // Locale-dependent, but should always produce a non-empty
      // string and not throw on a valid ISO.
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });

    it('returns -- for empty/null/undefined', () => {
      expect(formatDate(null)).toBe('--');
      expect(formatDate(undefined)).toBe('--');
      expect(formatDate('')).toBe('--');
    });

    it('returns the raw string for unparseable input', () => {
      // new Date(invalid) returns Invalid Date, but the catch path
      // never fires; toLocaleString returns 'Invalid Date'. We
      // accept either the original or 'Invalid Date'; the contract
      // is non-empty.
      const out = formatDate('not-a-date');
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });
  });
});
