import { describe, it, expect } from 'vitest';
import {
  bucketForPipelineState,
  matchesBucket,
  matchesPipelineBucket,
  normalizeBucket,
  pipelineNeedsAttention,
} from './pipelineStateFilter';
import type { PipelineSummary } from '@/services/pipelines.service';

/*
 * Pure-function coverage for the pipeline-state bucket filter. The
 * bucketing rules drive the chip counts and the Running/Paused/etc.
 * filter. Mis-bucketing (especially the unknown -> running confusion
 * fixed in this PR) silently inflates the Running count once any new
 * state ships, so the unknown branch is the load-bearing assertion.
 *
 * The needs-attention bucket is a composite predicate that reads
 * dispatch_summary + audit_counts + has_failed_atom alongside
 * pipeline_state, so it gets its own block of coverage.
 */

function makeSummary(overrides: Partial<PipelineSummary>): PipelineSummary {
  const base: PipelineSummary = {
    pipeline_id: 'pipeline-test',
    pipeline_state: 'running',
    mode: null,
    principal_id: 'apex-agent',
    correlation_id: null,
    title: 'Test pipeline',
    seed_atom_ids: [],
    created_at: '2026-05-08T00:00:00.000Z',
    last_event_at: '2026-05-08T00:00:00.000Z',
    total_cost_usd: 0,
    total_duration_ms: 0,
    current_stage_name: null,
    current_stage_index: 0,
    total_stages: 0,
    audit_counts: { critical: 0, major: 0, minor: 0, total: 0 },
    has_failed_atom: false,
    has_resume_atom: false,
    dispatch_summary: null,
  };
  return { ...base, ...overrides };
}

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

describe('matchesBucket (state-only)', () => {
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

  it('throws when called with the needs-attention bucket', () => {
    // The state-only predicate cannot evaluate the composite signal;
    // making it fail loud is better than silently false-bucketing.
    expect(() => matchesBucket('failed', 'needs-attention')).toThrow(
      /needs-attention/i,
    );
  });
});

describe('pipelineNeedsAttention', () => {
  it('flags failed pipelines', () => {
    expect(pipelineNeedsAttention(makeSummary({ pipeline_state: 'failed' }))).toBe(true);
  });

  it('flags hil-paused pipelines', () => {
    expect(pipelineNeedsAttention(makeSummary({ pipeline_state: 'hil-paused' }))).toBe(true);
  });

  it('flags pipelines with a terminal-failure marker atom', () => {
    expect(
      pipelineNeedsAttention(
        makeSummary({ pipeline_state: 'running', has_failed_atom: true }),
      ),
    ).toBe(true);
  });

  it('flags pipelines with critical audit findings', () => {
    expect(
      pipelineNeedsAttention(
        makeSummary({
          pipeline_state: 'running',
          audit_counts: { critical: 1, major: 0, minor: 0, total: 1 },
        }),
      ),
    ).toBe(true);
  });

  it('flags pipelines with partial-dispatch failure', () => {
    expect(
      pipelineNeedsAttention(
        makeSummary({
          pipeline_state: 'completed',
          dispatch_summary: { scanned: 2, dispatched: 1, failed: 1 },
        }),
      ),
    ).toBe(true);
  });

  it('flags completed pipelines that dispatched zero PRs (noop case)', () => {
    expect(
      pipelineNeedsAttention(
        makeSummary({
          pipeline_state: 'completed',
          dispatch_summary: { scanned: 1, dispatched: 0, failed: 0 },
        }),
      ),
    ).toBe(true);
  });

  it('does NOT flag a healthy running pipeline', () => {
    expect(pipelineNeedsAttention(makeSummary({ pipeline_state: 'running' }))).toBe(false);
  });

  it('does NOT flag a successful completed pipeline that shipped a PR', () => {
    expect(
      pipelineNeedsAttention(
        makeSummary({
          pipeline_state: 'completed',
          dispatch_summary: { scanned: 1, dispatched: 1, failed: 0 },
        }),
      ),
    ).toBe(false);
  });

  it('does NOT flag a completed pipeline with no dispatch_summary yet', () => {
    // dispatch_summary is null until a dispatch-record atom exists.
    // A running pipeline that has not crossed dispatch-stage should
    // not trip the noop signal -- it is in-flight, not stuck.
    expect(
      pipelineNeedsAttention(
        makeSummary({ pipeline_state: 'running', dispatch_summary: null }),
      ),
    ).toBe(false);
  });

  it('does NOT flag minor or major findings on a running pipeline', () => {
    // Only critical findings demand operator attention; majors are
    // surfaced on the card meta but do not by themselves count as
    // needs-attention.
    expect(
      pipelineNeedsAttention(
        makeSummary({
          pipeline_state: 'running',
          audit_counts: { critical: 0, major: 5, minor: 3, total: 8 },
        }),
      ),
    ).toBe(false);
  });
});

describe('matchesPipelineBucket', () => {
  it('passes through to bucketForPipelineState for exclusive buckets', () => {
    expect(matchesPipelineBucket(makeSummary({ pipeline_state: 'running' }), 'running')).toBe(true);
    expect(matchesPipelineBucket(makeSummary({ pipeline_state: 'pending' }), 'running')).toBe(true);
    expect(matchesPipelineBucket(makeSummary({ pipeline_state: 'failed' }), 'running')).toBe(false);
    expect(matchesPipelineBucket(makeSummary({ pipeline_state: 'completed' }), 'completed')).toBe(true);
  });

  it('matches needs-attention via the composite predicate', () => {
    expect(
      matchesPipelineBucket(
        makeSummary({ pipeline_state: 'failed' }),
        'needs-attention',
      ),
    ).toBe(true);
    expect(
      matchesPipelineBucket(
        makeSummary({ pipeline_state: 'running' }),
        'needs-attention',
      ),
    ).toBe(false);
  });

  it('matches all against every pipeline', () => {
    expect(matchesPipelineBucket(makeSummary({ pipeline_state: 'failed' }), 'all')).toBe(true);
    expect(matchesPipelineBucket(makeSummary({ pipeline_state: 'running' }), 'all')).toBe(true);
  });
});

describe('normalizeBucket', () => {
  it('passes through known bucket strings', () => {
    expect(normalizeBucket('needs-attention')).toBe('needs-attention');
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
