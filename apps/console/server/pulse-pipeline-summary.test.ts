import { describe, it, expect } from 'vitest';
import { buildPulsePipelineSummary, MAX_PULSE_SAMPLE } from './pulse-pipeline-summary';
import type { IntentOutcomeSourceAtom } from './intent-outcome-types';

/*
 * Unit tests for the pulse pipeline-summary aggregator.
 *
 * Pure-helper tests: feed atoms, assert the wire shape. No I/O, no
 * time, no globals. Mirrors the test pattern in intent-outcome.test.ts
 * and pipelines.test.ts.
 *
 * Coverage focus: the three-bucket classification across the canonical
 * pipeline lifecycle states (pending/running/completed-with-PR/merged/
 * failed). Each scenario builds the minimum atom set that forces the
 * bucket to fire, and asserts both the count and the sample row shape.
 */

const NOW = Date.parse('2026-05-10T15:00:00.000Z');

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
  content?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: opts.id,
    type: 'operator-intent',
    created_at: opts.created_at,
    content: opts.content ?? 'Sample operator-intent body',
    principal_id: 'apex-agent',
    expires_at: null,
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
  title?: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: opts.id,
    type: 'pipeline',
    created_at: opts.created_at,
    content: `pipeline:${opts.id}`,
    pipeline_state: opts.pipeline_state ?? 'pending',
    provenance: {
      kind: 'agent-observed',
      derived_from: [opts.intent_id],
      source: { tool: 'planning-pipeline', agent_id: 'cto-actor' },
    },
    metadata: {
      mode: 'substrate-deep',
      stage_policy_atom_id: 'pol-planning-pipeline-stages-default',
      ...(opts.title ? { title: opts.title } : {}),
    },
  });
}

function stageEvent(opts: {
  pipelineId: string;
  stage: string;
  transition: string;
  created_at: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `pipeline-stage-event-${opts.pipelineId}-${opts.stage}-${opts.transition}-${opts.created_at}`,
    type: 'pipeline-stage-event',
    created_at: opts.created_at,
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stage,
      transition: opts.transition,
      duration_ms: 30_000,
      cost_usd: 0,
    },
  });
}

function planAtom(opts: {
  id: string;
  pipelineId: string;
  created_at: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: opts.id,
    type: 'plan',
    created_at: opts.created_at,
    metadata: { pipeline_id: opts.pipelineId },
  });
}

function dispatchRecord(opts: {
  pipelineId: string;
  dispatched: number;
  created_at: string;
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
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: opts.dispatched,
        failed: 0,
        cost_usd: 0,
      },
    },
  });
}

function codeAuthorInvoked(opts: {
  planId: string;
  prNumber: number;
  prUrl?: string;
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
        kind: 'dispatched',
        pr_number: opts.prNumber,
        pr_html_url: opts.prUrl ?? `https://github.com/x/y/pull/${opts.prNumber}`,
      },
    },
  });
}

function prObservation(opts: {
  planId: string;
  prNumber: number;
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  created_at: string;
}): IntentOutcomeSourceAtom {
  return atom({
    id: `obs-pr-${opts.planId}-${opts.created_at}`,
    type: 'observation',
    created_at: opts.created_at,
    metadata: {
      kind: 'pr-observation',
      plan_id: opts.planId,
      pr_state: opts.prState,
      pr_title: 'feat: example',
      head_sha: 'abc123def',
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
      pr: { owner: 'x', repo: 'y', number: opts.prNumber },
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
      merge_commit_sha: 'merge-sha',
      pr: { owner: 'x', repo: 'y', number: opts.prNumber },
    },
  });
}

describe('buildPulsePipelineSummary: empty store', () => {
  it('returns zero counts and empty samples on an empty atom store', () => {
    const result = buildPulsePipelineSummary([], NOW);
    expect(result.running).toBe(0);
    expect(result.dispatched_pending_merge).toBe(0);
    expect(result.intent_fulfilled).toBe(0);
    expect(result.total).toBe(0);
    expect(result.samples.running).toEqual([]);
    expect(result.samples.dispatched_pending_merge).toEqual([]);
    expect(result.samples.intent_fulfilled).toEqual([]);
    expect(result.computed_at).toBe(new Date(NOW).toISOString());
  });

  it('ignores non-pipeline atoms (operator-intents, plans, observations alone)', () => {
    /*
     * A bare intent + plan + observation chain with no pipeline atom on
     * disk is the legacy single-pass shape; the Pulse tile counts ONLY
     * pipeline atoms because the operator's question is about pipelines.
     * Plans-without-pipeline surface in the existing plans-in-flight tile.
     */
    const intent = intentAtom({ id: 'op-1', created_at: '2026-05-10T14:00:00.000Z' });
    const plan = planAtom({
      id: 'plan-1',
      pipelineId: 'nope',
      created_at: '2026-05-10T14:01:00.000Z',
    });
    const result = buildPulsePipelineSummary([intent, plan], NOW);
    expect(result.total).toBe(0);
    expect(result.running).toBe(0);
  });
});

describe('buildPulsePipelineSummary: running bucket', () => {
  it('classifies pipeline_state=running as running', () => {
    const intent = intentAtom({ id: 'op-r1', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-running-1',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'running',
    });
    const result = buildPulsePipelineSummary([intent, pipeline], NOW);
    expect(result.running).toBe(1);
    expect(result.dispatched_pending_merge).toBe(0);
    expect(result.intent_fulfilled).toBe(0);
    expect(result.samples.running).toHaveLength(1);
    expect(result.samples.running[0]?.pipeline_id).toBe('pipeline-running-1');
  });

  it('classifies pipeline_state=pending as running (still in flight)', () => {
    const intent = intentAtom({ id: 'op-p1', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-pending-1',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'pending',
    });
    const result = buildPulsePipelineSummary([intent, pipeline], NOW);
    expect(result.running).toBe(1);
  });

  it('does NOT count completed pipelines as running', () => {
    const intent = intentAtom({ id: 'op-c1', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-completed-1',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const result = buildPulsePipelineSummary([intent, pipeline], NOW);
    expect(result.running).toBe(0);
    expect(result.total).toBe(1);
  });
});

describe('buildPulsePipelineSummary: dispatched_pending_merge bucket', () => {
  it('classifies a pipeline with an OPEN PR awaiting merge as dispatched-pending-merge', () => {
    const intent = intentAtom({ id: 'op-d1', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-pending-merge-1',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const plan = planAtom({
      id: 'plan-pm-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-10T14:04:00.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-10T14:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      prNumber: 700,
      created_at: '2026-05-10T14:06:00.000Z',
    });
    const obs = prObservation({
      planId: plan.id,
      prNumber: 700,
      prState: 'OPEN',
      created_at: '2026-05-10T14:30:00.000Z',
    });
    const result = buildPulsePipelineSummary([intent, pipeline, plan, dispatch, ca, obs], NOW);
    expect(result.dispatched_pending_merge).toBe(1);
    expect(result.running).toBe(0);
    expect(result.intent_fulfilled).toBe(0);
    expect(result.samples.dispatched_pending_merge[0]?.pipeline_id).toBe('pipeline-pending-merge-1');
  });
});

describe('buildPulsePipelineSummary: intent_fulfilled bucket', () => {
  it('classifies a pipeline with a merged PR as intent-fulfilled', () => {
    const intent = intentAtom({ id: 'op-f1', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-fulfilled-1',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const plan = planAtom({
      id: 'plan-f-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-10T14:04:00.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-10T14:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      prNumber: 800,
      created_at: '2026-05-10T14:06:00.000Z',
    });
    const obs = prObservation({
      planId: plan.id,
      prNumber: 800,
      prState: 'MERGED',
      created_at: '2026-05-10T14:52:00.000Z',
    });
    const merge = mergeSettled({
      planId: plan.id,
      prNumber: 800,
      created_at: '2026-05-10T14:52:00.000Z',
    });
    const result = buildPulsePipelineSummary(
      [intent, pipeline, plan, dispatch, ca, obs, merge],
      NOW,
    );
    expect(result.intent_fulfilled).toBe(1);
    expect(result.running).toBe(0);
    expect(result.dispatched_pending_merge).toBe(0);
    expect(result.samples.intent_fulfilled[0]?.pipeline_id).toBe('pipeline-fulfilled-1');
  });
});

describe('buildPulsePipelineSummary: mixed store', () => {
  it('counts every bucket simultaneously across a mixed pipeline set', () => {
    const intent1 = intentAtom({ id: 'op-mix-r', created_at: '2026-05-10T14:00:00.000Z' });
    const intent2 = intentAtom({ id: 'op-mix-pm', created_at: '2026-05-10T14:00:00.000Z' });
    const intent3 = intentAtom({ id: 'op-mix-f', created_at: '2026-05-10T14:00:00.000Z' });

    const running = pipelineAtom({
      id: 'pipeline-mix-running',
      intent_id: intent1.id,
      created_at: '2026-05-10T14:10:00.000Z',
      pipeline_state: 'running',
    });

    const pendingMerge = pipelineAtom({
      id: 'pipeline-mix-pending-merge',
      intent_id: intent2.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const planPM = planAtom({
      id: 'plan-mix-pm',
      pipelineId: pendingMerge.id,
      created_at: '2026-05-10T14:04:00.000Z',
    });
    const dispatchPM = dispatchRecord({
      pipelineId: pendingMerge.id,
      dispatched: 1,
      created_at: '2026-05-10T14:05:00.000Z',
    });
    const caPM = codeAuthorInvoked({
      planId: planPM.id,
      prNumber: 700,
      created_at: '2026-05-10T14:06:00.000Z',
    });
    const obsPM = prObservation({
      planId: planPM.id,
      prNumber: 700,
      prState: 'OPEN',
      created_at: '2026-05-10T14:30:00.000Z',
    });

    const fulfilled = pipelineAtom({
      id: 'pipeline-mix-fulfilled',
      intent_id: intent3.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'completed',
    });
    const planF = planAtom({
      id: 'plan-mix-f',
      pipelineId: fulfilled.id,
      created_at: '2026-05-10T14:04:00.000Z',
    });
    const dispatchF = dispatchRecord({
      pipelineId: fulfilled.id,
      dispatched: 1,
      created_at: '2026-05-10T14:05:00.000Z',
    });
    const caF = codeAuthorInvoked({
      planId: planF.id,
      prNumber: 800,
      created_at: '2026-05-10T14:06:00.000Z',
    });
    const obsF = prObservation({
      planId: planF.id,
      prNumber: 800,
      prState: 'MERGED',
      created_at: '2026-05-10T14:52:00.000Z',
    });
    const mergeF = mergeSettled({
      planId: planF.id,
      prNumber: 800,
      created_at: '2026-05-10T14:52:00.000Z',
    });

    const result = buildPulsePipelineSummary(
      [
        intent1, intent2, intent3,
        running,
        pendingMerge, planPM, dispatchPM, caPM, obsPM,
        fulfilled, planF, dispatchF, caF, obsF, mergeF,
      ],
      NOW,
    );
    expect(result.running).toBe(1);
    expect(result.dispatched_pending_merge).toBe(1);
    expect(result.intent_fulfilled).toBe(1);
    expect(result.total).toBe(3);
  });
});

describe('buildPulsePipelineSummary: clean/live filter', () => {
  it('excludes superseded pipelines from the count', () => {
    const intent = intentAtom({ id: 'op-sup', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-superseded',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'running',
    });
    const superseded: IntentOutcomeSourceAtom = {
      ...pipeline,
      superseded_by: ['pipeline-newer'],
    };
    const result = buildPulsePipelineSummary([intent, superseded], NOW);
    expect(result.total).toBe(0);
    expect(result.running).toBe(0);
  });

  it('excludes tainted pipelines (taint != clean) from the count', () => {
    const intent = intentAtom({ id: 'op-tainted', created_at: '2026-05-10T14:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-tainted',
      intent_id: intent.id,
      created_at: '2026-05-10T14:01:00.000Z',
      pipeline_state: 'running',
    });
    const tainted: IntentOutcomeSourceAtom = { ...pipeline, taint: 'quarantined' };
    const result = buildPulsePipelineSummary([intent, tainted], NOW);
    expect(result.total).toBe(0);
  });
});

describe('buildPulsePipelineSummary: sample ordering', () => {
  it('orders sample rows by last_event_at desc and caps at MAX_PULSE_SAMPLE', () => {
    /*
     * Build MAX_PULSE_SAMPLE + 2 running pipelines with strictly
     * decreasing event timestamps. The sample list must surface the
     * MOST recent set, sorted newest-first.
     */
    const atoms: IntentOutcomeSourceAtom[] = [];
    for (let i = 0; i < MAX_PULSE_SAMPLE + 2; i += 1) {
      const id = `op-order-${i}`;
      const pipelineId = `pipeline-order-${i}`;
      const minutes = String(10 + i).padStart(2, '0');
      const createdAt = `2026-05-10T14:${minutes}:00.000Z`;
      atoms.push(intentAtom({ id, created_at: createdAt }));
      atoms.push(pipelineAtom({
        id: pipelineId,
        intent_id: id,
        created_at: createdAt,
        pipeline_state: 'running',
      }));
      // Stage event keyed to the same pipeline so the synthesizer has a
      // last_event_at to read.
      atoms.push(stageEvent({
        pipelineId,
        stage: 'brainstorm-stage',
        transition: 'enter',
        created_at: createdAt,
      }));
    }
    const result = buildPulsePipelineSummary(atoms, NOW);
    expect(result.running).toBe(MAX_PULSE_SAMPLE + 2);
    expect(result.samples.running).toHaveLength(MAX_PULSE_SAMPLE);
    // Newest is the one with the highest minute index, MAX_PULSE_SAMPLE + 1.
    const newestExpected = `pipeline-order-${MAX_PULSE_SAMPLE + 1}`;
    expect(result.samples.running[0]?.pipeline_id).toBe(newestExpected);
  });
});

/*
 * Substrate gap (2026-05-11): the staleness window prevents stale
 * pr-observation atoms from inflating the awaiting-merge headline.
 * These tests pin the new `dispatched_observation_stale` bucket.
 */
describe('buildPulsePipelineSummary: dispatched_observation_stale bucket', () => {
  function makeBucketScenario(observedAt: string) {
    const intent = intentAtom({ id: 'op-stale-bucket-1', created_at: '2026-05-01T00:00:00.000Z' });
    const pipeline = pipelineAtom({
      id: 'pipeline-stale-bucket-1',
      intent_id: intent.id,
      created_at: '2026-05-01T00:01:00.000Z',
      pipeline_state: 'completed',
    });
    const plan = planAtom({
      id: 'plan-stale-bucket-1',
      pipelineId: pipeline.id,
      created_at: '2026-05-01T00:04:00.000Z',
    });
    const dispatch = dispatchRecord({
      pipelineId: pipeline.id,
      dispatched: 1,
      created_at: '2026-05-01T00:05:00.000Z',
    });
    const ca = codeAuthorInvoked({
      planId: plan.id,
      prNumber: 999,
      created_at: '2026-05-01T00:06:00.000Z',
    });
    const obs = prObservation({
      planId: plan.id,
      prNumber: 999,
      prState: 'OPEN',
      created_at: observedAt,
    });
    return [intent, pipeline, plan, dispatch, ca, obs];
  }

  it('classifies a pipeline with an OPEN observation older than the staleness window as stale', () => {
    // Observation at 2026-04-26 is 14+ days before NOW (2026-05-10),
    // well past the 1h default staleness threshold.
    const atoms = makeBucketScenario('2026-04-26T06:07:42.274Z');
    const result = buildPulsePipelineSummary(atoms, NOW);
    expect(result.dispatched_observation_stale).toBe(1);
    expect(result.dispatched_pending_merge).toBe(0);
    expect(result.samples.dispatched_observation_stale[0]?.pipeline_id).toBe(
      'pipeline-stale-bucket-1',
    );
  });

  it('classifies a fresh OPEN observation as pending-merge (NOT stale)', () => {
    // Observation 30min before NOW: under the 1h staleness threshold.
    const thirtyMinAgo = new Date(NOW - 30 * 60 * 1_000).toISOString();
    const atoms = makeBucketScenario(thirtyMinAgo);
    const result = buildPulsePipelineSummary(atoms, NOW);
    expect(result.dispatched_pending_merge).toBe(1);
    expect(result.dispatched_observation_stale).toBe(0);
  });

  it('honors a custom staleness threshold via options.prObservationStalenessMs', () => {
    // 10min-old observation: stale under 5min, fresh under 30min.
    const tenMinAgo = new Date(NOW - 10 * 60 * 1_000).toISOString();
    const atoms = makeBucketScenario(tenMinAgo);
    const stale = buildPulsePipelineSummary(atoms, NOW, {
      prObservationStalenessMs: 5 * 60 * 1_000,
    });
    expect(stale.dispatched_observation_stale).toBe(1);
    expect(stale.dispatched_pending_merge).toBe(0);

    const fresh = buildPulsePipelineSummary(atoms, NOW, {
      prObservationStalenessMs: 30 * 60 * 1_000,
    });
    expect(fresh.dispatched_observation_stale).toBe(0);
    expect(fresh.dispatched_pending_merge).toBe(1);
  });

  it('returns empty stale bucket when staleness window is Infinity (webhook-driven deployments)', () => {
    // Observation arbitrarily old; staleness=Infinity disables detection.
    const atoms = makeBucketScenario('2026-04-26T06:07:42.274Z');
    const result = buildPulsePipelineSummary(atoms, NOW, {
      prObservationStalenessMs: Number.POSITIVE_INFINITY,
    });
    expect(result.dispatched_observation_stale).toBe(0);
    expect(result.dispatched_pending_merge).toBe(1);
  });
});
