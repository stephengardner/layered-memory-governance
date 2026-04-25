import { describe, it, expect } from 'vitest';
import type { PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters } from '../../../../src/runtime/actors/pr-fix/types.js';
import type { AtomId, PrFixObservationMeta, PrincipalId } from '../../../../src/substrate/types.js';
import { mkPrFixObservationAtom } from '../../../../src/runtime/actors/pr-fix/pr-fix-observation.js';

describe('PrFixActor types', () => {
  it('PrFixAction is a discriminated union of agent-loop-dispatch / pr-escalate', () => {
    const a: PrFixAction = { kind: 'agent-loop-dispatch', findings: [], planAtomId: 'plan-x' as AtomId, headBranch: 'feat/x' };
    const b: PrFixAction = { kind: 'pr-escalate', reason: 'CI failure' };
    expect(a.kind).toBe('agent-loop-dispatch');
    expect(b.kind).toBe('pr-escalate');
  });

  it('PrFixOutcome has fix-pushed / fix-failed / escalated variants', () => {
    const a: PrFixOutcome = { kind: 'fix-pushed', commitSha: 'abc', resolvedCommentIds: [], sessionAtomId: 's1' as AtomId };
    const b: PrFixOutcome = { kind: 'fix-failed', stage: 'verify-commit-sha', reason: 'mismatch', sessionAtomId: 's1' as AtomId };
    const c: PrFixOutcome = { kind: 'escalated', reason: 'arch' };
    expect([a.kind, b.kind, c.kind]).toEqual(['fix-pushed', 'fix-failed', 'escalated']);
  });
});

describe('mkPrFixObservationAtom', () => {
  const meta: PrFixObservationMeta = {
    pr_owner: 'o', pr_repo: 'r', pr_number: 1,
    head_branch: 'feat/x', head_sha: 'abc1234567890abcdef',
    cr_review_states: [],
    merge_state_status: null, mergeable: null,
    line_comment_count: 0, body_nit_count: 0,
    check_run_failure_count: 0, legacy_status_failure_count: 0,
    partial: false, classification: 'all-clean',
  };

  it('builds an L0 agent-observed atom with the expected metadata + chain', () => {
    const atom = mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta,
      priorObservationAtomId: 'pr-fix-obs-0' as AtomId,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    });
    expect(atom.type).toBe('pr-fix-observation');
    expect(atom.layer).toBe('L0');
    expect(atom.scope).toBe('project');
    expect(atom.principal_id).toBe('pr-fix-actor');
    expect(atom.provenance.kind).toBe('agent-observed');
    expect(atom.provenance.derived_from).toContain('pr-fix-obs-0');
    expect((atom.metadata as { pr_fix_observation: PrFixObservationMeta }).pr_fix_observation.classification).toBe('all-clean');
  });

  it('omits prior derived_from when no priorObservationAtomId given', () => {
    const atom = mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta,
      priorObservationAtomId: undefined,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    });
    expect(atom.provenance.derived_from).toEqual([]);
  });

  it('renderObservationContent returns a deterministic prose summary', () => {
    const content = (mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta,
      priorObservationAtomId: undefined,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    })).content;
    expect(content).toContain('o/r#1');
    expect(content).toContain('classification=all-clean');
  });
});
