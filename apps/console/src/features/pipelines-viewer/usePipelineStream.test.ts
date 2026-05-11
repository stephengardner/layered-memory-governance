import { describe, it, expect } from 'vitest';
import { computeReconnectDelayMs } from './usePipelineStream';

/*
 * Unit tests for the pure helper exported from usePipelineStream.
 *
 * The hook itself is exercised end-to-end via the Playwright spec at
 * tests/e2e/pipeline-stream.spec.ts; the vitest suite runs under
 * `environment: 'node'` (vitest.config.ts) and pulling in jsdom +
 * @testing-library/react purely to exercise the hook's reconnect
 * machinery would inflate CI install-time without buying coverage
 * the e2e already captures.
 *
 * What IS pinnable in vitest is the backoff curve: it has to land at
 * exactly 1s/2s/4s/8s/16s with no off-by-one, no negative-attempt
 * surprise, and no overflow past the documented cap. Those branches
 * are the part most likely to regress on refactor, and they live in
 * computeReconnectDelayMs precisely so they can be locked here.
 */

describe('computeReconnectDelayMs', () => {
  it('returns 1s on attempt 0 (the first retry)', () => {
    expect(computeReconnectDelayMs(0)).toBe(1_000);
  });

  it('returns 2s on attempt 1', () => {
    expect(computeReconnectDelayMs(1)).toBe(2_000);
  });

  it('returns 4s on attempt 2', () => {
    expect(computeReconnectDelayMs(2)).toBe(4_000);
  });

  it('returns 8s on attempt 3', () => {
    expect(computeReconnectDelayMs(3)).toBe(8_000);
  });

  it('caps at 16s on attempt 4 (default max)', () => {
    expect(computeReconnectDelayMs(4)).toBe(16_000);
  });

  it('caps at 16s on attempt 10 (does not exceed the default ceiling)', () => {
    expect(computeReconnectDelayMs(10)).toBe(16_000);
  });

  it('honors a custom maxDelayMs', () => {
    expect(computeReconnectDelayMs(10, 5_000)).toBe(5_000);
    expect(computeReconnectDelayMs(2, 5_000)).toBe(4_000);
  });

  it('honors a custom initialDelayMs', () => {
    expect(computeReconnectDelayMs(0, 16_000, 500)).toBe(500);
    expect(computeReconnectDelayMs(1, 16_000, 500)).toBe(1_000);
  });

  it('falls back to initialDelayMs for negative attempt counts (defensive)', () => {
    expect(computeReconnectDelayMs(-1)).toBe(1_000);
  });

  it('falls back to initialDelayMs for non-finite attempt counts (defensive)', () => {
    expect(computeReconnectDelayMs(Number.NaN)).toBe(1_000);
    expect(computeReconnectDelayMs(Number.POSITIVE_INFINITY)).toBe(1_000);
  });
});
