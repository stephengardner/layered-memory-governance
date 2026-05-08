import { describe, it, expect } from 'vitest';
import { buildIntentOutcome, buildSummary } from './intent-outcome';
import type { IntentOutcomeSourceAtom } from './intent-outcome-types';

/*
 * Unit tests for the intent-outcome synthesizer.
 *
 * Pure-helper tests: feed atoms, assert the wire shape. No I/O,
 * no time, no globals. Mirrors the test pattern in pipelines.test.ts +
 * pipeline-lifecycle.test.ts.
 *
 * Coverage focus: the TRUE-outcome semantics rungs in the state
 * derivation ladder. Each scenario builds the minimum atom set that
 * forces the rung to fire, and asserts both the state pill and the
 * summary line shape.
 */

const NOW = Date.parse('2026-05-08T15:00:00.000Z');

function atom(
  partial: Partial<IntentOutcomeSourceAtom> & {
    id: string;
    type: string;
    created_at: string;
  },
): IntentOutcomeSourceAtom {
  return {
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    taint: 'clean',
    ...partial,
  };
}

function intentAtom(opts: {
  id: string;
  created_at: string;
  expires_at?: string | null;
  content?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: opts.id,
    type: 'operator-intent',
    created_at: opts.created_at,
    content: opts.content ?? 'Add a TODO badge to the plans header',
    principal_id: 'apex-agent',
    expires_at: opts.expires_at ?? null,
    metadata: {
      trust_envelope: {
        min_plan_confidence: 0.75,
        max_blast_radius: 'tooling',
        allowed_sub_actors: ['code-author'],
      },
    },
  });
}

function pipelineAtom(opts: {
  id: string;
  intent_id: string;
  created_at: string;
  pipeline_state?: string;
  mode?: string;
  current_stage?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: opts.id,
    type: 'pipeline',
    created_at: opts.created_at,
    content: `pipeline:${opts.id}`,
    pipeline_state: opts.pipeline_state ?? 'completed',
    provenance: {
      kind: 'agent-observed',
      derived_from: [opts.intent_id],
      source: { tool: 'planning-pipeline', agent_id: 'cto-actor' },
    },
    metadata: {
      mode: opts.mode ?? 'substrate-deep',
      stage_policy_atom_id: 'pol-planning-pipeline-stages-default',
      ...(opts.current_stage ? { current_stage: opts.current_stage } : {}),
    },
  });
}

function stageEvent(opts: {
  pipelineId: string;
  stage: string;
  transition: string;
  created_at: string;
  duration_ms?: number;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `pipeline-stage-event-${opts.pipelineId}-${opts.stage}-${opts.transition}-${opts.created_at}`,
    type: 'pipeline-stage-event',
    created_at: opts.created_at,
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stage,
      transition: opts.transition,
      duration_ms: opts.duration_ms ?? 60_000,
      cost_usd: 0,
    },
  });
}

function dispatchRecord(opts: {
  pipelineId: string;
  dispatched: number;
  scanned?: number;
  failed?: number;
  created_at: string;
  error_message?: string;
  status?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `dispatch-record-${opts.pipelineId}`,
    type: 'dispatch-record',
    created_at: opts.created_at,
    content: '{}',
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: 'dispatch-stage',
      stage_output: {
        dispatch_status: opts.status ?? 'completed',
        scanned: opts.scanned ?? 1,
        dispatched: opts.dispatched,
        failed: opts.failed ?? 0,
        cost_usd: 0,
      },
    },
  });
}

function planAtom(opts: {
  id: string;
  pipelineId: string;
  created_at: string;
  errorMessage?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: opts.id,
    type: 'plan',
    created_at: opts.created_at,
    metadata: {
      pipeline_id: opts.pipelineId,
      ...(opts.errorMessage
        ? { dispatch_result: { kind: 'error', message: opts.errorMessage } }
        : {}),
    },
  });
}

function codeAuthorInvoked(opts: {
  planId: string;
  kind: 'dispatched' | 'error' | 'noop';
  prNumber?: number;
  prUrl?: string;
  reason?: string;
  created_at: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `obs-code-author-${opts.planId}-${opts.created_at}`,
    type: 'observation',
    created_at: opts.created_at,
    metadata: {
      kind: 'code-author-invoked',
      plan_id: opts.planId,
      executor_result: {
        kind: opts.kind,
        ...(opts.prNumber ? { pr_number: opts.prNumber } : {}),
        ...(opts.prUrl ? { pr_html_url: opts.prUrl } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    },
  });
}

function prObservation(opts: {
  planId: string;
  prNumber: number;
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  created_at: string;
  headSha?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `obs-pr-${opts.planId}-${opts.created_at}`,
    type: 'observation',
    created_at: opts.created_at,
    content: 'check-runs: 0\nlegacy statuses: 0',
    metadata: {
      kind: 'pr-observation',
      plan_id: opts.planId,
      pr_state: opts.prState,
      pr_title: 'feat: example PR title',
      head_sha: opts.headSha ?? 'abc123def456',
      mergeable: true,
      merge_state_status: opts.prState === 'MERGED' ? 'CLEAN' : 'BLOCKED',
      observed_at: opts.created_at,
      counts: {
        submitted_reviews: opts.prState === 'MERGED' ? 1 : 0,
        line_comments: 0,
        body_nits: 0,
        legacy_statuses: 0,
        check_runs: 0,
      },
      pr: { owner: 'stephengardner', repo: 'layered-autonomous-governance', number: opts.prNumber },
    },
  });
}

function mergeSettled(opts: {
  planId: string;
  prNumber: number;
  created_at: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `plan-merge-settled-${opts.planId}`,
    type: 'plan-merge-settled',
    created_at: opts.created_at,
    principal_id: 'pr-landing-agent',
    content: `plan ${opts.planId} -> succeeded via PR merge`,
    metadata: {
      plan_id: opts.planId,
      pr_state: 'MERGED',
      target_plan_state: 'succeeded',
      settled_at: opts.created_at,
      merge_commit_sha: 'merge-sha-789',
      pr: {
        owner: 'stephengardner',
        repo: 'layered-autonomous-governance',
        number: opts.prNumber,
      },
    },
  });
}

describe('buildIntentOutcome: empty', () => {
  it('returns intent-unknown when no atoms reference the pipeline', () => {
    const result = buildIntentOutcome([], 'pipeline-missing', NOW);
    expect(result.state).toBe('intent-unknown');
    expect(result.pipeline_atom_id).toBeNull();
    expect(result.operator_intent_atom_id).toBeNull();
    expect(result.dispatched_count).toBe(0);
    expect(result.summary).toMatch(/no pipeline state/i);
    expect(result.skip_reasons).toEqual([]);
  });
});

describe('buildIntentOutcome: intent-fulfilled', () => {
  it('returns intent-fulfilled when a plan-merge-settled atom is in the chain', () => {
    /*
     * TRUE-outcome semantics: a real merged PR drives intent-fulfilled.
     * The synthesizer reads either plan-merge-settled or a pr-observation
     * with pr_state=MERGED; both qualify, with the settled atom carrying
     * a richer audit trail.
     */
    const intent = intentAtom({
      id: 'operator-intent-fulfilled-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-fulfilled-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
    });
    const stages = [
      'brainstorm-stage', 'spec-stage', 'plan-stage', 'review-stage', 'dispatch-stage',
    ].flatMap((stage, i) => {
      const enterAt = `2026-05-08T14:0${1 + i}:00.000Z`;
      const exitAt = `2026-05-08T14:0${1 + i}:30.000Z`;
      return [
        stageEvent({ pipelineId: pipeline.id, stage, transition: 'enter', created_at: enterAt }),
        stageEvent({
          pipelineId: pipeline.id,
          stage,
          transition: 'exit-success',
          created_at: exitAt,
          duration_ms: 30_000,
        }),
      ];
    });
    const plan = planAtom({
      id: 'plan-fulfilled-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-08T14:04:30.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-08T14:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      kind: 'dispatched',
      prNumber: 999,
      prUrl: 'https://github.com/x/y/pull/999',
      created_at: '2026-05-08T14:06:00.000Z',
    });
    const observation = prObservation({
      planId: plan.id,
      prNumber: 999,
      prState: 'MERGED',
      created_at: '2026-05-08T14:52:00.000Z',
    });
    const merge = mergeSettled({
      planId: plan.id,
      prNumber: 999,
      created_at: '2026-05-08T14:52:00.000Z',
    });
    const result = buildIntentOutcome(
      [intent, pipeline, ...stages, plan, dispatch, ca, observation, merge],
      pipeline.id,
      NOW,
    );
    expect(result.state).toBe('intent-fulfilled');
    expect(result.pr_number).toBe(999);
    expect(result.pr_url).toBe('https://github.com/x/y/pull/999');
    expect(result.merge_commit_sha).toBe('merge-sha-789');
    expect(result.pr_merged_at).toBe('2026-05-08T14:52:00.000Z');
    expect(result.dispatched_count).toBe(1);
    expect(result.stage_count).toBe(5);
    expect(result.stage_completed_count).toBe(5);
    expect(result.summary).toMatch(/PR #999 merged at 14:52Z/);
    expect(result.summary).toMatch(/5 stages/);
    expect(result.summary).toMatch(/dispatched 1 PR/);
    expect(result.operator_intent_atom_id).toBe(intent.id);
  });
});

describe('buildIntentOutcome: intent-dispatch-failed', () => {
  it('returns intent-dispatch-failed when dispatched=0 with envelope mismatch reason', () => {
    const intent = intentAtom({
      id: 'operator-intent-failed-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-failed-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const plan = planAtom({
      id: 'plan-failed-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-08T14:04:00.000Z',
      errorMessage: 'envelope mismatch: blast_radius framework > intent.tooling',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 0,
      scanned: 1,
      created_at: '2026-05-08T14:05:00.000Z',
    });
    const result = buildIntentOutcome([intent, pipeline, plan, dispatch], pipeline.id, NOW);
    expect(result.state).toBe('intent-dispatch-failed');
    expect(result.dispatched_count).toBe(0);
    expect(result.skip_reasons).toHaveLength(1);
    expect(result.skip_reasons[0]?.reason).toMatch(/envelope mismatch/);
    expect(result.skip_reasons[0]?.source).toBe('dispatch-record');
    expect(result.summary).toMatch(/dispatched 0 PRs/);
    expect(result.summary).toMatch(/envelope mismatch/);
  });

  it('returns intent-dispatch-failed when code-author kind=noop', () => {
    /*
     * The drafter ran but produced no diff (existence-gate fired,
     * plan body forecloses creation, etc). TRUE-outcome semantics:
     * no merged PR == no fulfilled intent.
     */
    const intent = intentAtom({
      id: 'operator-intent-noop',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-noop-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const plan = planAtom({
      id: 'plan-noop-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-08T14:04:00.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-08T14:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      kind: 'noop',
      reason: 'existence-gate fired; plan forecloses creation',
      created_at: '2026-05-08T14:06:00.000Z',
    });
    const result = buildIntentOutcome([intent, pipeline, plan, dispatch, ca], pipeline.id, NOW);
    expect(result.state).toBe('intent-dispatch-failed');
    expect(result.skip_reasons[0]?.source).toBe('code-author');
    expect(result.skip_reasons[0]?.reason).toMatch(/existence-gate/);
  });

  it('returns intent-dispatch-failed when PR was opened but later closed unmerged', () => {
    const intent = intentAtom({
      id: 'operator-intent-closed-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-closed-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
    });
    const plan = planAtom({
      id: 'plan-closed-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-08T14:04:00.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-08T14:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      kind: 'dispatched',
      prNumber: 555,
      created_at: '2026-05-08T14:06:00.000Z',
    });
    const observation = prObservation({
      planId: plan.id,
      prNumber: 555,
      prState: 'CLOSED',
      created_at: '2026-05-08T14:30:00.000Z',
    });
    const result = buildIntentOutcome(
      [intent, pipeline, plan, dispatch, ca, observation],
      pipeline.id,
      NOW,
    );
    expect(result.state).toBe('intent-dispatch-failed');
  });
});

describe('buildIntentOutcome: intent-dispatched-pending-review', () => {
  it('returns intent-dispatched-pending-review when PR is open awaiting review', () => {
    const intent = intentAtom({
      id: 'operator-intent-pending-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-pending-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const plan = planAtom({
      id: 'plan-pending-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-08T14:04:00.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-08T14:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      kind: 'dispatched',
      prNumber: 411,
      prUrl: 'https://github.com/x/y/pull/411',
      created_at: '2026-05-08T14:06:00.000Z',
    });
    const observation = prObservation({
      planId: plan.id,
      prNumber: 411,
      prState: 'OPEN',
      created_at: '2026-05-08T14:30:00.000Z',
    });
    const result = buildIntentOutcome(
      [intent, pipeline, plan, dispatch, ca, observation],
      pipeline.id,
      NOW,
    );
    expect(result.state).toBe('intent-dispatched-pending-review');
    expect(result.pr_number).toBe(411);
    expect(result.pr_url).toBe('https://github.com/x/y/pull/411');
    expect(result.summary).toMatch(/PR #411 open, awaiting review/);
  });
});

describe('buildIntentOutcome: intent-paused', () => {
  it('returns intent-paused when pipeline_state=hil-paused', () => {
    const intent = intentAtom({
      id: 'operator-intent-paused-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-paused-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'hil-paused',
      current_stage: 'plan-stage',
    });
    const event = stageEvent({
      pipelineId: pipeline.id,
      stage: 'plan-stage',
      transition: 'hil-pause',
      created_at: '2026-05-08T14:02:00.000Z',
    });
    const result = buildIntentOutcome([intent, pipeline, event], pipeline.id, NOW);
    expect(result.state).toBe('intent-paused');
    expect(result.summary).toMatch(/paused for HIL at plan-stage/);
  });

  it('detects pause via stage-event backstop when pipeline_state lags', () => {
    /*
     * Older atoms may not propagate the pipeline_state field even when
     * a hil-pause event has fired. The backstop reads stage events
     * directly so the synthesizer doesn't miss a paused pipeline.
     */
    const intent = intentAtom({
      id: 'operator-intent-paused-2',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-paused-2',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'running',
    });
    const event = stageEvent({
      pipelineId: pipeline.id,
      stage: 'spec-stage',
      transition: 'hil-pause',
      created_at: '2026-05-08T14:02:00.000Z',
    });
    const result = buildIntentOutcome([intent, pipeline, event], pipeline.id, NOW);
    expect(result.state).toBe('intent-paused');
  });
});

describe('buildIntentOutcome: intent-running', () => {
  it('returns intent-running when pipeline is mid-execution', () => {
    const intent = intentAtom({
      id: 'operator-intent-running-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-running-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'running',
      current_stage: 'plan-stage',
    });
    const enter = stageEvent({
      pipelineId: pipeline.id,
      stage: 'brainstorm-stage',
      transition: 'enter',
      created_at: '2026-05-08T14:01:30.000Z',
    });
    const exitOk = stageEvent({
      pipelineId: pipeline.id,
      stage: 'brainstorm-stage',
      transition: 'exit-success',
      created_at: '2026-05-08T14:02:30.000Z',
      duration_ms: 60_000,
    });
    const planEnter = stageEvent({
      pipelineId: pipeline.id,
      stage: 'plan-stage',
      transition: 'enter',
      created_at: '2026-05-08T14:03:00.000Z',
    });
    const result = buildIntentOutcome(
      [intent, pipeline, enter, exitOk, planEnter],
      pipeline.id,
      NOW,
    );
    expect(result.state).toBe('intent-running');
    expect(result.summary).toMatch(/mid-execution at plan-stage/);
    expect(result.stage_count).toBe(2);
    expect(result.stage_completed_count).toBe(1);
  });
});

describe('buildIntentOutcome: intent-abandoned', () => {
  it('returns intent-abandoned when operator-intent expires_at is in the past with no merge', () => {
    /*
     * Intent expired before producing a merged PR. The synthesizer
     * treats the authorization window closing as terminal regardless
     * of any downstream activity.
     */
    const intent = intentAtom({
      id: 'operator-intent-expired-1',
      created_at: '2026-05-08T10:00:00.000Z',
      expires_at: '2026-05-08T11:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-expired-1',
      intent_id: intent.id,
      created_at: '2026-05-08T10:01:00.000Z',
      pipeline_state: 'failed',
    });
    const result = buildIntentOutcome([intent, pipeline], pipeline.id, NOW);
    expect(result.state).toBe('intent-abandoned');
  });

  it('does NOT abandon when expires_at is in the past but PR is already merged', () => {
    /*
     * A merged PR landed before expiry: the intent was fulfilled.
     * Expiration after fulfillment is irrelevant to the outcome.
     */
    const intent = intentAtom({
      id: 'operator-intent-expired-merged-1',
      created_at: '2026-05-08T10:00:00.000Z',
      expires_at: '2026-05-08T11:00:00.000Z',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-expired-merged-1',
      intent_id: intent.id,
      created_at: '2026-05-08T10:01:00.000Z',
    });
    const plan = planAtom({
      id: 'plan-expired-merged-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-08T10:30:00.000Z',
    });
    const merge = mergeSettled({
      planId: plan.id,
      prNumber: 7,
      created_at: '2026-05-08T10:45:00.000Z',
    });
    const result = buildIntentOutcome(
      [intent, pipeline, plan, merge],
      pipeline.id,
      NOW,
    );
    expect(result.state).toBe('intent-fulfilled');
  });
});

describe('buildIntentOutcome: title resolution', () => {
  it('resolves title from operator-intent content when pipeline metadata title is absent', () => {
    const intent = intentAtom({
      id: 'operator-intent-titled-1',
      created_at: '2026-05-08T14:00:00.000Z',
      content: 'Add a TODO badge to plans header for stalled plans',
    });
    const pipeline = pipelineAtom({
      id: 'pipeline-titled-1',
      intent_id: intent.id,
      created_at: '2026-05-08T14:01:00.000Z',
      pipeline_state: 'running',
    });
    const result = buildIntentOutcome([intent, pipeline], pipeline.id, NOW);
    expect(result.title).toMatch(/^Add a TODO badge/);
  });
});

describe('buildIntentOutcome: tainted/superseded atoms are filtered out', () => {
  it('ignores tainted operator-intent atoms in the lookup', () => {
    const baseIntent = intentAtom({
      id: 'operator-intent-tainted-1',
      created_at: '2026-05-08T14:00:00.000Z',
    });
    // Build a tainted variant via spread because the source-atom shape
    // is `readonly`; mutating in-place would fail tsc.
    const tainted: IntentOutcomeSourceAtom = { ...baseIntent, taint: 'tainted' };
    const pipeline = pipelineAtom({
      id: 'pipeline-tainted-1',
      intent_id: tainted.id,
      created_at: '2026-05-08T14:01:00.000Z',
    });
    const result = buildIntentOutcome([tainted, pipeline], pipeline.id, NOW);
    expect(result.operator_intent_atom_id).toBeNull();
    expect(result.time_elapsed_ms).toBe(0);
  });
});

describe('buildSummary: pure helper', () => {
  it('builds a fulfilled-state summary that includes PR number and merge time', () => {
    const summary = buildSummary({
      state: 'intent-fulfilled',
      dispatchedCount: 1,
      stages: 5,
      durationMs: 8 * 60 * 1000,
      mergeAt: '2026-05-08T14:52:00.000Z',
      prNumber: 245,
      skipReason: null,
      pausedStage: null,
      runningStage: null,
      pausedFromPipeline: null,
    });
    expect(summary).toMatch(/Pipeline ran 8m/);
    expect(summary).toMatch(/5 stages/);
    expect(summary).toMatch(/dispatched 1 PR/);
    expect(summary).toMatch(/PR #245 merged at 14:52Z/);
  });

  it('builds a dispatch-failed summary that surfaces the skip reason', () => {
    const summary = buildSummary({
      state: 'intent-dispatch-failed',
      dispatchedCount: 0,
      stages: 5,
      durationMs: 60_000,
      mergeAt: null,
      prNumber: null,
      skipReason: 'envelope mismatch',
      pausedStage: null,
      runningStage: null,
      pausedFromPipeline: null,
    });
    expect(summary).toMatch(/envelope mismatch/);
    expect(summary).toMatch(/dispatched 0 PRs/);
  });
});
