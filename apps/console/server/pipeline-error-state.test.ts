import { describe, it, expect } from 'vitest';
import {
  buildPipelineErrorState,
  categorizeCause,
} from './pipeline-error-state';
import type { PipelineErrorStateSourceAtom } from './pipeline-error-state-types';

/*
 * Unit tests for the pipeline-error-state synthesizer.
 *
 * Covers:
 *   - categorizeCause: every named category + fall-through
 *   - buildPipelineErrorState: state pill, severity, suggested_action,
 *     cited atoms, actions across the full failure-mode set
 *   - Operator-abandoned + kill-switch-halted detection
 *   - Happy-path 'ok' shape (running / completed / hil-paused)
 *
 * Pin `now` to a fixed epoch so timestamp-derived fields are
 * deterministic across machines.
 */

const NOW = Date.parse('2026-05-11T12:00:00.000Z');

function pipelineAtom(opts: {
  id: string;
  state?: string;
  metadata?: Record<string, unknown>;
}): PipelineErrorStateSourceAtom {
  return {
    id: opts.id,
    type: 'pipeline',
    layer: 'L0',
    content: `pipeline:${opts.id}`,
    principal_id: 'cto-actor',
    created_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    pipeline_state: opts.state ?? 'failed',
    taint: 'clean',
    metadata: {
      mode: 'substrate-deep',
      seed_atom_ids: ['operator-intent-test'],
      ...(opts.metadata ?? {}),
    },
  };
}

function failedAtom(opts: {
  pipelineId: string;
  cause: string;
  failedStageName?: string;
  failedStageIndex?: number;
  chain?: string[];
  at?: string;
}): PipelineErrorStateSourceAtom {
  return {
    id: `pipeline-failed-${opts.pipelineId}-${opts.cause.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`,
    type: 'pipeline-failed',
    layer: 'L0',
    content: `${opts.failedStageName ?? 'unknown'}: ${opts.cause}`,
    principal_id: 'cto-actor',
    created_at: opts.at ?? new Date(NOW - 5 * 60 * 1000).toISOString(),
    taint: 'clean',
    metadata: {
      pipeline_id: opts.pipelineId,
      failed_stage_name: opts.failedStageName ?? 'plan-stage',
      failed_stage_index: opts.failedStageIndex ?? 2,
      cause: opts.cause,
      chain: opts.chain ?? ['operator-intent-test', 'spec-out', 'plan-out'],
      recovery_hint: 're-run from stage after addressing the cause',
    },
  };
}

function findingAtom(opts: {
  pipelineId: string;
  stageName?: string;
  severity?: 'critical' | 'major' | 'minor';
  category: string;
  message?: string;
  citedAtomIds?: string[];
  at?: string;
}): PipelineErrorStateSourceAtom {
  return {
    id: `pipeline-audit-finding-${opts.pipelineId}-${opts.category}`,
    type: 'pipeline-audit-finding',
    layer: 'L0',
    content: opts.message ?? 'finding',
    principal_id: 'pipeline-auditor',
    created_at: opts.at ?? new Date(NOW - 6 * 60 * 1000).toISOString(),
    taint: 'clean',
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stageName ?? 'plan-stage',
      severity: opts.severity ?? 'critical',
      category: opts.category,
      message: opts.message ?? 'finding message',
      cited_atom_ids: opts.citedAtomIds ?? [],
      cited_paths: [],
    },
  };
}

function stageEventAtom(opts: {
  pipelineId: string;
  stageName: string;
  transition: 'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume';
  outputAtomId?: string;
  haltReason?: string;
  at?: string;
}): PipelineErrorStateSourceAtom {
  return {
    id: `pipeline-stage-event-${opts.pipelineId}-${opts.stageName}-${opts.transition}`,
    type: 'pipeline-stage-event',
    layer: 'L0',
    content: `${opts.stageName}:${opts.transition}`,
    principal_id: 'cto-actor',
    created_at: opts.at ?? new Date(NOW - 7 * 60 * 1000).toISOString(),
    taint: 'clean',
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stageName,
      transition: opts.transition,
      duration_ms: 0,
      cost_usd: 0,
      ...(opts.outputAtomId ? { output_atom_id: opts.outputAtomId } : {}),
      ...(opts.haltReason ? { halt_reason: opts.haltReason } : {}),
    },
  };
}

describe('categorizeCause', () => {
  it('maps budget-overflow prefix to budget-exceeded critical', () => {
    expect(categorizeCause('budget-overflow: cost 0.5 > cap 0.25', [])).toEqual({
      category: 'budget-exceeded',
      severity: 'critical',
    });
  });

  it('maps pipeline-cost-overflow prefix to its own category', () => {
    expect(categorizeCause('pipeline-cost-overflow: total 1.2 > cap 1.0', [])).toEqual({
      category: 'pipeline-cost-overflow',
      severity: 'critical',
    });
  });

  it('maps schema-validation-failed to schema-mismatch critical', () => {
    expect(categorizeCause('schema-validation-failed: missing target_paths', [])).toEqual({
      category: 'schema-mismatch',
      severity: 'critical',
    });
  });

  it('maps critical-audit-finding to its own category when no confab finding', () => {
    expect(categorizeCause('critical-audit-finding', ['security-issue'])).toEqual({
      category: 'critical-audit-finding',
      severity: 'critical',
    });
  });

  it('upgrades critical-audit-finding to plan-author-confabulation when a confab finding exists', () => {
    expect(categorizeCause('critical-audit-finding', ['target-paths-mismatch'])).toEqual({
      category: 'plan-author-confabulation',
      severity: 'critical',
    });
  });

  it('recognizes underscore variant of target_paths-mismatch', () => {
    expect(categorizeCause('critical-audit-finding', ['target_paths-mismatch'])).toEqual({
      category: 'plan-author-confabulation',
      severity: 'critical',
    });
  });

  it('recognizes citation-not-found as a confab finding', () => {
    expect(categorizeCause('critical-audit-finding', ['citation-not-found'])).toEqual({
      category: 'plan-author-confabulation',
      severity: 'critical',
    });
  });

  it('falls back to critical-audit-finding when finding categories are non-confab', () => {
    expect(categorizeCause('critical-audit-finding', ['security-issue', 'license-issue'])).toEqual({
      category: 'critical-audit-finding',
      severity: 'critical',
    });
  });

  it('maps unknown-stage exact match to unknown-stage warning', () => {
    expect(categorizeCause('unknown-stage', [])).toEqual({
      category: 'unknown-stage',
      severity: 'warning',
    });
  });

  it('maps unknown-stage prefix variant to unknown-stage warning', () => {
    expect(categorizeCause('unknown-stage: foo', [])).toEqual({
      category: 'unknown-stage',
      severity: 'warning',
    });
  });

  it('maps stage-output-persist-failed prefix to stage-output-persist-failed critical', () => {
    expect(categorizeCause('stage-output-persist-failed: AtomStore.put rejected', [])).toEqual({
      category: 'stage-output-persist-failed',
      severity: 'critical',
    });
  });

  it('falls through to stage-threw for an uncategorized non-empty cause', () => {
    expect(categorizeCause('Error: socket hang up', [])).toEqual({
      category: 'stage-threw',
      severity: 'info',
    });
  });

  it('falls through to uncategorized for an empty cause', () => {
    expect(categorizeCause('', [])).toEqual({
      category: 'uncategorized',
      severity: 'info',
    });
  });
});

describe('buildPipelineErrorState', () => {
  it('returns state=ok for a running pipeline with no failure atom', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1', state: 'running' });
    const result = buildPipelineErrorState([pipeline], 'pipeline-1', NOW);
    expect(result.state).toBe('ok');
    expect(result.category).toBeNull();
    expect(result.suggested_action).toBeNull();
    expect(result.actions).toEqual([]);
    expect(result.computed_at).toBe(new Date(NOW).toISOString());
  });

  it('returns state=ok for a completed pipeline', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1', state: 'completed' });
    const result = buildPipelineErrorState([pipeline], 'pipeline-1', NOW);
    expect(result.state).toBe('ok');
  });

  it('returns state=ok for a hil-paused pipeline', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1', state: 'hil-paused' });
    const result = buildPipelineErrorState([pipeline], 'pipeline-1', NOW);
    expect(result.state).toBe('ok');
  });

  it('returns state=ok for an unknown pipeline id (no atoms at all)', () => {
    const result = buildPipelineErrorState([], 'pipeline-missing', NOW);
    expect(result.state).toBe('ok');
    expect(result.pipeline_id).toBe('pipeline-missing');
  });

  it('returns state=failed with budget-exceeded category for a budget-overflow cause', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1', state: 'failed' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: cost 0.5 > cap 0.25',
      failedStageName: 'plan-stage',
      failedStageIndex: 2,
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.state).toBe('failed');
    expect(result.category).toBe('budget-exceeded');
    expect(result.severity).toBe('critical');
    expect(result.category_label).toBe('Budget exceeded');
    expect(result.failed_stage_name).toBe('plan-stage');
    expect(result.failed_stage_index).toBe(2);
    expect(result.suggested_action).toContain('per-stage cost cap');
    expect(result.suggested_action).toContain('plan-stage');
    expect(result.raw_cause).toContain('budget-overflow');
  });

  it('surfaces a view-policy action for budget-exceeded pointing at pol-pipeline-stage-cost-cap', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: cost 0.5 > cap 0.25',
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    const policy = result.actions.find((a) => a.kind === 'view-policy');
    expect(policy).toBeDefined();
    expect(policy!.atom_id).toBe('pol-pipeline-stage-cost-cap');
  });

  it('surfaces a view-canon action for budget-exceeded pointing at the indie-floor canon', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: 1 > 0',
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    const canon = result.actions.find((a) => a.kind === 'view-canon');
    expect(canon).toBeDefined();
    expect(canon!.canon_id).toBe('dev-indie-floor-org-ceiling');
  });

  it('returns state=failed with schema-mismatch + a view-output action when stage persisted before failure', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'schema-validation-failed: missing target_paths',
      failedStageName: 'plan-stage',
    });
    const exitFailureEvent = stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'plan-stage',
      transition: 'exit-failure',
      outputAtomId: 'plan-out-atom',
    });
    const result = buildPipelineErrorState(
      [pipeline, failed, exitFailureEvent],
      'pipeline-1',
      NOW,
    );
    expect(result.category).toBe('schema-mismatch');
    const viewOutput = result.actions.find((a) => a.kind === 'view-output');
    expect(viewOutput).toBeDefined();
    expect(viewOutput!.atom_id).toBe('plan-out-atom');
  });

  it('returns critical-audit-finding when failure cause is critical-audit-finding and no confab finding exists', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'critical-audit-finding',
      failedStageName: 'plan-stage',
    });
    const finding = findingAtom({
      pipelineId: 'pipeline-1',
      category: 'security-issue',
      severity: 'critical',
      citedAtomIds: ['cited-a', 'cited-b'],
    });
    const result = buildPipelineErrorState([pipeline, failed, finding], 'pipeline-1', NOW);
    expect(result.category).toBe('critical-audit-finding');
    expect(result.cited_atom_ids).toContain('cited-a');
    expect(result.cited_atom_ids).toContain('cited-b');
    const viewFinding = result.actions.find((a) => a.kind === 'view-atom' && a.label === 'View finding atom');
    expect(viewFinding).toBeDefined();
    expect(viewFinding!.atom_id).toBe(finding.id);
  });

  it('upgrades to plan-author-confabulation when any critical finding is in the confab set', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'critical-audit-finding',
      failedStageName: 'plan-stage',
    });
    const finding = findingAtom({
      pipelineId: 'pipeline-1',
      category: 'target-paths-mismatch',
      severity: 'critical',
    });
    const result = buildPipelineErrorState([pipeline, failed, finding], 'pipeline-1', NOW);
    expect(result.category).toBe('plan-author-confabulation');
    expect(result.suggested_action).toContain('dev-drafter-citation-verification-required');
    const canon = result.actions.find((a) => a.kind === 'view-canon');
    expect(canon!.canon_id).toBe('dev-drafter-citation-verification-required');
  });

  it('surfaces unknown-stage when the cause string is unknown-stage', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'unknown-stage',
      failedStageName: 'unknown-stage',
      failedStageIndex: 0,
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.category).toBe('unknown-stage');
    expect(result.severity).toBe('warning');
  });

  it('surfaces stage-threw for an uncategorized cause string with the raw cause echoed in the suggestion', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'Error: socket hang up',
      failedStageName: 'spec-stage',
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.category).toBe('stage-threw');
    expect(result.severity).toBe('info');
    expect(result.suggested_action).toContain('Error: socket hang up');
  });

  it('returns state=abandoned when the pipeline atom carries abandoned_at metadata', () => {
    const pipeline = pipelineAtom({
      id: 'pipeline-1',
      state: 'failed',
      metadata: {
        abandoned_at: new Date(NOW - 60_000).toISOString(),
        abandoned_by: 'operator-principal',
        abandoned_reason: 'wrong direction, redoing',
      },
    });
    const result = buildPipelineErrorState([pipeline], 'pipeline-1', NOW);
    expect(result.state).toBe('abandoned');
    expect(result.category).toBe('operator-abandoned');
    expect(result.severity).toBe('warning');
    expect(result.raw_cause).toBe('wrong direction, redoing');
    expect(result.suggested_action).toContain('wrong direction, redoing');
  });

  it('returns state=halted with kill-switch-halted category when a stage-event carries halt_reason=kill-switch', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1', state: 'running' });
    const event = stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'plan-stage',
      transition: 'exit-failure',
      haltReason: 'kill-switch',
    });
    const result = buildPipelineErrorState([pipeline, event], 'pipeline-1', NOW);
    expect(result.state).toBe('halted');
    expect(result.category).toBe('kill-switch-halted');
    expect(result.failed_stage_name).toBe('plan-stage');
    expect(result.suggested_action).toContain('.lag/STOP');
  });

  it('returns state=halted when the pipeline atom carries metadata.halted_by=kill-switch', () => {
    const pipeline = pipelineAtom({
      id: 'pipeline-1',
      state: 'failed',
      metadata: { halted_by: 'kill-switch' },
    });
    const result = buildPipelineErrorState([pipeline], 'pipeline-1', NOW);
    expect(result.state).toBe('halted');
    expect(result.category).toBe('kill-switch-halted');
  });

  it('operator-abandoned takes precedence over a failure atom for the same pipeline', () => {
    const pipeline = pipelineAtom({
      id: 'pipeline-1',
      state: 'failed',
      metadata: {
        abandoned_at: new Date(NOW - 60_000).toISOString(),
        abandoned_reason: 'redoing',
      },
    });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: 1 > 0',
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.state).toBe('abandoned');
    expect(result.category).toBe('operator-abandoned');
  });

  it('failed-state action set does NOT include an abandon action (substrate rejects abandon on terminal)', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: 1 > 0',
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.actions.find((a) => a.kind === 'abandon')).toBeUndefined();
  });

  it('halted-state action set includes the abandon escape-hatch', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1', state: 'running' });
    const event = stageEventAtom({
      pipelineId: 'pipeline-1',
      stageName: 'plan-stage',
      transition: 'exit-failure',
      haltReason: 'kill-switch',
    });
    const result = buildPipelineErrorState([pipeline, event], 'pipeline-1', NOW);
    const abandon = result.actions.find((a) => a.kind === 'abandon');
    expect(abandon).toBeDefined();
    expect(abandon!.label).toBe('Abandon pipeline');
  });

  it('abandoned-state action set does NOT include an abandon action (already terminal)', () => {
    const pipeline = pipelineAtom({
      id: 'pipeline-1',
      state: 'abandoned',
      metadata: {
        abandoned_at: new Date(NOW - 60_000).toISOString(),
        abandoned_reason: 'redoing',
      },
    });
    const result = buildPipelineErrorState([pipeline], 'pipeline-1', NOW);
    expect(result.actions.find((a) => a.kind === 'abandon')).toBeUndefined();
  });

  it('cited_atom_ids reflects the failure-atom chain plus the first finding cited atoms', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'critical-audit-finding',
      chain: ['op-intent', 'spec-out', 'plan-out'],
    });
    const finding = findingAtom({
      pipelineId: 'pipeline-1',
      severity: 'critical',
      category: 'target-paths-mismatch',
      citedAtomIds: ['plan-out', 'extra-cited'],
    });
    const result = buildPipelineErrorState([pipeline, failed, finding], 'pipeline-1', NOW);
    expect(result.cited_atom_ids).toEqual(['op-intent', 'spec-out', 'plan-out', 'extra-cited']);
  });

  it('filters tainted atoms from consideration', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed: PipelineErrorStateSourceAtom = {
      ...failedAtom({
        pipelineId: 'pipeline-1',
        cause: 'budget-overflow: 1 > 0',
      }),
      taint: 'compromised',
    };
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.state).toBe('ok');
  });

  it('filters superseded failure atoms', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed: PipelineErrorStateSourceAtom = {
      ...failedAtom({
        pipelineId: 'pipeline-1',
        cause: 'budget-overflow: 1 > 0',
      }),
      superseded_by: ['some-other-atom'],
    };
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.state).toBe('ok');
  });

  it('returns state=failed even without a resolvable pipeline atom (partial chain)', () => {
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: 1 > 0',
    });
    const result = buildPipelineErrorState([failed], 'pipeline-1', NOW);
    expect(result.state).toBe('failed');
    expect(result.category).toBe('budget-exceeded');
  });

  it('picks the earliest failure atom when more than one exists for the same pipeline', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const earlier = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'budget-overflow: 1 > 0',
      at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    });
    const later = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'schema-validation-failed: foo',
      at: new Date(NOW - 1 * 60 * 1000).toISOString(),
    });
    const result = buildPipelineErrorState([pipeline, earlier, later], 'pipeline-1', NOW);
    expect(result.category).toBe('budget-exceeded');
  });

  it('handles stage-output-persist-failed category cleanly', () => {
    const pipeline = pipelineAtom({ id: 'pipeline-1' });
    const failed = failedAtom({
      pipelineId: 'pipeline-1',
      cause: 'stage-output-persist-failed: write conflict on dispatch-result atom',
      failedStageName: 'dispatch-stage',
    });
    const result = buildPipelineErrorState([pipeline, failed], 'pipeline-1', NOW);
    expect(result.category).toBe('stage-output-persist-failed');
    expect(result.severity).toBe('critical');
    expect(result.suggested_action).toContain('AtomStore');
  });

  it('echoes the pipeline_id back even on a missing-atom synthesis', () => {
    const result = buildPipelineErrorState([], 'pipeline-xyz', NOW);
    expect(result.pipeline_id).toBe('pipeline-xyz');
  });

  it('computed_at is the ISO timestamp of the provided now', () => {
    const pinned = Date.parse('2026-05-11T15:30:00.000Z');
    const result = buildPipelineErrorState([], 'pipeline-1', pinned);
    expect(result.computed_at).toBe('2026-05-11T15:30:00.000Z');
  });
});
