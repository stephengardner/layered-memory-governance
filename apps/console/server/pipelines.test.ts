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
