import { describe, it, expect } from 'vitest';
import {
  deriveTrueOutcome,
  trueOutcomeTone,
  readPlanDispatchSummary,
} from './trueOutcome';

describe('deriveTrueOutcome', () => {
  it('returns succeeded when plan_state=succeeded AND dispatched>=1', () => {
    expect(
      deriveTrueOutcome({
        plan_state: 'succeeded',
        dispatch_summary: { dispatched: 1, failed: 0 },
      }),
    ).toBe('succeeded');
  });

  it('returns noop when plan_state=succeeded AND dispatched===0 (the bug case)', () => {
    expect(
      deriveTrueOutcome({
        plan_state: 'succeeded',
        dispatch_summary: { dispatched: 0, failed: 0 },
      }),
    ).toBe('noop');
  });

  it('returns noop when plan_state=succeeded with NO dispatch summary at all', () => {
    /*
     * Operator quote: "a plan should also not show a succeeded green
     * pill if it failed to dispatch." Absence of dispatch info on a
     * succeeded plan is informative -- a plan that genuinely shipped
     * a PR always has a dispatch record on the chain.
     */
    expect(deriveTrueOutcome({ plan_state: 'succeeded' })).toBe('noop');
  });

  it('returns failed when plan_state=succeeded BUT dispatch_summary.failed > 0', () => {
    /*
     * Partial-dispatch case: the dispatcher attempted N invocations
     * and one halted. The substrate state may still read 'succeeded'
     * because the plan-stage produced a valid plan; the dispatch
     * counters are the load-bearing signal.
     */
    expect(
      deriveTrueOutcome({
        plan_state: 'succeeded',
        dispatch_summary: { dispatched: 1, failed: 1 },
      }),
    ).toBe('failed');
  });

  it('returns failed when plan_state=failed regardless of dispatch counts', () => {
    expect(deriveTrueOutcome({ plan_state: 'failed' })).toBe('failed');
    expect(
      deriveTrueOutcome({
        plan_state: 'failed',
        dispatch_summary: { dispatched: 1, failed: 0 },
      }),
    ).toBe('failed');
  });

  it('returns failed for terminal-negative states abandoned and rejected', () => {
    expect(deriveTrueOutcome({ plan_state: 'abandoned' })).toBe('failed');
    expect(deriveTrueOutcome({ plan_state: 'rejected' })).toBe('failed');
  });

  it('returns paused when plan_state=paused or pipeline_state=hil-paused', () => {
    expect(deriveTrueOutcome({ plan_state: 'paused' })).toBe('paused');
    expect(deriveTrueOutcome({ pipeline_state: 'hil-paused' })).toBe('paused');
  });

  it('returns in-progress for proposed/approved/executing/pending/running/draft', () => {
    expect(deriveTrueOutcome({ plan_state: 'proposed' })).toBe('in-progress');
    expect(deriveTrueOutcome({ plan_state: 'approved' })).toBe('in-progress');
    expect(deriveTrueOutcome({ plan_state: 'executing' })).toBe('in-progress');
    expect(deriveTrueOutcome({ plan_state: 'draft' })).toBe('in-progress');
    expect(deriveTrueOutcome({ pipeline_state: 'pending' })).toBe('in-progress');
    expect(deriveTrueOutcome({ pipeline_state: 'running' })).toBe('in-progress');
  });

  it('returns succeeded for pipeline_state=completed AND dispatched>=1', () => {
    expect(
      deriveTrueOutcome({
        pipeline_state: 'completed',
        dispatch_summary: { dispatched: 2, failed: 0 },
      }),
    ).toBe('succeeded');
  });

  it('returns noop for pipeline_state=completed AND dispatched===0', () => {
    expect(
      deriveTrueOutcome({
        pipeline_state: 'completed',
        dispatch_summary: { dispatched: 0, failed: 0 },
      }),
    ).toBe('noop');
  });

  it('returns unknown for missing data and unrecognized states', () => {
    expect(deriveTrueOutcome({})).toBe('unknown');
    expect(deriveTrueOutcome({ plan_state: 'totally-invented' })).toBe('unknown');
    expect(deriveTrueOutcome({ plan_state: '' })).toBe('unknown');
  });

  it('prefers plan_state over pipeline_state on the rare ambiguous input', () => {
    /*
     * Plan and pipeline never both apply to the same atom in normal
     * operation; the precedence is documented so a consumer that
     * passes both gets a deterministic answer.
     */
    expect(
      deriveTrueOutcome({
        plan_state: 'failed',
        pipeline_state: 'completed',
        dispatch_summary: { dispatched: 1, failed: 0 },
      }),
    ).toBe('failed');
  });

  it('null and undefined inputs do not throw', () => {
    expect(deriveTrueOutcome({ plan_state: null })).toBe('unknown');
    expect(deriveTrueOutcome({ pipeline_state: undefined })).toBe('unknown');
    expect(deriveTrueOutcome({ dispatch_summary: null })).toBe('unknown');
  });
});

describe('trueOutcomeTone', () => {
  it('paints succeeded green', () => {
    expect(trueOutcomeTone('succeeded')).toBe('var(--status-success)');
  });

  it('paints noop amber, distinct from succeeded green', () => {
    expect(trueOutcomeTone('noop')).toBe('var(--status-warning)');
    expect(trueOutcomeTone('noop')).not.toBe(trueOutcomeTone('succeeded'));
  });

  it('paints failed danger-red', () => {
    expect(trueOutcomeTone('failed')).toBe('var(--status-danger)');
  });

  it('paints in-progress info-blue', () => {
    expect(trueOutcomeTone('in-progress')).toBe('var(--status-info)');
  });

  it('paints unknown neutral so a future state does not silently mis-paint', () => {
    expect(trueOutcomeTone('unknown')).toBe('var(--text-secondary)');
  });
});

describe('readPlanDispatchSummary', () => {
  it('returns dispatched=0 for plan with dispatch_result.summary mentioning silent-skip', () => {
    /*
     * Real-world bug shape: plan_state='succeeded' but
     * dispatch_result.summary='code-author silent-skip on plan ...:
     * drafter-emitted-empty-diff'. The summary marker is the only
     * signal the chain produced no PR.
     */
    const meta = {
      dispatch_result: {
        kind: 'completed',
        summary:
          'code-author silent-skip on plan plan-x: drafter-emitted-empty-diff',
      },
    };
    expect(readPlanDispatchSummary(meta)).toEqual({
      dispatched: 0,
      failed: 0,
    });
  });

  it('returns dispatched=1 for completed dispatch without noop markers', () => {
    const meta = {
      dispatch_result: {
        kind: 'completed',
        summary: 'PR #555 opened',
      },
    };
    expect(readPlanDispatchSummary(meta)).toEqual({
      dispatched: 1,
      failed: 0,
    });
  });

  it('returns failed=1 on dispatch_result.kind=error', () => {
    const meta = {
      dispatch_result: {
        kind: 'error',
        message: 'dispatcher halted before PR open',
      },
    };
    expect(readPlanDispatchSummary(meta)).toEqual({
      dispatched: 0,
      failed: 1,
    });
  });

  it('returns null when no dispatch_result is present', () => {
    expect(readPlanDispatchSummary({})).toBeNull();
    expect(readPlanDispatchSummary(null)).toBeNull();
    expect(readPlanDispatchSummary(undefined)).toBeNull();
    expect(readPlanDispatchSummary('not-an-object')).toBeNull();
  });

  it('returns null on a malformed dispatch_result kind', () => {
    expect(readPlanDispatchSummary({ dispatch_result: { kind: 'wat' } })).toBeNull();
  });

  it('end-to-end: silent-skip plan flows through to noop', () => {
    /*
     * Integration check that ties the helper to the derive function:
     * a plan_state=succeeded atom carrying the bug-case dispatch_result
     * resolves to noop when the two are composed at the call site.
     */
    const meta = {
      dispatch_result: {
        kind: 'completed',
        summary: 'code-author silent-skip on plan: drafter-emitted-empty-diff',
      },
    };
    const summary = readPlanDispatchSummary(meta);
    expect(
      deriveTrueOutcome({
        plan_state: 'succeeded',
        dispatch_summary: summary,
      }),
    ).toBe('noop');
  });
});
