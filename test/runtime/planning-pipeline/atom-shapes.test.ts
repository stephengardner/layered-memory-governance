import { describe, expect, it } from 'vitest';
import {
  mkPipelineAtom,
  mkPipelineStageEventAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineResumeAtom,
  mkSpecAtom,
} from '../../../src/runtime/planning-pipeline/atom-shapes.js';
import type { AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;

describe('mkPipelineAtom', () => {
  it('produces a pipeline atom with pipeline_state as top-level field', () => {
    const atom = mkPipelineAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      seedAtomIds: ['intent-1' as AtomId],
      stagePolicyAtomId: 'pol-planning-pipeline-stages-default',
      mode: 'substrate-deep',
    });
    expect(atom.type).toBe('pipeline');
    expect(atom.pipeline_state).toBe('pending');
    expect((atom.metadata as { mode: string }).mode).toBe('substrate-deep');
    expect(atom.provenance.derived_from).toEqual(['intent-1']);
  });

  it('rejects missing seedAtomIds (provenance violation)', () => {
    expect(() => mkPipelineAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      seedAtomIds: [],
      stagePolicyAtomId: 'pol-x',
      mode: 'substrate-deep',
    })).toThrow(/seedAtomIds.*non-empty/);
  });

  it('rejects an unknown mode literal', () => {
    expect(() => mkPipelineAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      seedAtomIds: ['intent-1' as AtomId],
      stagePolicyAtomId: 'pol-x',
      mode: 'wat' as unknown as 'substrate-deep',
    })).toThrow();
  });
});

describe('mkPipelineAuditFindingAtom', () => {
  it('rejects severity outside the enum', () => {
    expect(() => mkPipelineAuditFindingAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'spec-stage',
      principalId: 'pipeline-auditor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      severity: 'urgent' as never,
      category: 'citation-unverified',
      message: 'whatever',
      citedAtomIds: [],
      citedPaths: [],
    })).toThrow(/severity/);
  });

  it('caps cited_paths at 256 entries', () => {
    const tooMany = Array.from({ length: 1000 }, (_, i) => `path-${i}.ts`);
    expect(() => mkPipelineAuditFindingAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'spec-stage',
      principalId: 'pipeline-auditor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      severity: 'critical',
      category: 'citation-unverified',
      message: 'too many cites',
      citedAtomIds: [],
      citedPaths: tooMany,
    })).toThrow(/cited_paths.*256/);
  });

  it('caps cited_atom_ids symmetrically at 256 entries', () => {
    const tooMany = Array.from({ length: 1000 }, (_, i) => `atom-${i}` as AtomId);
    expect(() => mkPipelineAuditFindingAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'spec-stage',
      principalId: 'pipeline-auditor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      severity: 'critical',
      category: 'citation-unverified',
      message: 'too many atom ids',
      citedAtomIds: tooMany,
      citedPaths: [],
    })).toThrow(/cited_atom_ids.*256/);
  });
});

describe('mkSpecAtom', () => {
  it('emits a spec atom with required prose-shape metadata', () => {
    const atom = mkSpecAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'spec-author' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      derivedFrom: ['brainstorm-1' as AtomId],
      goal: 'ship the thing',
      body: '# Spec\n...',
      citedPaths: ['src/x.ts'],
      citedAtomIds: ['inv-kill-switch-first' as AtomId],
      alternativesRejected: [{ option: 'no', reason: 'no' }],
      auditStatus: 'unchecked',
    });
    expect(atom.type).toBe('spec');
    expect((atom.metadata as { audit_status: string }).audit_status).toBe('unchecked');
  });

  it('rejects missing derivedFrom (provenance violation)', () => {
    expect(() => mkSpecAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'spec-author' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      derivedFrom: [],
      goal: 'g',
      body: 'b',
      citedPaths: [],
      citedAtomIds: [],
      alternativesRejected: [],
      auditStatus: 'unchecked',
    })).toThrow(/derivedFrom.*non-empty/);
  });
});

describe('mkPipelineStageEventAtom', () => {
  it('records an enter transition', () => {
    const atom = mkPipelineStageEventAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'spec-stage',
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'enter',
      durationMs: 0,
      costUsd: 0,
    });
    expect(atom.type).toBe('pipeline-stage-event');
    expect((atom.metadata as { transition: string }).transition).toBe('enter');
  });

  it('rejects an unknown transition literal', () => {
    expect(() => mkPipelineStageEventAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'spec-stage',
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'wat' as never,
      durationMs: 0,
      costUsd: 0,
    })).toThrow();
  });
});

describe('mkPipelineFailedAtom', () => {
  it('records the full chain on rollback', () => {
    const atom = mkPipelineFailedAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      failedStageName: 'review-stage',
      failedStageIndex: 3,
      cause: 'critical finding',
      chain: ['brainstorm-1' as AtomId, 'spec-1' as AtomId],
      recoveryHint: 're-run from spec-stage',
    });
    expect(atom.type).toBe('pipeline-failed');
    expect((atom.metadata as { chain: ReadonlyArray<string> }).chain).toEqual(['brainstorm-1', 'spec-1']);
  });
});

describe('mkPipelineResumeAtom', () => {
  it('lifts an HIL pause with operator attribution', () => {
    const atom = mkPipelineResumeAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      principalId: 'operator-principal' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      stageName: 'review-stage',
      resumerPrincipalId: 'operator-principal' as PrincipalId,
    });
    expect(atom.type).toBe('pipeline-resume');
    expect((atom.metadata as { stage_name: string }).stage_name).toBe('review-stage');
    expect((atom.metadata as { resumer_principal_id: string }).resumer_principal_id).toBe('operator-principal');
  });
});

describe('atom id determinism', () => {
  it('produces the same id for the same correlation-id namespace', () => {
    const args = {
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'spec-stage',
      principalId: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'enter' as const,
      durationMs: 0,
      costUsd: 0,
    };
    const a = mkPipelineStageEventAtom(args);
    const b = mkPipelineStageEventAtom(args);
    expect(a.id).toBe(b.id);
  });
});
