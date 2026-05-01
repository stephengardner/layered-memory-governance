import { describe, expect, it } from 'vitest';
import {
  mkBrainstormOutputAtom,
  mkDispatchRecordAtom,
  mkPipelineAtom,
  mkPipelineStageEventAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineResumeAtom,
  mkPlanOutputAtoms,
  mkReviewReportAtom,
  mkSpecAtom,
  mkSpecOutputAtom,
  serializeStageOutput,
  MAX_STAGE_OUTPUT_CONTENT,
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

// ---------------------------------------------------------------------------
// Stage-output mint helpers (substrate-fix in this PR)
// ---------------------------------------------------------------------------

const STAGE_BASE_INPUT = {
  pipelineId: 'pipeline-abc' as AtomId,
  stageName: 'brainstorm-stage',
  principalId: 'cto-actor' as PrincipalId,
  correlationId: 'corr-1',
  now: NOW,
  derivedFrom: ['pipeline-abc' as AtomId, 'intent-1' as AtomId],
  value: { open_questions: ['x'], cost_usd: 0 },
} as const;

describe('mkBrainstormOutputAtom', () => {
  it('produces a brainstorm-output atom with provenance + metadata', () => {
    const atom = mkBrainstormOutputAtom(STAGE_BASE_INPUT);
    expect(atom.type).toBe('brainstorm-output');
    expect(atom.provenance.derived_from).toEqual([
      'pipeline-abc',
      'intent-1',
    ]);
    const meta = atom.metadata as Record<string, unknown>;
    expect(meta.pipeline_id).toBe('pipeline-abc');
    expect(meta.stage_name).toBe('brainstorm-stage');
    expect(meta.stage_output).toEqual({ open_questions: ['x'], cost_usd: 0 });
  });

  it('rejects empty derivedFrom (provenance violation)', () => {
    expect(() => mkBrainstormOutputAtom({
      ...STAGE_BASE_INPUT,
      derivedFrom: [],
    })).toThrow(/derivedFrom.*non-empty/);
  });

  it('produces a deterministic id rooted in pipelineId + correlationId', () => {
    const a = mkBrainstormOutputAtom(STAGE_BASE_INPUT);
    const b = mkBrainstormOutputAtom(STAGE_BASE_INPUT);
    expect(a.id).toBe(b.id);
    expect(String(a.id)).toBe('brainstorm-output-pipeline-abc-corr-1');
  });
});

describe('mkSpecOutputAtom', () => {
  it('produces a spec-output atom with the declared type', () => {
    const atom = mkSpecOutputAtom({
      ...STAGE_BASE_INPUT,
      stageName: 'spec-stage',
    });
    expect(atom.type).toBe('spec-output');
    expect(String(atom.id)).toBe('spec-output-pipeline-abc-corr-1');
  });

  it('rejects empty derivedFrom', () => {
    expect(() => mkSpecOutputAtom({ ...STAGE_BASE_INPUT, derivedFrom: [] }))
      .toThrow(/derivedFrom.*non-empty/);
  });
});

describe('mkReviewReportAtom', () => {
  it('produces a review-report atom with the declared type', () => {
    const atom = mkReviewReportAtom({
      ...STAGE_BASE_INPUT,
      stageName: 'review-stage',
      value: { audit_status: 'clean', findings: [], total_bytes_read: 0, cost_usd: 0 },
    });
    expect(atom.type).toBe('review-report');
    const meta = atom.metadata as Record<string, unknown>;
    expect((meta.stage_output as Record<string, unknown>).audit_status).toBe('clean');
  });

  it('rejects empty derivedFrom', () => {
    expect(() => mkReviewReportAtom({ ...STAGE_BASE_INPUT, derivedFrom: [] }))
      .toThrow(/derivedFrom.*non-empty/);
  });
});

describe('mkDispatchRecordAtom', () => {
  it('produces a dispatch-record atom with the declared type', () => {
    const atom = mkDispatchRecordAtom({
      ...STAGE_BASE_INPUT,
      stageName: 'dispatch-stage',
      value: {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
    });
    expect(atom.type).toBe('dispatch-record');
    const meta = atom.metadata as Record<string, unknown>;
    expect((meta.stage_output as Record<string, unknown>).dispatch_status).toBe('completed');
  });

  it('rejects empty derivedFrom', () => {
    expect(() => mkDispatchRecordAtom({ ...STAGE_BASE_INPUT, derivedFrom: [] }))
      .toThrow(/derivedFrom.*non-empty/);
  });
});

describe('mkPlanOutputAtoms', () => {
  // Minimal plan-stage payload that matches the planEntrySchema in
  // examples/planning-stages/plan/index.ts. Two plans in the same
  // payload exercise the per-entry-index uniqueness in the deterministic
  // id format.
  const TWO_PLAN_PAYLOAD = {
    plans: [
      {
        title: 'first plan',
        body: 'plan body 1',
        derived_from: ['intent-1', 'dev-canon-foo'],
        principles_applied: ['dev-canon-foo'],
        alternatives_rejected: [{ option: 'alt-x', reason: 'less precise' }],
        what_breaks_if_revisit: 'nothing material',
        confidence: 0.85,
        delegation: {
          sub_actor_principal_id: 'code-author',
          reason: 'implements the plan',
          implied_blast_radius: 'framework',
        },
      },
      {
        title: 'second plan',
        body: 'plan body 2',
        derived_from: ['intent-1'],
        principles_applied: [],
        alternatives_rejected: [],
        what_breaks_if_revisit: 'nothing material',
        confidence: 0.7,
        delegation: {
          sub_actor_principal_id: 'auditor-actor',
          reason: 'audit-only',
          implied_blast_radius: 'none',
        },
      },
    ],
    cost_usd: 0,
  };

  const PLAN_INPUT = {
    pipelineId: 'pipeline-abc' as AtomId,
    principalId: 'cto-actor' as PrincipalId,
    correlationId: 'corr-1',
    now: NOW,
    derivedFrom: ['pipeline-abc' as AtomId, 'spec-output-pipeline-abc-corr-1' as AtomId],
    value: TWO_PLAN_PAYLOAD,
  };

  it('mints one plan atom per plans-array entry with type=plan + plan_state=proposed', () => {
    const atoms = mkPlanOutputAtoms(PLAN_INPUT);
    expect(atoms.length).toBe(2);
    expect(atoms[0]!.type).toBe('plan');
    expect(atoms[0]!.plan_state).toBe('proposed');
    expect(atoms[1]!.type).toBe('plan');
    expect(atoms[1]!.plan_state).toBe('proposed');
  });

  it('chains derived_from with [pipelineId, ...priorOutputs, ...entry.derived_from]', () => {
    const atoms = mkPlanOutputAtoms(PLAN_INPUT);
    // First plan cites intent-1 and dev-canon-foo; chain prepends the
    // runner-supplied derivedFrom to those.
    expect(atoms[0]!.provenance.derived_from).toEqual([
      'pipeline-abc',
      'spec-output-pipeline-abc-corr-1',
      'intent-1',
      'dev-canon-foo',
    ]);
    expect(atoms[1]!.provenance.derived_from).toEqual([
      'pipeline-abc',
      'spec-output-pipeline-abc-corr-1',
      'intent-1',
    ]);
  });

  it('uses a deterministic id including the per-entry index', () => {
    const a = mkPlanOutputAtoms(PLAN_INPUT);
    const b = mkPlanOutputAtoms(PLAN_INPUT);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[1]!.id).toBe(b[1]!.id);
    expect(String(a[0]!.id)).toContain('first-plan');
    expect(String(a[0]!.id)).toContain('-0');
    expect(String(a[1]!.id)).toContain('second-plan');
    expect(String(a[1]!.id)).toContain('-1');
    expect(a[0]!.id).not.toBe(a[1]!.id);
  });

  it('preserves single-pass plan-atom shape (title in metadata + L1 layer + scope=project)', () => {
    const atoms = mkPlanOutputAtoms(PLAN_INPUT);
    const atom = atoms[0]!;
    expect(atom.layer).toBe('L1');
    expect(atom.scope).toBe('project');
    expect(atom.taint).toBe('clean');
    const meta = atom.metadata as Record<string, unknown>;
    expect(meta.title).toBe('first plan');
    expect(meta.principles_applied).toEqual(['dev-canon-foo']);
    expect(meta.what_breaks_if_revisit).toBe('nothing material');
    expect(meta.delegation).toEqual({
      sub_actor_principal_id: 'code-author',
      reason: 'implements the plan',
      implied_blast_radius: 'framework',
    });
  });

  it('returns [] when value is non-object / missing plans / empty plans', () => {
    expect(mkPlanOutputAtoms({ ...PLAN_INPUT, value: null })).toEqual([]);
    expect(mkPlanOutputAtoms({ ...PLAN_INPUT, value: 'not an object' })).toEqual([]);
    expect(mkPlanOutputAtoms({ ...PLAN_INPUT, value: {} })).toEqual([]);
    expect(mkPlanOutputAtoms({ ...PLAN_INPUT, value: { plans: [] } })).toEqual([]);
  });

  it('rejects empty derivedFrom (provenance violation)', () => {
    expect(() => mkPlanOutputAtoms({ ...PLAN_INPUT, derivedFrom: [] }))
      .toThrow(/derivedFrom.*non-empty/);
  });
});

describe('serializeStageOutput', () => {
  it('returns the JSON-stringified value for small inputs', () => {
    const result = serializeStageOutput({ a: 1, b: 'two' });
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'two' });
  });

  it('caps at MAX_STAGE_OUTPUT_CONTENT and appends a visible truncation marker', () => {
    const huge = { x: 'y'.repeat(MAX_STAGE_OUTPUT_CONTENT * 2) };
    const result = serializeStageOutput(huge);
    expect(result.length).toBeLessThanOrEqual(MAX_STAGE_OUTPUT_CONTENT);
    expect(result).toContain('[stage-output truncated');
  });

  it('returns a typeof marker for non-representable values', () => {
    // JSON.stringify(undefined) is undefined; the helper must surface
    // the typeof so audit consumers see why content is empty.
    expect(serializeStageOutput(undefined)).toContain('typeof=undefined');
  });

  it('returns an explicit marker for a circular reference', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeStageOutput(circular)).toBe('[stage-output not JSON-serialisable]');
  });
});
