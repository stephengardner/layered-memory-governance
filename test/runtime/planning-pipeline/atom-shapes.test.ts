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
  projectStageOutputForMetadata,
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

  // Killer-pipeline transitions: canon-bound, canon-audit-complete,
  // agent-turn. These extend the substrate's transition vocabulary so an
  // agentic stage adapter can record (a) which canon directives it loaded
  // before invoking its agent loop, (b) the verdict + findings of the
  // post-output canon-audit checkpoint, and (c) per-LLM-call breadcrumbs
  // pointing at the agent-turn atoms the AgentLoopAdapter wrote during
  // the run. Mirrors the existing transition-event shape; no new
  // top-level Atom field, just metadata extensions.
  it('records a canon-bound transition with canon_atom_ids metadata', () => {
    const atom = mkPipelineStageEventAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'brainstorm-stage',
      principalId: 'brainstorm-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'canon-bound',
      durationMs: 50,
      costUsd: 0,
      canonAtomIds: [
        'dev-deep-planning-pipeline' as AtomId,
        'dev-implementation-canon-audit-loop' as AtomId,
      ],
    });
    expect(atom.type).toBe('pipeline-stage-event');
    expect((atom.metadata as { transition: string }).transition).toBe('canon-bound');
    expect(
      (atom.metadata as { canon_atom_ids: ReadonlyArray<string> }).canon_atom_ids,
    ).toEqual([
      'dev-deep-planning-pipeline',
      'dev-implementation-canon-audit-loop',
    ]);
  });

  it('records a canon-audit-complete transition with verdict + findings', () => {
    const atom = mkPipelineStageEventAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'brainstorm-stage',
      principalId: 'brainstorm-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'canon-audit-complete',
      durationMs: 1200,
      costUsd: 0.42,
      canonAuditVerdict: 'approved',
      canonAuditFindings: [
        {
          severity: 'minor',
          category: 'redundant-citation',
          message: 'duplicate cite',
          cited_atom_ids: [],
          cited_paths: [],
        },
      ],
    });
    expect(
      (atom.metadata as { canon_audit_verdict: string }).canon_audit_verdict,
    ).toBe('approved');
    expect(
      (atom.metadata as { canon_audit_findings: ReadonlyArray<unknown> })
        .canon_audit_findings,
    ).toHaveLength(1);
  });

  it('records an agent-turn transition pointing at an agent-turn atom id', () => {
    const atom = mkPipelineStageEventAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'brainstorm-stage',
      principalId: 'brainstorm-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'agent-turn',
      durationMs: 4200,
      costUsd: 0.18,
      agentTurnAtomId: 'agent-turn-abc' as AtomId,
      turnIndex: 3,
    });
    expect(
      (atom.metadata as { agent_turn_atom_id: string }).agent_turn_atom_id,
    ).toBe('agent-turn-abc');
    expect((atom.metadata as { turn_index: number }).turn_index).toBe(3);
  });

  it('legacy transitions still mint with no killer-pipeline metadata', () => {
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
    expect(
      (atom.metadata as { canon_atom_ids?: ReadonlyArray<string> }).canon_atom_ids,
    ).toBeUndefined();
    expect(
      (atom.metadata as { canon_audit_verdict?: string }).canon_audit_verdict,
    ).toBeUndefined();
    expect(
      (atom.metadata as { agent_turn_atom_id?: string }).agent_turn_atom_id,
    ).toBeUndefined();
  });

  it('caps canonAtomIds at MAX_CITED_LIST', () => {
    // 257 ids exceeds the cap. A runaway canon load (e.g. a misconfigured
    // applicable-canon query) must not balloon a single event atom past
    // sane sizes.
    const tooMany = Array.from({ length: 257 }, (_v, i) => `canon-${i}` as AtomId);
    expect(() =>
      mkPipelineStageEventAtom({
        pipelineId: 'pipeline-abc' as AtomId,
        stageName: 'brainstorm-stage',
        principalId: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr-1',
        now: NOW,
        transition: 'canon-bound',
        durationMs: 50,
        costUsd: 0,
        canonAtomIds: tooMany,
      }),
    ).toThrow(/canon_atom_ids/);
  });

  it('fails closed when canon-bound has no canonAtomIds field at all (defined-but-empty is OK)', () => {
    // canon-bound REQUIRES canonAtomIds defined; an absent field is a
    // half-formed mint. An empty list is a legitimate state (the
    // principal has no applicable canon at this scope) and is allowed.
    expect(() =>
      mkPipelineStageEventAtom({
        pipelineId: 'pipeline-abc' as AtomId,
        stageName: 'brainstorm-stage',
        principalId: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr-1',
        now: NOW,
        transition: 'canon-bound',
        durationMs: 50,
        costUsd: 0,
      }),
    ).toThrow(/canon-bound.*canon_atom_ids/);
  });

  it('accepts canon-bound with an empty canonAtomIds list', () => {
    const atom = mkPipelineStageEventAtom({
      pipelineId: 'pipeline-abc' as AtomId,
      stageName: 'brainstorm-stage',
      principalId: 'brainstorm-actor' as PrincipalId,
      correlationId: 'corr-1',
      now: NOW,
      transition: 'canon-bound',
      durationMs: 50,
      costUsd: 0,
      canonAtomIds: [],
    });
    expect(
      (atom.metadata as { canon_atom_ids: ReadonlyArray<string> }).canon_atom_ids,
    ).toEqual([]);
  });

  it('fails closed when canon-audit-complete has no verdict', () => {
    expect(() =>
      mkPipelineStageEventAtom({
        pipelineId: 'pipeline-abc' as AtomId,
        stageName: 'brainstorm-stage',
        principalId: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr-1',
        now: NOW,
        transition: 'canon-audit-complete',
        durationMs: 50,
        costUsd: 0,
      }),
    ).toThrow(/canon-audit-complete.*canon_audit_verdict/);
  });

  it('fails closed when agent-turn lacks agentTurnAtomId or turnIndex', () => {
    expect(() =>
      mkPipelineStageEventAtom({
        pipelineId: 'pipeline-abc' as AtomId,
        stageName: 'brainstorm-stage',
        principalId: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr-1',
        now: NOW,
        transition: 'agent-turn',
        durationMs: 50,
        costUsd: 0,
        turnIndex: 0,
      }),
    ).toThrow(/agent-turn.*agent_turn_atom_id and turn_index/);
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

  it('produces a deterministic id rooted in pipelineId + stage slug + correlationId', () => {
    const a = mkBrainstormOutputAtom(STAGE_BASE_INPUT);
    const b = mkBrainstormOutputAtom(STAGE_BASE_INPUT);
    expect(a.id).toBe(b.id);
    // Stage slug appears between pipelineId and correlationId so two
    // stages emitting the same atom_type within one pipeline get
    // distinct ids (see "stage-id collision avoidance" test below).
    expect(String(a.id)).toBe('brainstorm-output-pipeline-abc-brainstorm-stage-corr-1');
  });

  it('avoids id collision when two stages emit the same atom_type within one pipeline', () => {
    // Two distinct stages can declare atom_type='brainstorm-output'
    // (e.g. an org-ceiling deployment running two brainstorm variants
    // back-to-back); the stage-slug component of the id keeps them
    // from colliding on host.atoms.put.
    const stageA = mkBrainstormOutputAtom({
      ...STAGE_BASE_INPUT,
      stageName: 'brainstorm-stage',
    });
    const stageB = mkBrainstormOutputAtom({
      ...STAGE_BASE_INPUT,
      stageName: 'brainstorm-stage-org-variant',
    });
    expect(stageA.id).not.toBe(stageB.id);
  });
});

describe('mkSpecOutputAtom', () => {
  it('produces a spec-output atom with the declared type', () => {
    const atom = mkSpecOutputAtom({
      ...STAGE_BASE_INPUT,
      stageName: 'spec-stage',
    });
    expect(atom.type).toBe('spec-output');
    expect(String(atom.id)).toBe('spec-output-pipeline-abc-spec-stage-corr-1');
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

  it('threads extraMetadata onto every minted plan atom below the plan-shape keys', () => {
    // The runner forwards StageOutput.extraMetadata into mkPlanOutputAtoms
    // so canon_directives_applied + tool_policy_principal_id (or any
    // other stage-runner stamp) lands on every plan atom in the
    // payload. The plan-shape keys (title, pipeline_id,
    // principles_applied, alternatives_rejected,
    // what_breaks_if_revisit, delegation) MUST shadow same-named keys
    // in extraMetadata; downstream readers depend on the shape and a
    // misbehaving stage cannot smuggle a fake title or principles list.
    const atoms = mkPlanOutputAtoms({
      ...PLAN_INPUT,
      extraMetadata: {
        canon_directives_applied: ['dev-foo', 'dev-bar'],
        tool_policy_principal_id: 'cto-actor',
        // Same-name shadow attempts; plan shape must win.
        title: 'malicious title',
        principles_applied: ['malicious-principle'],
      },
    });
    for (const atom of atoms) {
      const meta = atom.metadata as Record<string, unknown>;
      expect(meta.canon_directives_applied).toEqual(['dev-foo', 'dev-bar']);
      expect(meta.tool_policy_principal_id).toBe('cto-actor');
    }
    // Plan-shape title is "first plan" / "second plan" from the
    // payload; the extraMetadata's malicious title does NOT replace it.
    expect((atoms[0]!.metadata as Record<string, unknown>).title)
      .toBe('first plan');
    expect((atoms[0]!.metadata as Record<string, unknown>).principles_applied)
      .toEqual(['dev-canon-foo']);
  });

  it('strips reserved plan-shape keys from extraMetadata even when the entry omits them', () => {
    // Regression: a plan entry without `delegation` produces
    // delegationMetadata={} in mkPlanOutputAtoms. A naive
    // spread-then-overwrite would NOT shadow an
    // extraMetadata.delegation in that case, leaking a stage-runner-
    // supplied delegation onto the plan atom that downstream dispatch
    // would then act on. Filtering at the merge site fences every
    // reserved key uniformly regardless of whether the plan-shape side
    // resolves to a populated object or an empty one.
    const NO_DELEGATION_PAYLOAD = {
      plans: [
        {
          title: 'no-delegation plan',
          body: 'body',
          derived_from: [],
          principles_applied: [],
          alternatives_rejected: [],
          what_breaks_if_revisit: 'nothing',
          confidence: 0.8,
          // No delegation field at all.
        },
      ],
      cost_usd: 0,
    };
    const atoms = mkPlanOutputAtoms({
      ...PLAN_INPUT,
      value: NO_DELEGATION_PAYLOAD,
      extraMetadata: {
        // Stage runner attempts to inject a fake delegation onto a
        // plan that has none. Filter MUST drop this so dispatch never
        // sees a stage-supplied delegation target.
        delegation: {
          sub_actor_principal_id: 'malicious-actor',
          reason: 'should never appear',
          implied_blast_radius: 'critical',
        },
        // Other reserved keys also dropped.
        title: 'fake title',
        pipeline_id: 'fake-pipeline',
        principles_applied: ['fake-principle'],
        alternatives_rejected: ['fake-alt'],
        what_breaks_if_revisit: 'fake breakage',
        // Non-reserved keys pass through.
        canon_directives_applied: ['dev-real'],
      },
    });
    expect(atoms).toHaveLength(1);
    const meta = atoms[0]!.metadata as Record<string, unknown>;
    expect(meta.delegation).toBeUndefined();
    expect(meta.title).toBe('no-delegation plan');
    expect(meta.pipeline_id).toBe(PLAN_INPUT.pipelineId);
    expect(meta.principles_applied).toEqual([]);
    expect(meta.alternatives_rejected).toEqual([]);
    expect(meta.what_breaks_if_revisit).toBe('nothing');
    // Non-reserved key passes through unchanged.
    expect(meta.canon_directives_applied).toEqual(['dev-real']);
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

describe('projectStageOutputForMetadata', () => {
  it('round-trips JSON-safe values through JSON.parse so metadata stays structured', () => {
    const projected = projectStageOutputForMetadata({ a: 1, b: ['x', 'y'] });
    expect(projected).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('returns the marker string for non-serialisable values (no throw)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(projectStageOutputForMetadata(circular)).toBe('[stage-output not JSON-serialisable]');
  });

  it('returns the marker string for unrepresentable values', () => {
    const projected = projectStageOutputForMetadata(undefined);
    expect(typeof projected).toBe('string');
    expect(projected).toContain('typeof=undefined');
  });

  it('returns the truncation-marker string when the serialized value exceeds the cap', () => {
    const huge = { x: 'y'.repeat(MAX_STAGE_OUTPUT_CONTENT * 2) };
    const projected = projectStageOutputForMetadata(huge);
    // The truncation case bypasses JSON.parse (the truncated string
    // is no longer valid JSON) and surfaces the marker directly so
    // audit consumers see the truncation explicitly.
    expect(typeof projected).toBe('string');
    expect(projected).toContain('[stage-output truncated');
  });

  it('mint helpers route metadata.stage_output through the projection (size-cap regression)', () => {
    // The mint helpers bound metadata via projectStageOutputForMetadata
    // so a runaway-large LLM emission cannot grow an atom's metadata
    // field unchecked. Substrate-side guard: even if a stage adapter
    // emits a > 256KB value, the persisted atom's metadata stays
    // bounded by the cap.
    const huge = { x: 'y'.repeat(MAX_STAGE_OUTPUT_CONTENT * 2) };
    const atom = mkBrainstormOutputAtom({
      ...STAGE_BASE_INPUT,
      value: huge,
    });
    const meta = atom.metadata as Record<string, unknown>;
    // The truncation branch produces a string marker; the mint helper
    // surfaces it under metadata.stage_output as-is.
    expect(typeof meta.stage_output).toBe('string');
    expect(meta.stage_output).toContain('[stage-output truncated');
  });
});
