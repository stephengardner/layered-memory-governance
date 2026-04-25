import { describe, it, expect } from 'vitest';
import {
  BLOB_THRESHOLD_MIN,
  BLOB_THRESHOLD_MAX,
  BLOB_THRESHOLD_DEFAULT,
  clampBlobThreshold,
  defaultBudgetCap,
} from '../../src/substrate/agent-budget.js';

describe('clampBlobThreshold', () => {
  it('clamps at min', () => { expect(clampBlobThreshold(0)).toBe(BLOB_THRESHOLD_MIN); });
  it('clamps at max', () => { expect(clampBlobThreshold(BLOB_THRESHOLD_MAX + 1)).toBe(BLOB_THRESHOLD_MAX); });
  it('passes through valid', () => { expect(clampBlobThreshold(8192)).toBe(8192); });
  it('floors fractional', () => { expect(clampBlobThreshold(4096.7)).toBe(4096); });
  it('rejects NaN by clamping to min', () => { expect(clampBlobThreshold(Number.NaN)).toBe(BLOB_THRESHOLD_MIN); });
  it('default is exported and within bounds', () => {
    expect(BLOB_THRESHOLD_DEFAULT).toBeGreaterThanOrEqual(BLOB_THRESHOLD_MIN);
    expect(BLOB_THRESHOLD_DEFAULT).toBeLessThanOrEqual(BLOB_THRESHOLD_MAX);
  });
});

describe('defaultBudgetCap', () => {
  it('returns a sane default', () => {
    const b = defaultBudgetCap();
    expect(b.max_turns).toBeGreaterThan(0);
    expect(b.max_wall_clock_ms).toBeGreaterThan(0);
    expect(b.max_usd).toBeUndefined();
  });
});
