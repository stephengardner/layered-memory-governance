import { describe, it, expect } from 'vitest';
import {
  getPipelineDetail,
  listLiveOpsPipelines,
  listPipelineSummaries,
  parseIsoTs,
} from './pipelines';
import type { PipelineSourceAtom } from './pipelines-types';

/*
 * Unit tests for the pipelines projection helpers.
 *
 * Covers the time-window math, stage-state collapse, audit roll-up,
 * empty-store correctness, and detail stitching. Pin `now` to a fixed
 * epoch so window-boundary assertions stay deterministic across
 * machines.
 */

const NOW = Date.parse('2026-04-28T12:00:00.000Z');

function atom(partial: Partial<PipelineSourceAtom> & { id: string; type: string; created_at: string }): PipelineSourceAtom {
  return {
    layer: 'L0',
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    ...partial,
  };
}

function pipelineAtom(opts: {
  id: string;
  state?: string;
  mode?: string;
  seedIds?: string[];
  correlation?: string;
  createdAt?: string;
  content?: string;
}): PipelineSourceAtom {
  return {
    id: opts.id,
    type: 'pipeline',
    layer: 'L0',
    content: opts.content ?? `pipeline:${opts.id}`,
    principal_id: 'cto-actor',
    created_at: opts.createdAt ?? new Date(NOW - 60 * 60 * 1000).toISOString(),
    pipeline_state: opts.state ?? 'pending',
    // Real pipeline atoms on disk carry `taint: 'clean'` per the
    // canonical Atom envelope. Older test fixtures omitted this field,
    // which masked the isCleanLive bug where any truthy taint dropped
    // the row (and 'clean' is truthy). Fixture now matches disk shape.
    taint: 'clean',
    metadata: {
      mode: opts.mode ?? 'substrate-deep',
      seed_atom_ids: opts.seedIds ?? ['operator-intent-test'],
      stage_policy_atom_id: 'pol-pipeline-stages',
      started_at: opts.createdAt ?? new Date(NOW - 60 * 60 * 1000).toISOString(),
      total_cost_usd: 0,
    },
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'planning-pipeline', agent_id: 'cto-actor', session_id: opts.correlation ?? 'corr-1' },
      derived_from: opts.seedIds ?? ['operator-intent-test'],
    },
  };
}

function stageEventAtom(opts: {
  pipelineId: string;
  stageName: string;
  transition: 'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume';
  at: string;
  durationMs?: number;
  costUsd?: number;
  outputAtomId?: string;
}): PipelineSourceAtom {
  return {
    id: `pipeline-stage-event-${opts.pipelineId}-${opts.stageName}-${opts.transition}-corr-1`,
    type: 'pipeline-stage-event',
    layer: 'L0',
    content: `${opts.stageName}:${opts.transition}`,
    principal_id: 'cto-actor',
    created_at: opts.at,
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stageName,
      transition: opts.transition,
      duration_ms: opts.durationMs ?? 0,
      cost_usd: opts.costUsd ?? 0,
      ...(opts.outputAtomId ? { output_atom_id: opts.outputAtomId } : {}),
    },
  };
}

function findingAtom(opts: {
  pipelineId: string;
  stageName: string;
  severity: 'critical' | 'major' | 'minor';
  category: string;
  message: string;
  at: string;
  citedAtomIds?: string[];
  citedPaths?: string[];
}): PipelineSourceAtom {
  return {
    id: `pipeline-audit-finding-${opts.pipelineId}-${opts.stageName}-${opts.severity}-${opts.category}`,
    type: 'pipeline-audit-finding',
    layer: 'L0',
    content: opts.message,
    principal_id: 'cto-actor',
    created_at: opts.at,
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stageName,
      severity: opts.severity,
      category: opts.category,
      message: opts.message,
      cited_atom_ids: opts.citedAtomIds ?? [],
      cited_paths: opts.citedPaths ?? [],
    },
  };
}

describe('parseIsoTs', () => {
  it('returns NaN on empty / nullish / malformed input', () => {
    expect(Number.isNaN(parseIsoTs(undefined))).toBe(true);
    expect(Number.isNaN(parseIsoTs(null))).toBe(true);
    expect(Number.isNaN(parseIsoTs(''))).toBe(true);
    expect(Number.isNaN(parseIsoTs('not-a-date'))).toBe(true);
  });

  it('parses ISO UTC timestamps', () => {
    expect(parseIsoTs('2026-04-28T12:00:00.000Z')).toBe(NOW);
  });
});

describe('listPipelineSummaries — empty store', () => {
  it('returns an empty list with a computed_at', () => {
    const result = listPipelineSummaries([], NOW);
    expect(result.pipelines).toEqual([]);
    expect(result.computed_at).toBe(new Date(NOW).toISOString());
  });

  it('skips non-pipeline atoms', () => {
    const result = listPipelineSummaries([
      atom({ id: 'a', type: 'observation', created_at: new Date(NOW - 60_000).toISOString() }),
    ], NOW);
    expect(result.pipelines).toEqual([]);
  });
});

describe('listPipelineSummaries — single pipeline + 5 events', () => {
  const seed = atom({
    id: 'operator-intent-test',
    type: 'operator-intent',
    layer: 'L1',
    created_at: new Date(NOW - 90 * 60 * 1000).toISOString(),
    content: '## Pipeline test\nGoal: test the projection helpers.',
  });

  const pipeline = pipelineAtom({
    id: 'pipeline-1',
    state: 'running',
    mode: 'substrate-deep',
    seedIds: ['operator-intent-test'],
    createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
  });

  const events = [
    stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'brainstorm',
      transition: 'enter',
      at: new Date(NOW - 25 * 60 * 1000).toISOString(),
    }),
    stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'brainstorm',
      transition: 'exit-success',
      at: new Date(NOW - 20 * 60 * 1000).toISOString(),
      durationMs: 5 * 60 * 1000,
      costUsd: 0.05,
      outputAtomId: 'spec-pipeline-1-corr-1',
    }),
    stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'spec',
      transition: 'enter',
      at: new Date(NOW - 19 * 60 * 1000).toISOString(),
    }),
    stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'spec',
      transition: 'exit-success',
      at: new Date(NOW - 15 * 60 * 1000).toISOString(),
      durationMs: 4 * 60 * 1000,
      costUsd: 0.07,
    }),
    stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'plan',
      transition: 'enter',
      at: new Date(NOW - 14 * 60 * 1000).toISOString(),
    }),
  ];

  it('rolls up cost, duration, last_event_at, current stage', () => {
    const result = listPipelineSummaries([seed, pipeline, ...events], NOW);
    expect(result.pipelines).toHaveLength(1);
    const row = result.pipelines[0]!;
    expect(row.pipeline_id).toBe('pipeline-1');
    expect(row.pipeline_state).toBe('running');
    expect(row.mode).toBe('substrate-deep');
    expect(row.title).toBe('Pipeline test');
    expect(row.total_cost_usd).toBeCloseTo(0.12, 6);
    expect(row.total_duration_ms).toBe(9 * 60 * 1000);
    expect(row.total_stages).toBe(3);
    expect(row.current_stage_name).toBe('plan');
    expect(row.current_stage_index).toBe(2);
    expect(row.last_event_at).toBe(events[4]!.created_at);
    expect(row.audit_counts.total).toBe(0);
    expect(row.has_failed_atom).toBe(false);
    expect(row.has_resume_atom).toBe(false);
    expect(row.seed_atom_ids).toEqual(['operator-intent-test']);
    // No dispatch-record in the fixture: dispatch_summary is null until
    // the substrate emits one. Front-end derives 'unknown' or 'noop'
    // from this absence (see trueOutcome.ts).
    expect(row.dispatch_summary).toBeNull();
  });
});

describe('listPipelineSummaries -- dispatch_summary surfacing', () => {
  /*
   * Regression for the misleading-green-pill bug: a 'completed'
   * pipeline that produced no PR (silent-skip / empty-diff) must
   * surface dispatch_summary.dispatched===0 so the front-end can
   * paint the noop pill instead of green succeeded.
   */
  it('populates dispatch_summary from a dispatch-record atom', () => {
    const pipeline = pipelineAtom({ id: 'p-noop', state: 'completed' });
    const dispatchRecord: PipelineSourceAtom = {
      id: 'dispatch-record-p-noop',
      type: 'dispatch-record',
      layer: 'L0',
      content: '',
      principal_id: 'cto-actor',
      created_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
      taint: 'clean',
      metadata: {
        pipeline_id: 'p-noop',
        stage_output: {
          dispatch_status: 'completed',
          scanned: 1,
          dispatched: 0,
          failed: 0,
          cost_usd: 0,
        },
      },
    };
    const result = listPipelineSummaries([pipeline, dispatchRecord], NOW);
    const row = result.pipelines.find((p) => p.pipeline_id === 'p-noop');
    expect(row?.dispatch_summary).toEqual({ scanned: 1, dispatched: 0, failed: 0 });
  });

  it('populates dispatch_summary with dispatched=1 on a real ship', () => {
    const pipeline = pipelineAtom({ id: 'p-shipped', state: 'completed' });
    const dispatchRecord: PipelineSourceAtom = {
      id: 'dispatch-record-p-shipped',
      type: 'dispatch-record',
      layer: 'L0',
      content: '',
      principal_id: 'cto-actor',
      created_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
      taint: 'clean',
      metadata: {
        pipeline_id: 'p-shipped',
        stage_output: {
          dispatch_status: 'completed',
          scanned: 1,
          dispatched: 1,
          failed: 0,
          cost_usd: 0,
        },
      },
    };
    const result = listPipelineSummaries([pipeline, dispatchRecord], NOW);
    const row = result.pipelines.find((p) => p.pipeline_id === 'p-shipped');
    expect(row?.dispatch_summary).toEqual({ scanned: 1, dispatched: 1, failed: 0 });
  });
});

describe('listPipelineSummaries — sort + cap', () => {
  it('sorts by last_event_at desc with deterministic id-tiebreaker', () => {
    const olderPipeline = pipelineAtom({
      id: 'pipeline-older',
      state: 'completed',
      createdAt: new Date(NOW - 4 * 60 * 60 * 1000).toISOString(),
    });
    const newerPipeline = pipelineAtom({
      id: 'pipeline-newer',
      state: 'completed',
      createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    });
    const result = listPipelineSummaries([olderPipeline, newerPipeline], NOW);
    expect(result.pipelines.map((p) => p.pipeline_id)).toEqual([
      'pipeline-newer',
      'pipeline-older',
    ]);
  });
});

describe('listLiveOpsPipelines', () => {
  it('keeps only running and hil-paused pipelines', () => {
    const running = pipelineAtom({ id: 'p-running', state: 'running' });
    const paused = pipelineAtom({ id: 'p-paused', state: 'hil-paused' });
    const completed = pipelineAtom({ id: 'p-done', state: 'completed' });
    const failed = pipelineAtom({ id: 'p-fail', state: 'failed' });
    const result = listLiveOpsPipelines([running, paused, completed, failed], NOW);
    const ids = result.pipelines.map((p) => p.pipeline_id);
    expect(ids).toContain('p-running');
    expect(ids).toContain('p-paused');
    expect(ids).not.toContain('p-done');
    expect(ids).not.toContain('p-fail');
  });

  it('surfaces active pipelines even when terminal pipelines push past the list cap', () => {
    /*
     * Regression for the org-ceiling case (canon dev-indie-floor-org-ceiling):
     * 100 newer completed pipelines and 1 older still-running pipeline.
     * The list endpoint slices at MAX_PIPELINE_LIST_ITEMS (100) so the
     * running row falls out of `listPipelineSummaries` entirely. Live-ops
     * must filter for active states BEFORE applying its own cap so the
     * Pulse tile keeps showing the active row.
     */
    const completed: PipelineSourceAtom[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `p-done-${String(i).padStart(3, '0')}`;
      const createdAt = new Date(NOW - (10 * 60 * 1000) - (i * 60 * 1000)).toISOString();
      completed.push(pipelineAtom({ id, state: 'completed', createdAt }));
    }
    // Older active pipeline; would be pushed past the 100-row cap by the
    // newer completed runs above.
    const olderActive = pipelineAtom({
      id: 'p-active-older',
      state: 'running',
      createdAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = listLiveOpsPipelines([...completed, olderActive], NOW);
    const ids = result.pipelines.map((p) => p.pipeline_id);
    expect(ids).toContain('p-active-older');
    // None of the completed pipelines should leak into live-ops.
    expect(ids.every((id) => !id.startsWith('p-done-'))).toBe(true);
  });
});

describe('isCleanLive (via listLiveOpsPipelines)', () => {
  /*
   * `isCleanLive` is internal but its observable behavior is what the
   * sibling projections rely on. Any truthy taint disqualifies a row;
   * the previous `taint !== 'clean'` form treated unknown taint values
   * as live and disagreed with `apps/console/server/actor-activity.ts`.
   * This mirrors the actor-activity posture so projections agree on
   * which atoms are live.
   */
  it('drops a pipeline whose root atom carries any truthy taint value', () => {
    const tainted: PipelineSourceAtom = {
      ...pipelineAtom({ id: 'p-tainted', state: 'running' }),
      // Future taint values (`compromised`, `quarantined`, etc.) MUST also
      // disqualify; the previous `!== 'clean'` form would allow an
      // unknown value `'clean-but-flagged'` through which is wrong.
      taint: 'compromised',
    };
    const cleanRunning = pipelineAtom({ id: 'p-clean', state: 'running' });
    const result = listLiveOpsPipelines([tainted, cleanRunning], NOW);
    const ids = result.pipelines.map((p) => p.pipeline_id);
    expect(ids).toContain('p-clean');
    expect(ids).not.toContain('p-tainted');
  });
});

describe('foldStageEvents - equal-timestamp tie-break', () => {
  /*
   * Regression for the equal-timestamp collapse bug: enter + exit-success
   * at the SAME `at` value must collapse to `succeeded`, not stick at
   * `running`. The fold's outer sort breaks ties by atom_id ascending,
   * so the later atom_id wins; the assertion is shaped so swapping the
   * id ordering would flip the result.
   */
  it('collapses equal-timestamp enter -> exit-success to succeeded', () => {
    const sameTs = new Date(NOW - 10 * 60 * 1000).toISOString();
    const pipeline = pipelineAtom({ id: 'pipeline-tie', state: 'completed' });
    // atom_id ascending tie-break: 'enter' < 'exit' so exit-success
    // sorts after enter and must override the running state.
    const enterEvent = stageEventAtom({
      pipelineId: 'pipeline-tie',
      stageName: 'plan',
      transition: 'enter',
      at: sameTs,
    });
    const exitEvent = stageEventAtom({
      pipelineId: 'pipeline-tie',
      stageName: 'plan',
      transition: 'exit-success',
      at: sameTs,
      durationMs: 0,
      costUsd: 0,
    });
    const result = getPipelineDetail([pipeline, enterEvent, exitEvent], 'pipeline-tie');
    expect(result).not.toBeNull();
    expect(result!.stages).toHaveLength(1);
    expect(result!.stages[0]!.state).toBe('succeeded');
  });
});

describe('getPipelineDetail', () => {
  it('returns null for unknown id', () => {
    const result = getPipelineDetail([], 'pipeline-missing');
    expect(result).toBeNull();
  });

  it('stitches pipeline + events + findings + failure into a detail payload', () => {
    const pipeline = pipelineAtom({
      id: 'pipeline-detail',
      state: 'failed',
      createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    });
    const events = [
      stageEventAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'brainstorm',
        transition: 'enter',
        at: new Date(NOW - 25 * 60 * 1000).toISOString(),
      }),
      stageEventAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'brainstorm',
        transition: 'exit-success',
        at: new Date(NOW - 20 * 60 * 1000).toISOString(),
        durationMs: 5 * 60 * 1000,
        costUsd: 0.05,
      }),
      stageEventAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'spec',
        transition: 'enter',
        at: new Date(NOW - 19 * 60 * 1000).toISOString(),
      }),
      stageEventAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'spec',
        transition: 'exit-failure',
        at: new Date(NOW - 18 * 60 * 1000).toISOString(),
        durationMs: 60 * 1000,
        costUsd: 0.02,
      }),
    ];
    const findings = [
      findingAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'spec',
        severity: 'critical',
        category: 'cite-fail',
        message: 'Cited atom does not exist',
        at: new Date(NOW - 18 * 60 * 1000).toISOString(),
        citedAtomIds: ['atom-bogus'],
        citedPaths: ['src/missing/file.ts'],
      }),
      findingAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'spec',
        severity: 'minor',
        category: 'style',
        message: 'Trailing whitespace',
        at: new Date(NOW - 18 * 60 * 1000 + 1000).toISOString(),
      }),
      findingAtom({
        pipelineId: 'pipeline-detail',
        stageName: 'spec',
        severity: 'major',
        category: 'spec-clarity',
        message: 'Spec is ambiguous on edge case',
        at: new Date(NOW - 18 * 60 * 1000 + 2000).toISOString(),
      }),
    ];
    const failure: PipelineSourceAtom = {
      id: 'pipeline-failed-pipeline-detail-1',
      type: 'pipeline-failed',
      layer: 'L0',
      content: 'spec: cite-fail',
      principal_id: 'cto-actor',
      created_at: new Date(NOW - 17 * 60 * 1000).toISOString(),
      metadata: {
        pipeline_id: 'pipeline-detail',
        failed_stage_name: 'spec',
        failed_stage_index: 1,
        cause: 'cited atom does not exist',
        chain: ['pipeline-detail', events[3]!.id, findings[0]!.id],
        recovery_hint: 'Re-run after re-grounding citations against the live repo.',
      },
    };

    const result = getPipelineDetail(
      [pipeline, ...events, ...findings, failure],
      'pipeline-detail',
    );
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.pipeline.id).toBe('pipeline-detail');
    expect(result.pipeline.pipeline_state).toBe('failed');
    expect(result.events).toHaveLength(4);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]!.state).toBe('succeeded');
    expect(result.stages[1]!.state).toBe('failed');
    expect(result.findings.map((f) => f.severity)).toEqual(['critical', 'major', 'minor']);
    expect(result.audit_counts).toEqual({ total: 3, critical: 1, major: 1, minor: 1 });
    expect(result.failure).not.toBeNull();
    expect(result.failure!.failed_stage_name).toBe('spec');
    expect(result.failure!.recovery_hint).toMatch(/re-grounding/);
    expect(result.total_cost_usd).toBeCloseTo(0.07, 6);
  });

  it('treats hil-pause + hil-resume as paused -> running', () => {
    const pipeline = pipelineAtom({
      id: 'pipeline-pause',
      state: 'hil-paused',
      createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    });
    const events = [
      stageEventAtom({
        pipelineId: 'pipeline-pause',
        stageName: 'plan',
        transition: 'enter',
        at: new Date(NOW - 20 * 60 * 1000).toISOString(),
      }),
      stageEventAtom({
        pipelineId: 'pipeline-pause',
        stageName: 'plan',
        transition: 'hil-pause',
        at: new Date(NOW - 19 * 60 * 1000).toISOString(),
      }),
    ];
    const result = getPipelineDetail([pipeline, ...events], 'pipeline-pause');
    expect(result).not.toBeNull();
    expect(result!.stages[0]!.state).toBe('paused');
    expect(result!.current_stage_name).toBe('plan');

    // Resume: state collapses back to running.
    const resumeEvent = stageEventAtom({
      pipelineId: 'pipeline-pause',
      stageName: 'plan',
      transition: 'hil-resume',
      at: new Date(NOW - 18 * 60 * 1000).toISOString(),
    });
    const result2 = getPipelineDetail(
      [pipeline, ...events, resumeEvent],
      'pipeline-pause',
    );
    expect(result2!.stages[0]!.state).toBe('running');
  });

  it('drops superseded and tainted atoms', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-clean' });
    const taintedEvent: PipelineSourceAtom = {
      ...stageEventAtom({
        pipelineId: 'pipeline-clean',
        stageName: 'spec',
        transition: 'enter',
        at: new Date(NOW - 20 * 60 * 1000).toISOString(),
      }),
      taint: 'compromised',
    };
    const supersededFinding: PipelineSourceAtom = {
      ...findingAtom({
        pipelineId: 'pipeline-clean',
        stageName: 'spec',
        severity: 'critical',
        category: 'old',
        message: 'stale',
        at: new Date(NOW - 19 * 60 * 1000).toISOString(),
      }),
      superseded_by: ['successor-finding'],
    };
    const result = getPipelineDetail(
      [pipeline, taintedEvent, supersededFinding],
      'pipeline-clean',
    );
    expect(result!.events).toHaveLength(0);
    expect(result!.findings).toHaveLength(0);
  });
});

/*
 * Helpers for the agent_turns projection tests below. Mirrors the
 * pipeline-stage-event + agent-turn atom shapes the substrate writes
 * (per src/runtime/planning-pipeline/atom-shapes.ts +
 * src/substrate/types.ts AgentTurnMeta). Kept separate from the
 * shared `stageEventAtom` helper above because the agent-turn
 * transition carries a wider metadata payload (agent_turn_atom_id +
 * turn_index) that other transitions never emit.
 */
function agentTurnIndexEventAtom(opts: {
  pipelineId: string;
  stageName: string;
  turnIndex: number;
  agentTurnAtomId: string | null;
  at: string;
}): PipelineSourceAtom {
  const idTail = `agent-turn-${opts.turnIndex}`;
  const meta: Record<string, unknown> = {
    pipeline_id: opts.pipelineId,
    stage_name: opts.stageName,
    transition: 'agent-turn',
    duration_ms: 0,
    cost_usd: 0,
    turn_index: opts.turnIndex,
  };
  if (opts.agentTurnAtomId !== null) {
    meta['agent_turn_atom_id'] = opts.agentTurnAtomId;
  }
  return {
    id: `pipeline-stage-event-${opts.pipelineId}-${opts.stageName}-${idTail}-corr-1`,
    type: 'pipeline-stage-event',
    layer: 'L0',
    content: `${opts.stageName}:agent-turn`,
    principal_id: 'cto-actor',
    created_at: opts.at,
    metadata: meta,
  };
}

function agentTurnAtom(opts: {
  id: string;
  sessionAtomId: string;
  turnIndex: number;
  llmInputInline?: string;
  llmInputBlob?: { ref: { hash: string; size: number } };
  toolCallsCount?: number;
  latencyMs?: number;
  at: string;
}): PipelineSourceAtom {
  const llmInput = opts.llmInputInline !== undefined
    ? { inline: opts.llmInputInline }
    : opts.llmInputBlob !== undefined
      ? { ref: opts.llmInputBlob.ref }
      : { inline: '' };
  const toolCalls = Array.from({ length: opts.toolCallsCount ?? 0 }, (_, i) => ({
    tool: `tool-${i}`,
    args: { inline: '' },
    result: { inline: '' },
    latency_ms: 0,
    outcome: 'success' as const,
  }));
  return {
    id: opts.id,
    type: 'agent-turn',
    layer: 'L0',
    content: `turn ${opts.turnIndex}`,
    principal_id: 'cto-actor',
    created_at: opts.at,
    metadata: {
      session_id: opts.sessionAtomId,
      agent_turn: {
        session_atom_id: opts.sessionAtomId,
        turn_index: opts.turnIndex,
        llm_input: llmInput,
        llm_output: { inline: '' },
        tool_calls: toolCalls,
        latency_ms: opts.latencyMs ?? 0,
      },
    },
  };
}

describe('getPipelineDetail - agent_turns projection', () => {
  it('returns an empty agent_turns array when no agent-turn events exist', () => {
    const pipeline = pipelineAtom({ id: 'p-no-turns', state: 'running' });
    const enterEvent = stageEventAtom({
      pipelineId: 'p-no-turns',
      stageName: 'plan',
      transition: 'enter',
      at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    });
    const result = getPipelineDetail([pipeline, enterEvent], 'p-no-turns');
    expect(result).not.toBeNull();
    expect(result!.agent_turns).toEqual([]);
  });

  it('surfaces agent-turn events into agent_turns with cross-walked telemetry', () => {
    const pipeline = pipelineAtom({ id: 'p-turns', state: 'running' });
    const enter = stageEventAtom({
      pipelineId: 'p-turns',
      stageName: 'brainstorm',
      transition: 'enter',
      at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    });
    const turnEvent0 = agentTurnIndexEventAtom({
      pipelineId: 'p-turns',
      stageName: 'brainstorm',
      turnIndex: 0,
      agentTurnAtomId: 'agent-turn-p-turns-0',
      at: new Date(NOW - 9 * 60 * 1000).toISOString(),
    });
    const turnAtom0 = agentTurnAtom({
      id: 'agent-turn-p-turns-0',
      sessionAtomId: 'agent-session-p-turns',
      turnIndex: 0,
      llmInputInline: 'Survey alternatives for the first stage of the deep planning pipeline.',
      toolCallsCount: 3,
      latencyMs: 1234,
      at: new Date(NOW - 9 * 60 * 1000).toISOString(),
    });
    const result = getPipelineDetail(
      [pipeline, enter, turnEvent0, turnAtom0],
      'p-turns',
    );
    expect(result).not.toBeNull();
    expect(result!.agent_turns).toHaveLength(1);
    const row = result!.agent_turns[0]!;
    expect(row.stage_name).toBe('brainstorm');
    expect(row.turn_index).toBe(0);
    expect(row.agent_turn_atom_id).toBe('agent-turn-p-turns-0');
    expect(row.created_at).toBe(turnEvent0.created_at);
    expect(row.latency_ms).toBe(1234);
    expect(row.tool_calls_count).toBe(3);
    expect(row.llm_input_preview).toBe(
      'Survey alternatives for the first stage of the deep planning pipeline.',
    );
  });

  it('truncates llm_input previews longer than 200 chars with an ellipsis', () => {
    const pipeline = pipelineAtom({ id: 'p-long', state: 'running' });
    const longInput = 'a'.repeat(500);
    const event = agentTurnIndexEventAtom({
      pipelineId: 'p-long',
      stageName: 'plan',
      turnIndex: 0,
      agentTurnAtomId: 'agent-turn-p-long-0',
      at: new Date(NOW - 60_000).toISOString(),
    });
    const turn = agentTurnAtom({
      id: 'agent-turn-p-long-0',
      sessionAtomId: 'agent-session-p-long',
      turnIndex: 0,
      llmInputInline: longInput,
      at: new Date(NOW - 60_000).toISOString(),
    });
    const result = getPipelineDetail([pipeline, event, turn], 'p-long');
    const row = result!.agent_turns[0]!;
    expect(row.llm_input_preview).not.toBeNull();
    expect(row.llm_input_preview!.length).toBeLessThanOrEqual(201); // 200 + ellipsis char
    expect(row.llm_input_preview!.endsWith('…')).toBe(true);
    expect(row.llm_input_preview!.startsWith('aaaa')).toBe(true);
  });

  it('returns null fields when the agent-turn atom is missing', () => {
    /*
     * Defensive: the substrate could write a pipeline-stage-event with
     * transition='agent-turn' that points at an agent_turn_atom_id which
     * has not yet been written (or has been pruned). The projection MUST
     * surface the index row with null telemetry rather than dropping it
     * or throwing.
     */
    const pipeline = pipelineAtom({ id: 'p-missing', state: 'running' });
    const event = agentTurnIndexEventAtom({
      pipelineId: 'p-missing',
      stageName: 'spec',
      turnIndex: 0,
      agentTurnAtomId: 'agent-turn-not-on-disk',
      at: new Date(NOW - 60_000).toISOString(),
    });
    const result = getPipelineDetail([pipeline, event], 'p-missing');
    expect(result!.agent_turns).toHaveLength(1);
    const row = result!.agent_turns[0]!;
    expect(row.agent_turn_atom_id).toBe('agent-turn-not-on-disk');
    expect(row.latency_ms).toBeNull();
    expect(row.tool_calls_count).toBeNull();
    expect(row.llm_input_preview).toBeNull();
  });

  it('returns null preview when llm_input is a blob ref (projection does not resolve blobs)', () => {
    const pipeline = pipelineAtom({ id: 'p-blob', state: 'running' });
    const event = agentTurnIndexEventAtom({
      pipelineId: 'p-blob',
      stageName: 'plan',
      turnIndex: 0,
      agentTurnAtomId: 'agent-turn-p-blob-0',
      at: new Date(NOW - 60_000).toISOString(),
    });
    const turn = agentTurnAtom({
      id: 'agent-turn-p-blob-0',
      sessionAtomId: 'agent-session-p-blob',
      turnIndex: 0,
      llmInputBlob: { ref: { hash: 'sha256-deadbeef', size: 4096 } },
      latencyMs: 2000,
      at: new Date(NOW - 60_000).toISOString(),
    });
    const result = getPipelineDetail([pipeline, event, turn], 'p-blob');
    const row = result!.agent_turns[0]!;
    expect(row.llm_input_preview).toBeNull();
    expect(row.latency_ms).toBe(2000);
  });

  it('sorts agent_turns newest-first across all stages with turn_index DESC tiebreaker', () => {
    const pipeline = pipelineAtom({ id: 'p-sort', state: 'running' });
    const earlier = new Date(NOW - 10 * 60 * 1000).toISOString();
    const later = new Date(NOW - 5 * 60 * 1000).toISOString();
    const sameTs = new Date(NOW - 60_000).toISOString();
    const events = [
      agentTurnIndexEventAtom({
        pipelineId: 'p-sort',
        stageName: 'brainstorm',
        turnIndex: 0,
        agentTurnAtomId: 'agent-turn-p-sort-bs-0',
        at: earlier,
      }),
      agentTurnIndexEventAtom({
        pipelineId: 'p-sort',
        stageName: 'spec',
        turnIndex: 1,
        agentTurnAtomId: 'agent-turn-p-sort-spec-1',
        at: later,
      }),
      // Same timestamp; turn_index DESC tiebreak places higher index first.
      agentTurnIndexEventAtom({
        pipelineId: 'p-sort',
        stageName: 'plan',
        turnIndex: 0,
        agentTurnAtomId: 'agent-turn-p-sort-plan-0',
        at: sameTs,
      }),
      agentTurnIndexEventAtom({
        pipelineId: 'p-sort',
        stageName: 'plan',
        turnIndex: 1,
        agentTurnAtomId: 'agent-turn-p-sort-plan-1',
        at: sameTs,
      }),
    ];
    const result = getPipelineDetail([pipeline, ...events], 'p-sort');
    expect(result!.agent_turns).toHaveLength(4);
    // sameTs is the newest of the three timestamps; both plan rows lead.
    // Within sameTs, turn_index 1 > 0 -> plan-1 first.
    expect(result!.agent_turns[0]!.stage_name).toBe('plan');
    expect(result!.agent_turns[0]!.turn_index).toBe(1);
    expect(result!.agent_turns[1]!.stage_name).toBe('plan');
    expect(result!.agent_turns[1]!.turn_index).toBe(0);
    expect(result!.agent_turns[2]!.stage_name).toBe('spec');
    expect(result!.agent_turns[3]!.stage_name).toBe('brainstorm');
  });

  it('caps agent_turns at PIPELINE_DETAIL_MAX_TURNS', () => {
    const pipeline = pipelineAtom({ id: 'p-cap', state: 'running' });
    // Mint 60 turn-index events; cap at 30 should keep only the newest 30.
    const events: PipelineSourceAtom[] = [];
    for (let i = 0; i < 60; i++) {
      events.push(agentTurnIndexEventAtom({
        pipelineId: 'p-cap',
        stageName: 'plan',
        turnIndex: i,
        agentTurnAtomId: `agent-turn-p-cap-${i}`,
        at: new Date(NOW - (60 - i) * 1000).toISOString(),
      }));
    }
    const result = getPipelineDetail([pipeline, ...events], 'p-cap');
    expect(result!.agent_turns.length).toBe(30);
    // The newest 30 have turn_index 30..59; newest-first means index 59 leads.
    expect(result!.agent_turns[0]!.turn_index).toBe(59);
    expect(result!.agent_turns[29]!.turn_index).toBe(30);
  });

  it('skips tainted or superseded agent-turn atoms when cross-walking telemetry', () => {
    const pipeline = pipelineAtom({ id: 'p-taint', state: 'running' });
    const event = agentTurnIndexEventAtom({
      pipelineId: 'p-taint',
      stageName: 'plan',
      turnIndex: 0,
      agentTurnAtomId: 'agent-turn-p-taint-0',
      at: new Date(NOW - 60_000).toISOString(),
    });
    const taintedTurn: PipelineSourceAtom = {
      ...agentTurnAtom({
        id: 'agent-turn-p-taint-0',
        sessionAtomId: 'agent-session-p-taint',
        turnIndex: 0,
        llmInputInline: 'should-be-skipped',
        toolCallsCount: 5,
        latencyMs: 9999,
        at: new Date(NOW - 60_000).toISOString(),
      }),
      taint: 'compromised',
    };
    const result = getPipelineDetail([pipeline, event, taintedTurn], 'p-taint');
    // Index event still surfaces; the cross-walk to the tainted agent-turn
    // is skipped, so telemetry fields are null (NOT inherited from the
    // tainted atom).
    expect(result!.agent_turns).toHaveLength(1);
    const row = result!.agent_turns[0]!;
    expect(row.latency_ms).toBeNull();
    expect(row.tool_calls_count).toBeNull();
    expect(row.llm_input_preview).toBeNull();
  });
});
