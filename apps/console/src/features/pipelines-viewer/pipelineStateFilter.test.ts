import { describe, it, expect } from 'vitest';
import {
  bucketForPipelineState,
  matchesBucket,
  normalizeBucket,
} from './pipelineStateFilter';

/*
 * Pure-function coverage for the pipeline-state bucket filter. The
 * bucketing rules drive the chip counts and the Running/Paused/etc.
 * filter. Mis-bucketing (especially the unknown -> running confusion
 * fixed in this PR) silently inflates the Running count once any new
 * state ships, so the unknown branch is the load-bearing assertion.
 */

describe('bucketForPipelineState', () => {
  it('maps running and pending to running', () => {
    expect(bucketForPipelineState('running')).toBe('running');
    expect(bucketForPipelineState('pending')).toBe('running');
  });

  it('maps hil-paused to paused', () => {
    expect(bucketForPipelineState('hil-paused')).toBe('paused');
  });

  it('maps completed to completed', () => {
    expect(bucketForPipelineState('completed')).toBe('completed');
  });

  it('maps failed to failed', () => {
    expect(bucketForPipelineState('failed')).toBe('failed');
  });

  it('maps unknown / null / future states to unknown (NOT running)', () => {
    // Regression: the previous default was `running`, which silently
    // inflated the Running count for any future state and let unknown
    // states leak into the Running filter. The new posture is to
    // bucket them separately so the chip counts stay honest.
    expect(bucketForPipelineState(null)).toBe('unknown');
    expect(bucketForPipelineState(undefined)).toBe('unknown');
    expect(bucketForPipelineState('')).toBe('unknown');
    expect(bucketForPipelineState('cancelled')).toBe('unknown');
    expect(bucketForPipelineState('archived')).toBe('unknown');
  });
});

describe('matchesBucket', () => {
  it('matches all bucket against any state', () => {
    expect(matchesBucket('running', 'all')).toBe(true);
    expect(matchesBucket('cancelled', 'all')).toBe(true);
    expect(matchesBucket(null, 'all')).toBe(true);
  });

  it('matches a specific bucket only when bucketForPipelineState agrees', () => {
    expect(matchesBucket('running', 'running')).toBe(true);
    expect(matchesBucket('pending', 'running')).toBe(true);
    expect(matchesBucket('failed', 'running')).toBe(false);
  });

  it('does NOT match unknown states against running', () => {
    // The fix: unknown states must not slip into the Running filter.
    expect(matchesBucket('cancelled', 'running')).toBe(false);
    expect(matchesBucket('cancelled', 'unknown')).toBe(true);
  });
});

describe('normalizeBucket', () => {
  it('passes through known bucket strings', () => {
    expect(normalizeBucket('running')).toBe('running');
    expect(normalizeBucket('paused')).toBe('paused');
    expect(normalizeBucket('completed')).toBe('completed');
    expect(normalizeBucket('failed')).toBe('failed');
    expect(normalizeBucket('unknown')).toBe('unknown');
    expect(normalizeBucket('all')).toBe('all');
  });

  it('rejects unknown values (returns null for caller fallback)', () => {
    expect(normalizeBucket('bogus')).toBeNull();
    expect(normalizeBucket(123)).toBeNull();
    expect(normalizeBucket(null)).toBeNull();
    expect(normalizeBucket(undefined)).toBeNull();
  });
});
