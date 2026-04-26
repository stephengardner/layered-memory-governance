import { describe, it, expect } from 'vitest';
import { median, extractFailureStage } from './metrics-rollup';

/*
 * Unit tests for the pure helpers behind /api/metrics.rollup. The
 * handler itself integration-tests via the Playwright e2e against
 * a live atom store; these cover the edge cases (empty series,
 * single value, even/odd lengths, malformed messages) that would be
 * hard to exercise from the e2e.
 */

describe('median', () => {
  it('returns null for an empty series; UI then renders n/a, never 0', () => {
    expect(median([])).toBeNull();
  });

  it('returns the single element for a series of length 1', () => {
    expect(median([42])).toBe(42);
  });

  it('returns the middle element for an odd-length series', () => {
    expect(median([1, 5, 2])).toBe(2);
    expect(median([10, 1, 100, 50, 5])).toBe(10);
  });

  it('averages the two middle elements for an even-length series', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 10])).toBe(7.5);
  });

  it('does not mutate the input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('handles fractional inputs without rounding', () => {
    expect(median([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 10);
    expect(median([0.05, 0.15])).toBeCloseTo(0.1, 10);
  });
});

describe('extractFailureStage', () => {
  it('pulls the stage label from a typical executor failure message', () => {
    const msg = 'executor failed at stage=apply-branch/dirty-worktree: worktree is dirty: ...';
    expect(extractFailureStage(msg)).toBe('apply-branch/dirty-worktree');
  });

  it('handles a multi-segment stage path with hyphens and slashes', () => {
    expect(extractFailureStage('failure stage=drafter/llm-call-failed: timeout'))
      .toBe('drafter/llm-call-failed');
  });

  it('falls back to "unknown" when the marker is absent', () => {
    expect(extractFailureStage('Some other error format')).toBe('unknown');
    expect(extractFailureStage('')).toBe('unknown');
  });

  it('matches the first occurrence when multiple stage markers are present', () => {
    expect(extractFailureStage('stage=first then stage=second')).toBe('first');
  });

  it('does not include trailing punctuation in the captured label', () => {
    expect(extractFailureStage('stage=apply-branch: ...')).toBe('apply-branch');
    expect(extractFailureStage('stage=status, attempt 1/3')).toBe('status');
  });
});
