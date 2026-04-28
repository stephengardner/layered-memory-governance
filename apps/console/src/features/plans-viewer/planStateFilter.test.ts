import { describe, expect, it } from 'vitest';
import {
  bucketForPlanState,
  matchesBucket,
  normalizeBucket,
  DEFAULT_PLAN_FILTER,
} from './planStateFilter';

describe('bucketForPlanState', () => {
  it('classifies in-flight states as active', () => {
    expect(bucketForPlanState('proposed')).toBe('active');
    expect(bucketForPlanState('approved')).toBe('active');
    expect(bucketForPlanState('executing')).toBe('active');
    expect(bucketForPlanState('draft')).toBe('active');
    expect(bucketForPlanState('pending')).toBe('active');
  });

  it('classifies succeeded as its own bucket', () => {
    expect(bucketForPlanState('succeeded')).toBe('succeeded');
  });

  it('rolls failed/abandoned/rejected into a single failed bucket', () => {
    expect(bucketForPlanState('failed')).toBe('failed');
    expect(bucketForPlanState('abandoned')).toBe('failed');
    expect(bucketForPlanState('rejected')).toBe('failed');
  });

  it('treats unknown/empty/missing as active so plans never vanish silently', () => {
    expect(bucketForPlanState(null)).toBe('active');
    expect(bucketForPlanState(undefined)).toBe('active');
    expect(bucketForPlanState('')).toBe('active');
    expect(bucketForPlanState('not-a-real-state')).toBe('active');
  });
});

describe('matchesBucket', () => {
  it('returns true for matching bucket', () => {
    expect(matchesBucket('proposed', 'active')).toBe(true);
    expect(matchesBucket('succeeded', 'succeeded')).toBe(true);
    expect(matchesBucket('failed', 'failed')).toBe(true);
    expect(matchesBucket('abandoned', 'failed')).toBe(true);
  });

  it('returns false for non-matching bucket', () => {
    expect(matchesBucket('proposed', 'failed')).toBe(false);
    expect(matchesBucket('succeeded', 'active')).toBe(false);
    expect(matchesBucket('failed', 'succeeded')).toBe(false);
  });

  it('all bucket matches everything', () => {
    expect(matchesBucket('proposed', 'all')).toBe(true);
    expect(matchesBucket('failed', 'all')).toBe(true);
    expect(matchesBucket('succeeded', 'all')).toBe(true);
    expect(matchesBucket(null, 'all')).toBe(true);
    expect(matchesBucket('totally-unknown', 'all')).toBe(true);
  });
});

describe('normalizeBucket', () => {
  it('passes through known buckets', () => {
    expect(normalizeBucket('active')).toBe('active');
    expect(normalizeBucket('succeeded')).toBe('succeeded');
    expect(normalizeBucket('failed')).toBe('failed');
    expect(normalizeBucket('all')).toBe('all');
  });

  it('falls back to default for unknown / missing / corrupted values', () => {
    expect(normalizeBucket(null)).toBe(DEFAULT_PLAN_FILTER);
    expect(normalizeBucket(undefined)).toBe(DEFAULT_PLAN_FILTER);
    expect(normalizeBucket('')).toBe(DEFAULT_PLAN_FILTER);
    expect(normalizeBucket('archived')).toBe(DEFAULT_PLAN_FILTER);
    expect(normalizeBucket(42)).toBe(DEFAULT_PLAN_FILTER);
    expect(normalizeBucket({ x: 1 })).toBe(DEFAULT_PLAN_FILTER);
  });

  it('default is all so succeeded plans are visible without an extra click', () => {
    expect(DEFAULT_PLAN_FILTER).toBe('all');
  });
});
