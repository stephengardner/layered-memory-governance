import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INCLUDE_REAPED,
  normalizeIncludeReaped,
  REAPED_TOGGLE_STORAGE_KEY,
} from './reapedToggle';

describe('reapedToggle', () => {
  it('exports a stable storage key', () => {
    /*
     * The key is the load-bearing contract between the e2e spec
     * (which clears it before each run), the storage.service prefix
     * shape, and any future read-back tooling. A rename is a
     * deliberate code change, not a casual edit.
     */
    expect(REAPED_TOGGLE_STORAGE_KEY).toBe('activities-include-reaped');
  });

  it('default is hide-reaped (false)', () => {
    /*
     * Hide-by-default mirrors the server's default-hide posture:
     * a fresh deployment surfaces only live atoms; the operator
     * opts in to historical view via the toggle.
     */
    expect(DEFAULT_INCLUDE_REAPED).toBe(false);
  });

  describe('normalizeIncludeReaped', () => {
    it('preserves true', () => {
      expect(normalizeIncludeReaped(true)).toBe(true);
    });

    it('preserves false', () => {
      expect(normalizeIncludeReaped(false)).toBe(false);
    });

    it('falls back to default for null (no value persisted)', () => {
      expect(normalizeIncludeReaped(null)).toBe(DEFAULT_INCLUDE_REAPED);
    });

    it('falls back to default for undefined', () => {
      expect(normalizeIncludeReaped(undefined)).toBe(DEFAULT_INCLUDE_REAPED);
    });

    it('falls back to default for non-boolean values (corrupted localStorage)', () => {
      /*
       * Defensive against version skew: a future build that wrote a
       * different shape, a manually edited localStorage, etc. The
       * fallback keeps the view live rather than throwing.
       */
      expect(normalizeIncludeReaped('true')).toBe(DEFAULT_INCLUDE_REAPED);
      expect(normalizeIncludeReaped(0)).toBe(DEFAULT_INCLUDE_REAPED);
      expect(normalizeIncludeReaped(1)).toBe(DEFAULT_INCLUDE_REAPED);
      expect(normalizeIncludeReaped({ enabled: true })).toBe(DEFAULT_INCLUDE_REAPED);
      expect(normalizeIncludeReaped([])).toBe(DEFAULT_INCLUDE_REAPED);
    });
  });
});
