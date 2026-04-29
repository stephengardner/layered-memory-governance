# Deep Planning Pipeline Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per `dev-implementation-canon-audit-loop`, every substantive task carries a canon-audit subagent step between "tests pass" and "commit"; per `dev-coderabbit-cli-pre-push`, the final task is a CR CLI gate before push.

**Goal:** Replace the single-pass `HostLlmPlanningJudgment` with a pluggable, atom-projected, per-stage-audited planning pipeline so substantive engineering deliverables route through brainstorm, spec, plan, review, and dispatch stages with verification gates between each, while tactical fixes keep the existing single-pass path for cost amortization.

**Architecture:** New `src/runtime/planning-pipeline/` module (mechanism-only per `dev-substrate-not-prescription`) carrying the `PlanningStage` interface, the `PipelineRunner` state machine, atom-shape definitions, and the canon policy parsers. Reuses `SubActorRegistry` (`src/runtime/actor-message/sub-actor-registry.ts`) for stage-actor invocation, the AtomStore as a state machine (mirroring `intent-approve.ts`), the existing Auditor for findings, and the existing kill-switch via `host.scheduler.killswitchCheck()` per `inv-kill-switch-first`. Reference stage adapters (brainstorm, spec, plan, review, dispatch) live in `examples/planning-stages/` so framework code stays substrate-pure.

**Tech Stack:** TypeScript (strict, ES modules, NodeNext) consistent with `src/`. `zod` for stage output schemas (existing dep, used by `PLAN_CLASSIFY` / `PLAN_DRAFT`). Existing Host substrate (AtomStore, Auditor, Notifier, Scheduler, Clock, LLM). No new runtime deps. No new Host sub-interface (single-consumer rule per `arch-host-interface-boundary`).

**Spec source of truth:** `docs/superpowers/specs/2026-04-28-deep-planning-pipeline-design.md` (committed in this worktree).

**Branch:** `feat/deep-planning-pipeline` (off main; spec already committed at the worktree HEAD).

**Discipline:**
- Every task carries a "Security + correctness considerations" subsection BEFORE the implementation steps. Walk through it BEFORE writing code, not after CR flags it (per memory feedback `feedback_security_correctness_at_write_time`).
- Every substantive task dispatches a canon-compliance auditor sub-agent between "tests pass" and "commit" per `dev-implementation-canon-audit-loop`.
- Pre-push CR CLI gate as final task per `dev-coderabbit-cli-pre-push`.
- Substrate purity: framework code in `src/runtime/planning-pipeline/` stays mechanism-only; all concrete stage adapters live in `examples/planning-stages/`. No concrete prompt or schema in `src/` beyond the abstract Stage interface.
- Indie-floor + org-ceiling fit: every task design choice auditable against spec section 0 + section 6.5 (BYO stages).
- Threat model integrity: tasks touching the runner, auditor wiring, or dispatch stage MUST run canon-audit with spec section 14 threat model passed in as context.

---

## File Structure

**Substrate (framework, mechanism-only per `dev-substrate-not-prescription`):**
- Modify: `src/substrate/types.ts` -- add `'spec'`, `'pipeline'`, `'pipeline-stage-event'`, `'pipeline-audit-finding'`, `'pipeline-failed'`, `'pipeline-resume'` to the `AtomType` union.
- Create: `src/runtime/planning-pipeline/types.ts` -- `PlanningStage<TIn,TOut>`, `StageInput`, `StageOutput`, `AuditFinding`, `RetryStrategy`, `PipelineState` discriminator, atom-meta interfaces.
- Create: `src/runtime/planning-pipeline/stage.ts` -- pure interface module (re-exports + JSDoc; no execution).
- Create: `src/runtime/planning-pipeline/atom-shapes.ts` -- atom-builder helpers (`mkPipelineAtom`, `mkPipelineStageEventAtom`, `mkPipelineAuditFindingAtom`, `mkPipelineFailedAtom`, `mkPipelineResumeAtom`, `mkSpecAtom`) + zod validators per atom type.
- Create: `src/runtime/planning-pipeline/runner.ts` -- `runPipeline(stages, host, opts)` state machine; budget enforcement; kill-switch poll between stages; pipeline-state projection.
- Create: `src/runtime/planning-pipeline/policy.ts` -- canon policy parsers (`readPipelineStagesPolicy`, `readPipelineStageHilPolicy`, `readPipelineDefaultModePolicy`, `readPipelineStageCostCapPolicy`).
- Create: `src/runtime/planning-pipeline/index.ts` -- barrel export.
- Modify: `src/runtime/actor-message/index.ts` -- add re-export of `runPipeline` and pipeline types under a `planning-pipeline` subpath OR via the actor-message barrel (whichever fits the existing barrel pattern; verified during Task 3).

**Reference stage adapters (`examples/`, NOT in `src/`, per `dev-substrate-not-prescription`):**
- Create: `examples/planning-stages/brainstorm/index.ts` -- ref `BrainstormStage` impl + invoker.
- Create: `examples/planning-stages/brainstorm/test/brainstorm-stage.test.ts`.
- Create: `examples/planning-stages/spec/index.ts` -- ref `SpecStage` impl emitting a `spec` atom.
- Create: `examples/planning-stages/spec/test/spec-stage.test.ts`.
- Create: `examples/planning-stages/plan/index.ts` -- ref `PlanStage` impl emitting a `plan` atom matching `PLAN_DRAFT`.
- Create: `examples/planning-stages/plan/test/plan-stage.test.ts`.
- Create: `examples/planning-stages/review/index.ts` -- ref `ReviewStage` dispatching the registered `pipeline-auditor` sub-actor; mints `pipeline-audit-finding` atoms.
- Create: `examples/planning-stages/review/test/review-stage.test.ts`.
- Create: `examples/planning-stages/dispatch/index.ts` -- ref `DispatchStage` handing off to existing `runDispatchTick`.
- Create: `examples/planning-stages/dispatch/test/dispatch-stage.test.ts`.

**Driver wiring:**
- Modify: `scripts/run-cto-actor.mjs` -- add `--mode=substrate-deep` flag activating the pipeline path; default mode unchanged.
- Create: `scripts/bootstrap-deep-planning-pipeline-canon.mjs` -- operator-seeded canon atoms (default-stage policy + per-stage HIL policies + L3 directive).

**Tests (substrate + integration):**
- Create: `test/runtime/planning-pipeline/runner.test.ts` -- state machine unit tests.
- Create: `test/runtime/planning-pipeline/atom-shapes.test.ts` -- atom-builder + zod validator tests.
- Create: `test/runtime/planning-pipeline/policy.test.ts` -- canon policy parser tests.
- Create: `test/runtime/planning-pipeline/end-to-end.test.ts` -- 5-stage integration on `MemoryHost`.

---

## Task 1: Atom-type union extension

**Files:**
- Modify: `src/substrate/types.ts:59-115` (extend `AtomType` union; non-breaking append)
- Test: `test/substrate/types.test.ts` (add to existing file if present; otherwise create)

**Security + correctness considerations:**
- Append-only union extension; no existing atom-type is renamed or removed. Back-compat preserved: every existing consumer narrows by string literal and continues compiling.
- The new types name shapes that the runner / atom-builders will validate; the union itself imposes no semantic constraint beyond "this is a recognized atom type." Schema-level validation lives in atom-shapes (Task 2).
- Naming discipline: `pipeline-*` prefix prevents collision with the existing `plan` / `plan-approval-vote` / `plan-merge-settled` atom types per `dev-canon-is-strategic-not-tactical`. The single `spec` type is distinguished from PLAN_DRAFT by name only; downstream consumers must not assume `spec.confidence` schema parity.
- No taint cascade implications: union membership is purely lexical.

- [ ] **Step 1: Write the failing test**

Create `test/substrate/types.test.ts` (or append to existing):

```ts
import { describe, expect, it } from 'vitest';
import type { AtomType } from '../../src/substrate/types.js';

describe('AtomType union (planning-pipeline extension)', () => {
  it('accepts the six new pipeline atom types', () => {
    const types: AtomType[] = [
      'spec',
      'pipeline',
      'pipeline-stage-event',
      'pipeline-audit-finding',
      'pipeline-failed',
      'pipeline-resume',
    ];
    expect(types.length).toBe(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/substrate/types.test.ts`
Expected: FAIL with TS error like `Type '"spec"' is not assignable to type 'AtomType'.`

- [ ] **Step 3: Implement minimal**

In `src/substrate/types.ts:59-115`, append after the existing `'agent-turn'` line:

```ts
  | 'agent-turn'
  // Deep planning pipeline atom types. The six types are emitted by
  // src/runtime/planning-pipeline/ and consumed by reference stage
  // adapters in examples/planning-stages/. The 'spec' type is a
  // looser-shaped sibling of 'plan' (prose-shaped per the superpowers
  // spec convention); the 'pipeline-*' prefix groups runtime state
  // and audit projection atoms together so a Console filter can
  // surface a single pipeline run as a coherent timeline.
  | 'spec'
  | 'pipeline'
  | 'pipeline-stage-event'
  | 'pipeline-audit-finding'
  | 'pipeline-failed'
  | 'pipeline-resume';
```

(Replace the trailing semicolon on the prior line with `;` if needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/substrate/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Canon-audit subagent**

Dispatch a canon-compliance auditor sub-agent (`general-purpose` subagent_type) with prompt:

> Review the diff at `src/substrate/types.ts` (atom-type union extension) and the new test against the canon directives `dev-substrate-not-prescription`, `arch-atomstore-source-of-truth`, `dev-canon-is-strategic-not-tactical`. Confirm: (a) the union extension is mechanism-only with no policy-shape leak; (b) the prefix discipline keeps `pipeline-*` distinct from existing `plan-*` types; (c) the spec atom name does not foreclose a future PLAN_DRAFT consolidation. Return Approved or Issues Found.

Iterate until Approved.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/substrate/types.ts test/substrate/types.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): extend AtomType for pipeline atom types"
```

---

## Task 2: Atom-shape builders + zod validators

**Files:**
- Create: `src/runtime/planning-pipeline/atom-shapes.ts`
- Test: `test/runtime/planning-pipeline/atom-shapes.test.ts`

**Security + correctness considerations:**
- Schema-validated atom-builder pattern lifted from `src/runtime/actor-message/inbox-reader.ts` and the inline atom builder in `plan-dispatch.ts:295-326` (extract-at-N=2 per `dev-dry-extract-at-second-duplication`).
- Every atom carries full provenance per the canon "every atom must carry provenance with a source chain" directive: each builder requires `derivedFrom`, `principalId`, and `correlationId` parameters; missing any is a TypeError at construction time, not a runtime drift.
- `pipeline_state` is a top-level field on the `pipeline` atom (mirrors the `plan_state` decision per `arch-plan-state-top-level-field`); it never lives under `metadata`. The builder enforces this at TS-type level by attaching `pipeline_state` only to the `pipeline` atom builder, not to `pipeline-stage-event` or `pipeline-failed` (those record state TRANSITIONS, not the state itself).
- Audit-finding builder validates severity is `'critical' | 'major' | 'minor'`, never a free string. Threat: an LLM-emitted stage that returns `severity: 'urgent'` would silently fall through a stringly-typed branch. zod `enum` validator rejects unknown literals.
- The `cited_paths` and `cited_atom_ids` arrays on `pipeline-audit-finding` are bounded (default cap 256 entries each) to defend against an LLM-emitted runaway list. The cap is a per-builder constant, not a canon atom (mechanism-only per `dev-substrate-not-prescription`); a future canon override is a forward-compat seam, not a v1 surface.
- All atom-id helpers must produce content-derived ids (sha-prefix patterns matching the existing `dispatch-escalation-${corrId}-${now}` shape in `plan-dispatch.ts:280`) so a re-run of the builder produces the same id and `host.atoms.put` enforces idempotency. NEVER use `Date.now()` alone; the correlation-id namespace is the load-bearing dedup key.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/planning-pipeline/atom-shapes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  mkPipelineAtom,
  mkPipelineStageEventAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
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
    expect(atom.metadata.mode).toBe('substrate-deep');
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
    expect(atom.metadata.audit_status).toBe('unchecked');
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
    expect(atom.metadata.transition).toBe('enter');
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
    expect(atom.metadata.chain).toEqual(['brainstorm-1', 'spec-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/planning-pipeline/atom-shapes.test.ts`
Expected: FAIL because `src/runtime/planning-pipeline/atom-shapes.ts` does not exist.

- [ ] **Step 3: Implement minimal**

Create `src/runtime/planning-pipeline/atom-shapes.ts` with:

```ts
/**
 * Atom-shape builders for the deep planning pipeline.
 *
 * Each builder produces an Atom matching the canon "every atom must
 * carry provenance with a source chain" directive. Schema validation
 * via zod runs at construction time, NOT at host.atoms.put time, so
 * a malformed shape is caught at the call site (in the runner or a
 * stage adapter) rather than after the write attempt.
 *
 * Mechanism-only per dev-substrate-not-prescription: this module
 * declares NO concrete prompt, schema text, or stage ordering. Stage
 * adapters in examples/planning-stages/ author the prose; this module
 * just stamps atoms.
 */

import { z } from 'zod';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';

export const PIPELINE_STATE_VALUES = [
  'pending',
  'running',
  'hil-paused',
  'failed',
  'completed',
] as const;
export type PipelineStateLabel = typeof PIPELINE_STATE_VALUES[number];

const SEVERITY = z.enum(['critical', 'major', 'minor']);
const TRANSITION = z.enum(['enter', 'exit-success', 'exit-failure', 'hil-pause', 'hil-resume']);
const AUDIT_STATUS = z.enum(['unchecked', 'clean', 'findings']);
const MODE = z.enum(['single-pass', 'substrate-deep']);

const MAX_CITED_LIST = 256;

const auditFindingSchema = z.object({
  pipelineId: z.string(),
  stageName: z.string().min(1),
  principalId: z.string().min(1),
  correlationId: z.string().min(1),
  now: z.string().min(1),
  severity: SEVERITY,
  category: z.string().min(1),
  message: z.string().min(1),
  citedAtomIds: z.array(z.string()).max(MAX_CITED_LIST, `cited_atom_ids capped at ${MAX_CITED_LIST}`),
  citedPaths: z.array(z.string()).max(MAX_CITED_LIST, `cited_paths capped at ${MAX_CITED_LIST}`),
});

// Helper: stamp a baseline Atom shape with the fields the AtomStore
// requires. Builders override `id`, `type`, `content`, `metadata`,
// `provenance`, and (where applicable) `pipeline_state`.
function baseAtom(input: {
  id: AtomId;
  type: Atom['type'];
  content: string;
  principalId: PrincipalId;
  correlationId: string;
  now: Time;
  derivedFrom: ReadonlyArray<AtomId>;
  metadata: Record<string, unknown>;
}): Atom {
  return {
    schema_version: 1,
    id: input.id,
    content: input.content,
    type: input.type,
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'planning-pipeline',
        agent_id: String(input.principalId),
        session_id: input.correlationId,
      },
      derived_from: [...input.derivedFrom],
    },
    confidence: 1.0,
    created_at: input.now,
    last_reinforced_at: input.now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: input.principalId,
    taint: 'clean',
    metadata: input.metadata,
  };
}

// ---------------------------------------------------------------------------
// pipeline atom (root for a run; pipeline_state is top-level)
// ---------------------------------------------------------------------------

export interface MkPipelineAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  readonly stagePolicyAtomId: string;
  readonly mode: 'single-pass' | 'substrate-deep';
}

export function mkPipelineAtom(input: MkPipelineAtomInput): Atom {
  if (input.seedAtomIds.length === 0) {
    throw new Error('mkPipelineAtom: seedAtomIds must be non-empty (provenance directive)');
  }
  MODE.parse(input.mode);
  return {
    ...baseAtom({
      id: input.pipelineId,
      type: 'pipeline',
      content: `pipeline:${input.correlationId}`,
      principalId: input.principalId,
      correlationId: input.correlationId,
      now: input.now,
      derivedFrom: input.seedAtomIds,
      metadata: {
        stage_policy_atom_id: input.stagePolicyAtomId,
        mode: input.mode,
        started_at: input.now,
        completed_at: null,
        total_cost_usd: 0,
      },
    }),
    pipeline_state: 'pending' as never,
  } as Atom;
}

// ---------------------------------------------------------------------------
// spec atom (looser prose-shape sibling of plan)
// ---------------------------------------------------------------------------

export interface MkSpecAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly derivedFrom: ReadonlyArray<AtomId>;
  readonly goal: string;
  readonly body: string;
  readonly citedPaths: ReadonlyArray<string>;
  readonly citedAtomIds: ReadonlyArray<AtomId>;
  readonly alternativesRejected: ReadonlyArray<{ option: string; reason: string }>;
  readonly auditStatus: 'unchecked' | 'clean' | 'findings';
}

export function mkSpecAtom(input: MkSpecAtomInput): Atom {
  AUDIT_STATUS.parse(input.auditStatus);
  if (input.derivedFrom.length === 0) {
    throw new Error('mkSpecAtom: derivedFrom must be non-empty (provenance directive)');
  }
  if (input.citedPaths.length > MAX_CITED_LIST) {
    throw new Error(`mkSpecAtom: cited_paths capped at ${MAX_CITED_LIST}`);
  }
  if (input.citedAtomIds.length > MAX_CITED_LIST) {
    throw new Error(`mkSpecAtom: cited_atom_ids capped at ${MAX_CITED_LIST}`);
  }
  const id = `spec-${input.pipelineId}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'spec',
    content: input.body,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: input.derivedFrom,
    metadata: {
      goal: input.goal,
      cited_paths: [...input.citedPaths],
      cited_atom_ids: input.citedAtomIds.map(String),
      alternatives_rejected: input.alternativesRejected.map((a) => ({ ...a })),
      audit_status: input.auditStatus,
      pipeline_id: input.pipelineId,
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-stage-event atom (one per state transition)
// ---------------------------------------------------------------------------

export interface MkPipelineStageEventAtomInput {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly transition: 'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume';
  readonly durationMs: number;
  readonly costUsd: number;
  readonly outputAtomId?: AtomId;
}

export function mkPipelineStageEventAtom(input: MkPipelineStageEventAtomInput): Atom {
  TRANSITION.parse(input.transition);
  const id = `pipeline-stage-event-${input.pipelineId}-${input.stageName}-${input.transition}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-stage-event',
    content: `${input.stageName}:${input.transition}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId],
    metadata: {
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      transition: input.transition,
      duration_ms: input.durationMs,
      cost_usd: input.costUsd,
      ...(input.outputAtomId !== undefined ? { output_atom_id: input.outputAtomId } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-audit-finding atom (one per finding)
// ---------------------------------------------------------------------------

export interface MkPipelineAuditFindingAtomInput {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly citedAtomIds: ReadonlyArray<AtomId>;
  readonly citedPaths: ReadonlyArray<string>;
}

export function mkPipelineAuditFindingAtom(input: MkPipelineAuditFindingAtomInput): Atom {
  auditFindingSchema.parse({
    pipelineId: String(input.pipelineId),
    stageName: input.stageName,
    principalId: String(input.principalId),
    correlationId: input.correlationId,
    now: input.now,
    severity: input.severity,
    category: input.category,
    message: input.message,
    citedAtomIds: input.citedAtomIds.map(String),
    citedPaths: [...input.citedPaths],
  });
  const id = `pipeline-audit-finding-${input.pipelineId}-${input.stageName}-${input.correlationId}-${input.severity}-${input.category}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-audit-finding',
    content: input.message,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId],
    metadata: {
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      severity: input.severity,
      category: input.category,
      message: input.message,
      cited_atom_ids: input.citedAtomIds.map(String),
      cited_paths: [...input.citedPaths],
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-failed atom (terminal on rollback)
// ---------------------------------------------------------------------------

export interface MkPipelineFailedAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly failedStageName: string;
  readonly failedStageIndex: number;
  readonly cause: string;
  readonly chain: ReadonlyArray<AtomId>;
  readonly recoveryHint: string;
}

export function mkPipelineFailedAtom(input: MkPipelineFailedAtomInput): Atom {
  const id = `pipeline-failed-${input.pipelineId}-${input.failedStageIndex}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-failed',
    content: `${input.failedStageName}: ${input.cause}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId, ...input.chain],
    metadata: {
      pipeline_id: input.pipelineId,
      failed_stage_name: input.failedStageName,
      failed_stage_index: input.failedStageIndex,
      cause: input.cause,
      chain: input.chain.map(String),
      recovery_hint: input.recoveryHint,
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-resume atom (lifts an HIL pause)
// ---------------------------------------------------------------------------

export interface MkPipelineResumeAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly stageName: string;
  readonly resumerPrincipalId: PrincipalId;
}

export function mkPipelineResumeAtom(input: MkPipelineResumeAtomInput): Atom {
  const id = `pipeline-resume-${input.pipelineId}-${input.stageName}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-resume',
    content: `resume:${input.stageName}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId],
    metadata: {
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      resumer_principal_id: String(input.resumerPrincipalId),
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/planning-pipeline/atom-shapes.test.ts`
Expected: PASS, all five describe blocks green.

- [ ] **Step 5: Canon-audit subagent**

Dispatch a canon-compliance auditor with prompt:

> Review the atom-shape module at `src/runtime/planning-pipeline/atom-shapes.ts` and its test against the canon directives `arch-atomstore-source-of-truth`, `dev-canon-is-strategic-not-tactical`, `dev-dry-extract-at-second-duplication`, `arch-plan-state-top-level-field`, `inv-governance-before-autonomy`. Confirm: (a) every builder requires non-empty derivedFrom matching the provenance directive; (b) `pipeline_state` is top-level on the pipeline atom only, not under metadata; (c) the cited-list cap is applied symmetrically to `cited_paths` and `cited_atom_ids`; (d) atom-id construction is deterministic per correlation-id namespace; (e) zod enum guards reject unknown severity / transition / mode literals; (f) substrate purity: no concrete prompt or schema text leaks; (g) the threat model from spec section 14 (LLM hallucination of paths, runaway audit lists, prompt-injection severity drift) is covered. Return Approved or Issues Found.

Iterate until Approved.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/runtime/planning-pipeline/atom-shapes.ts test/runtime/planning-pipeline/atom-shapes.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add atom-shape builders with zod validators"
```

---

## Task 3: PlanningStage interface (pure types)

**Files:**
- Create: `src/runtime/planning-pipeline/types.ts`
- Create: `src/runtime/planning-pipeline/stage.ts`
- Test: `test/runtime/planning-pipeline/types.test.ts`

**Security + correctness considerations:**
- Pure type module with zero execution: a TS-type-only header that downstream stage adapters in `examples/planning-stages/` import. No runtime import path leaks.
- The interface uses `unknown` as the default generic so a stage that does not declare its types compiles, but the runner's call-site narrows the generic to the stage's declared shape so a misalignment is a TS-compile error rather than a runtime cast.
- `RetryStrategy` is a discriminated union (`{ kind: 'no-retry' } | { kind: 'with-jitter'; max_attempts: number; ... }`), forcing the call site to handle every case. A free-string `'retry'` would silently default-fall-through; the discriminator prevents this per `inv-governance-before-autonomy`.
- `AuditFinding` shape is the same shape `mkPipelineAuditFindingAtom` consumes; misalignment is a compile-time error. NOT a runtime drift.
- `StageInput` carries `seedAtomIds: ReadonlyArray<AtomId>` so a stage adapter has an immutable view of the upstream provenance chain. A stage that mutates the array is a TS error.
- The interface DOES NOT declare an `apply` method or any side-effect path; stage adapters call `host.atoms.put` etc. directly with the runner-supplied host. This keeps the interface strictly observational.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/planning-pipeline/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
  PlanningStage,
  StageInput,
  StageOutput,
  AuditFinding,
  RetryStrategy,
} from '../../../src/runtime/planning-pipeline/types.js';

describe('PlanningStage type', () => {
  it('compiles a minimal stage', () => {
    const stage: PlanningStage<{ in: number }, { out: string }> = {
      name: 'noop-stage',
      async run(input: StageInput<{ in: number }>): Promise<StageOutput<{ out: string }>> {
        return {
          value: { out: String(input.priorOutput.in) },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
    };
    expect(stage.name).toBe('noop-stage');
  });

  it('AuditFinding severity is constrained at the type level', () => {
    const finding: AuditFinding = {
      severity: 'critical',
      category: 'cite-fail',
      message: 'x',
      cited_atom_ids: [],
      cited_paths: [],
    };
    expect(finding.severity).toBe('critical');
  });

  it('RetryStrategy discriminated union covers no-retry vs with-jitter', () => {
    const a: RetryStrategy = { kind: 'no-retry' };
    const b: RetryStrategy = { kind: 'with-jitter', max_attempts: 3, base_delay_ms: 500 };
    expect(a.kind).toBe('no-retry');
    expect(b.kind).toBe('with-jitter');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/planning-pipeline/types.test.ts`
Expected: FAIL because `src/runtime/planning-pipeline/types.ts` does not exist.

- [ ] **Step 3: Implement minimal**

Create `src/runtime/planning-pipeline/types.ts`:

```ts
/**
 * PlanningStage type surface.
 *
 * Pure types: this module re-exports interfaces only, no runtime
 * code. A stage adapter (in examples/planning-stages/) imports these
 * types and exports a value implementing PlanningStage<TIn, TOut>.
 *
 * Mechanism-only per dev-substrate-not-prescription: the interface
 * declares the SHAPE of a stage; concrete prompts and schemas live
 * in stage adapters. The interface is the substrate seam.
 */

import type { z } from 'zod';
import type { Host } from '../../substrate/interface.js';
import type { AtomId, PrincipalId } from '../../substrate/types.js';

export interface StageInput<T> {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly priorOutput: T;
  readonly pipelineId: AtomId;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
}

export interface StageOutput<T> {
  readonly value: T;
  readonly cost_usd: number;
  readonly duration_ms: number;
  readonly atom_type: string;
  readonly atom_id?: AtomId;
}

export interface AuditFinding {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<AtomId>;
  readonly cited_paths: ReadonlyArray<string>;
}

export interface StageContext {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly pipelineId: AtomId;
  readonly stageName: string;
}

export type RetryStrategy =
  | { readonly kind: 'no-retry' }
  | {
      readonly kind: 'with-jitter';
      readonly max_attempts: number;
      readonly base_delay_ms: number;
      readonly cheaper_model_fallback?: string;
    };

export interface PlanningStage<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly outputSchema?: z.ZodSchema<TOutput>;
  run(input: StageInput<TInput>): Promise<StageOutput<TOutput>>;
  audit?(output: TOutput, ctx: StageContext): Promise<ReadonlyArray<AuditFinding>>;
  readonly retry?: RetryStrategy;
  /** Per-stage budget cap in USD; orchestrator halts the stage on breach. */
  readonly budget_cap_usd?: number;
  /** v1: linear ordering only; depends_on reserved for a forward-compat DAG seam. */
  readonly dependsOn?: ReadonlyArray<string>;
}
```

Create `src/runtime/planning-pipeline/stage.ts` (pure re-export to keep the surface canonical per the spec section 5):

```ts
/**
 * PlanningStage interface re-export. Stage adapters import from this
 * module so the canonical surface stays one path even if the type
 * implementation moves.
 */

export type {
  PlanningStage,
  StageInput,
  StageOutput,
  StageContext,
  AuditFinding,
  RetryStrategy,
} from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/planning-pipeline/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Canon-audit subagent**

Dispatch a canon-compliance auditor with prompt:

> Review the type surface at `src/runtime/planning-pipeline/types.ts` and `stage.ts` against `dev-substrate-not-prescription`, `arch-host-interface-boundary`, `inv-governance-before-autonomy`. Confirm: (a) the interface is purely observational (no apply method, no host-side-effects in the interface contract); (b) the discriminated `RetryStrategy` forbids a free-string default; (c) `StageInput.seedAtomIds` is immutable so a stage cannot mutate the upstream provenance chain; (d) no concrete prompt or vendor model id appears in src/. Return Approved or Issues Found.

Iterate until Approved.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/runtime/planning-pipeline/types.ts src/runtime/planning-pipeline/stage.ts test/runtime/planning-pipeline/types.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add PlanningStage interface (pure types)"
```

---

## Task 4: Canon policy parsers

**Files:**
- Create: `src/runtime/planning-pipeline/policy.ts`
- Test: `test/runtime/planning-pipeline/policy.test.ts`

**Security + correctness considerations:**
- Policy parsers mirror the directive-scan pattern in `src/runtime/actor-message/intent-approve.ts:156-222` (`readIntentApprovePolicy`, `readIntentCreationPolicy`). Reuse: a malformed atom is fail-closed (empty allowlist, unknown stage list, default-pause behavior). NEVER fail-open.
- Source-rank arbitration: a `principal:<id>` scoped policy beats a `project` scoped one per `conv-source-rank-formula`. The parser walks atoms ordered by source-rank and returns the highest-priority match. (v1 implementation: emulate by `principal:` scope check with explicit precedence; full source-rank integration uses `host.canon.applicable` if available, falls back to manual walk if not.)
- Stage list validation: a malformed `stages` array (missing `name` or `principal_id`, duplicate `name`, non-string entries) returns an empty stages list AND logs an audit event so the orchestrator's pre-flight halt is observable. NEVER silently coerce.
- HIL policy `pause_mode` is a strict enum (`'always' | 'on-critical-finding' | 'never'`); an unknown value defaults to `'always'` (most-paused = most conservative, per `inv-governance-before-autonomy`).
- `default_mode` parser scans for the `pol-planning-pipeline-default-mode` atom and returns `'single-pass'` when missing or malformed, matching the indie-floor default.
- Policy queries are bounded: `MAX_SCAN = 5000` atoms per pass mirrors the existing pattern. A canon store with more atoms than this returns the highest-priority match seen in the first 5000.
- TOCTOU: policies are read once per pipeline-run (at runner.start), NOT per stage. A canon edit mid-run does NOT change the active pipeline; the operator must restart or supersede the pipeline atom.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/planning-pipeline/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  readPipelineStagesPolicy,
  readPipelineStageHilPolicy,
  readPipelineDefaultModePolicy,
  readPipelineStageCostCapPolicy,
} from '../../../src/runtime/planning-pipeline/policy.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;

function policyAtom(id: string, policy: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: id,
    type: 'directive',
    layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'op', session_id: 't' }, derived_from: [] },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'operator-principal' as PrincipalId,
    taint: 'clean',
    metadata: { policy },
  };
}

describe('readPipelineStagesPolicy', () => {
  it('returns the configured stages list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-planning-pipeline-stages-default', {
      subject: 'planning-pipeline-stages',
      scope: 'project',
      stages: [
        { name: 'brainstorm-stage', principal_id: 'brainstorm-actor' },
        { name: 'spec-stage', principal_id: 'spec-author' },
      ],
    }));
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]?.name).toBe('brainstorm-stage');
  });

  it('fail-closed: malformed stages array returns empty list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-planning-pipeline-stages-default', {
      subject: 'planning-pipeline-stages',
      scope: 'project',
      stages: 'not-an-array',
    }));
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toEqual([]);
  });
});

describe('readPipelineStageHilPolicy', () => {
  it('returns "always" for unknown pause_mode', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-pipeline-stage-hil-spec', {
      subject: 'pipeline-stage-hil',
      stage_name: 'spec-stage',
      pause_mode: 'whenever',
      allowed_resumers: ['operator-principal'],
    }));
    const result = await readPipelineStageHilPolicy(host, 'spec-stage');
    expect(result.pause_mode).toBe('always');
  });

  it('returns "never" when no policy atom matches', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStageHilPolicy(host, 'unknown-stage');
    expect(result.pause_mode).toBe('never');
  });
});

describe('readPipelineDefaultModePolicy', () => {
  it('returns "single-pass" when no atom is present (indie floor)', async () => {
    const host = createMemoryHost();
    const result = await readPipelineDefaultModePolicy(host);
    expect(result.mode).toBe('single-pass');
  });
});

describe('readPipelineStageCostCapPolicy', () => {
  it('returns null when no per-stage atom exists', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStageCostCapPolicy(host, 'spec-stage');
    expect(result.cap_usd).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/planning-pipeline/policy.test.ts`
Expected: FAIL because `policy.ts` does not exist.

- [ ] **Step 3: Implement minimal**

Create `src/runtime/planning-pipeline/policy.ts` (mirror `intent-approve.ts:156-222` directive-scan):

```ts
/**
 * Canon policy parsers for the deep planning pipeline.
 *
 * Mirror of the directive-scan pattern in
 * src/runtime/actor-message/intent-approve.ts: walk directive atoms
 * tagged with a known subject, fail-closed on malformed shapes,
 * return the highest-priority match for the requested scope.
 *
 * Mechanism-only per dev-substrate-not-prescription: this module
 * reads policy atoms; the policy CONTENT lives in canon, not here.
 */

import type { Host } from '../../substrate/interface.js';
import type { Atom } from '../../substrate/types.js';

const MAX_SCAN = 5_000;
const PAGE_SIZE = 200;

export interface StageDescriptor {
  readonly name: string;
  readonly principal_id: string;
}

export interface PipelineStagesPolicyResult {
  readonly stages: ReadonlyArray<StageDescriptor>;
  readonly atomId: string | null;
}

export interface PipelineStageHilPolicyResult {
  readonly pause_mode: 'always' | 'on-critical-finding' | 'never';
  readonly auto_resume_after_ms: number | null;
  readonly allowed_resumers: ReadonlyArray<string>;
}

export interface PipelineDefaultModePolicyResult {
  readonly mode: 'single-pass' | 'substrate-deep';
}

export interface PipelineStageCostCapPolicyResult {
  readonly cap_usd: number | null;
}

async function* iteratePolicyAtoms(host: Host): AsyncGenerator<Atom> {
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      yield atom;
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
}

function readPolicy(atom: Atom): Record<string, unknown> | null {
  const meta = (atom.metadata as Record<string, unknown>) ?? {};
  const policy = meta.policy;
  return policy && typeof policy === 'object' ? (policy as Record<string, unknown>) : null;
}

export async function readPipelineStagesPolicy(
  host: Host,
  ctx: { readonly scope: string },
): Promise<PipelineStagesPolicyResult> {
  let best: { atom: Atom; depth: number } | null = null;
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'planning-pipeline-stages') continue;
    // Source-rank short-circuit: principal:<id> beats project beats default.
    const scope = typeof policy.scope === 'string' ? policy.scope : '';
    const depth = scope.startsWith('principal:') ? 2 : scope.startsWith('feature:') ? 1 : 0;
    if (best === null || depth > best.depth) best = { atom, depth };
  }
  if (best === null) return { stages: [], atomId: null };
  const policy = readPolicy(best.atom);
  if (policy === null) return { stages: [], atomId: null };
  const rawStages = policy.stages;
  if (!Array.isArray(rawStages)) return { stages: [], atomId: String(best.atom.id) };
  const stages: StageDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of rawStages) {
    if (entry === null || typeof entry !== 'object') return { stages: [], atomId: String(best.atom.id) };
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : null;
    const principal_id = typeof obj.principal_id === 'string' ? obj.principal_id : null;
    if (name === null || principal_id === null) return { stages: [], atomId: String(best.atom.id) };
    if (seen.has(name)) return { stages: [], atomId: String(best.atom.id) };
    seen.add(name);
    stages.push({ name, principal_id });
  }
  return { stages, atomId: String(best.atom.id) };
}

export async function readPipelineStageHilPolicy(
  host: Host,
  stageName: string,
): Promise<PipelineStageHilPolicyResult> {
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'pipeline-stage-hil') continue;
    if (policy.stage_name !== stageName) continue;
    const rawMode = policy.pause_mode;
    const mode: PipelineStageHilPolicyResult['pause_mode'] =
      rawMode === 'always' || rawMode === 'on-critical-finding' || rawMode === 'never'
        ? rawMode
        : 'always';
    const autoResume = typeof policy.auto_resume_after_ms === 'number' ? policy.auto_resume_after_ms : null;
    const allowed = Array.isArray(policy.allowed_resumers)
      ? (policy.allowed_resumers as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    return { pause_mode: mode, auto_resume_after_ms: autoResume, allowed_resumers: allowed };
  }
  return { pause_mode: 'never', auto_resume_after_ms: null, allowed_resumers: [] };
}

export async function readPipelineDefaultModePolicy(
  host: Host,
): Promise<PipelineDefaultModePolicyResult> {
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'planning-pipeline-default-mode') continue;
    const raw = policy.mode;
    if (raw === 'substrate-deep' || raw === 'single-pass') return { mode: raw };
  }
  return { mode: 'single-pass' };
}

export async function readPipelineStageCostCapPolicy(
  host: Host,
  stageName: string,
): Promise<PipelineStageCostCapPolicyResult> {
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'pipeline-stage-cost-cap') continue;
    if (policy.stage_name !== stageName) continue;
    const cap = policy.cap_usd;
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) return { cap_usd: cap };
  }
  return { cap_usd: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/planning-pipeline/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Canon-audit subagent**

Dispatch a canon-compliance auditor with prompt:

> Review `src/runtime/planning-pipeline/policy.ts` against `inv-governance-before-autonomy`, `conv-source-rank-formula`, `dev-substrate-not-prescription`. Confirm: (a) every policy reader is fail-closed on malformed shape; (b) source-rank arbitration is honored (principal scope beats project); (c) the HIL pause-mode default for unknown enum is `'always'` (most conservative); (d) the default-mode is `'single-pass'` (indie floor) when no policy atom is present; (e) cost-cap returns null (caller-decides) when no per-stage atom exists; (f) MAX_SCAN bound mirrors intent-approve.ts. Return Approved or Issues Found.

Iterate until Approved.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/runtime/planning-pipeline/policy.ts test/runtime/planning-pipeline/policy.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add canon policy parsers"
```

---

## Task 5: PipelineRunner state machine

**Files:**
- Create: `src/runtime/planning-pipeline/runner.ts`
- Test: `test/runtime/planning-pipeline/runner.test.ts`

**Security + correctness considerations (full threat model from spec section 14):**
- **Kill-switch absolute priority** per `inv-kill-switch-first`: `host.scheduler.killswitchCheck()` is polled BEFORE every stage transition (mirrors `intent-approve.ts:241`). On STOP, the runner writes a `pipeline-stage-event` atom with `transition: 'exit-failure'` AND a `pipeline-failed` atom citing kill-switch as cause; the running stage's promise is resolved with a kill-switch sentinel rather than left dangling.
- **Claim-before-mutate** per `intent-approve.ts:443-446` and `plan-dispatch.ts:100-104`: every state transition re-reads the pipeline atom, checks the current state, then `host.atoms.update`s. Two concurrent runner ticks on the same pipeline atom cannot both advance.
- **Per-stage budget cap**: each stage's `output.cost_usd` is checked against `stage.budget_cap_usd ?? readPipelineStageCostCapPolicy(stageName).cap_usd ?? null`. A breach halts the stage with a `pipeline-failed` atom citing `cause: 'budget-overflow'`. Per-pipeline `total_cost_usd` is tracked on the pipeline atom metadata and capped at the sum of per-stage caps OR a separate `pol-planning-pipeline-total-cost-cap` (forward-compat seam, not v1).
- **Per-stage retry strategy** per `pol-judgment-fallback-ladder`: a stage's `retry?.kind === 'with-jitter'` triggers up to `max_attempts` retries with jittered backoff. A retry that breaches the budget cap halts the stage. Retries count toward the cap. A failed final attempt produces a `pipeline-failed` atom (NEVER an auto-approvable stub per `dev-judgment-ladder-required-for-llm-actors`).
- **Schema validation**: `stage.outputSchema?.safeParse(output.value)` runs before the runner persists the stage's output atom. Schema-fail halts the stage; the LLM-emitted payload outside the schema NEVER reaches an atom write per spec section 14.3.
- **Auditor wiring**: after `stage.run()` returns, the runner calls `stage.audit?(output.value, ctx)` and writes one `pipeline-audit-finding` atom per finding via `mkPipelineAuditFindingAtom`. A `'critical'` finding halts advancement (per spec section 5); `'major'` and `'minor'` allow advance unless the per-stage HIL policy is `'on-critical-finding'`. Default-deny when audit is omitted: a stage with no auditor cannot auto-advance past an HIL-`'on-critical-finding'` gate (forces manual operator pass per spec section 5 and `inv-governance-before-autonomy`).
- **HIL pause flow**: when the resolved HIL policy says `'always'` or `'on-critical-finding'` (with critical findings present), the runner transitions the pipeline atom to `pipeline_state: 'hil-paused'`, writes a `pipeline-stage-event` with `transition: 'hil-pause'`, sends a Notifier message to allowed resumers, and returns. A `pipeline-resume` atom signed by an allowed resumer (validated against the HIL policy's `allowed_resumers`) lifts the pause. Resume idempotency: if the stage's output atom already exists, the runner skips re-invocation and advances.
- **Resume-from-stage**: `runPipeline(stages, host, opts)` accepts an optional `resumeFromStage?: string`; the runner looks up the index and starts from there, marking later-stage output atoms with `superseded_by` (NOT deleting; provenance survives per spec section 11).
- **Stage-actor compromise**: `output.atom_type` is validated against the stage's declared output type (e.g. spec-stage MUST emit `'spec'`). A mismatch halts the stage. Combined with the existing `pol-llm-tool-policy-<principal-id>` deny-list applied at SubActorRegistry.invoke, a compromised stage-actor cannot widen its scope.
- **Pipeline-mode escalation guard**: the mode is read from the seed operator-intent (or its trust envelope), NOT from a runner argument; a non-operator principal cannot pass `mode: 'substrate-deep'` for a different principal per spec section 14.5.
- **Bounded loop**: a runaway stage loop is bounded by `MAX_STAGES = 64` (mechanism constant) so a malformed stages list with a cycle in `dependsOn` (forward-compat) cannot infinite-loop.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/planning-pipeline/runner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../../../src/runtime/planning-pipeline/runner.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { PlanningStage } from '../../../src/runtime/planning-pipeline/types.js';
import type { AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;

function mkStage<TIn, TOut>(name: string, runFn: (i: TIn) => TOut, atomType = 'spec'): PlanningStage<TIn, TOut> {
  return {
    name,
    async run(input) {
      return {
        value: runFn(input.priorOutput),
        cost_usd: 0,
        duration_ms: 0,
        atom_type: atomType,
      };
    },
  };
}

describe('runPipeline', () => {
  it('advances pending -> running -> completed through linear stages', async () => {
    const host = createMemoryHost();
    const stages = [
      mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      mkStage<{ a: number }, { b: number }>('stage-b', (i) => ({ b: i.a + 1 })),
    ];
    const result = await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    expect(result.pipelineId).toBeDefined();
  });

  it('halts on kill-switch before the first stage', async () => {
    const host = createMemoryHost();
    vi.spyOn(host.scheduler, 'killswitchCheck').mockReturnValue(true);
    const stages = [mkStage<unknown, unknown>('stage-a', () => ({}))];
    const result = await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-2',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('halted');
  });

  it('writes pipeline-failed atom when a stage throws', async () => {
    const host = createMemoryHost();
    const failingStage: PlanningStage<unknown, unknown> = {
      name: 'fail-stage',
      async run() {
        throw new Error('boom');
      },
    };
    const result = await runPipeline([failingStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-3',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failedStageName).toBe('fail-stage');
    }
  });

  it('halts on critical audit finding', async () => {
    const host = createMemoryHost();
    const auditedStage: PlanningStage<unknown, { x: number }> = {
      name: 'audited-stage',
      async run() {
        return { value: { x: 1 }, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
      async audit() {
        return [{
          severity: 'critical',
          category: 'cite-fail',
          message: 'fabricated path',
          cited_atom_ids: [],
          cited_paths: ['nope.ts'],
        }];
      },
    };
    const result = await runPipeline([auditedStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-4',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects stage output whose cost_usd exceeds budget_cap_usd', async () => {
    const host = createMemoryHost();
    const expensiveStage: PlanningStage<unknown, unknown> = {
      name: 'expensive-stage',
      budget_cap_usd: 1.0,
      async run() {
        return { value: {}, cost_usd: 50.0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    const result = await runPipeline([expensiveStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-5',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.cause).toMatch(/budget/);
  });

  it('emits a pipeline-stage-event atom per state transition', async () => {
    const host = createMemoryHost();
    const stages = [mkStage<unknown, unknown>('a', () => ({})), mkStage<unknown, unknown>('b', () => ({}))];
    await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-6',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const page = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    expect(page.atoms.length).toBeGreaterThanOrEqual(4); // enter+exit per stage
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/planning-pipeline/runner.test.ts`
Expected: FAIL because `runner.ts` does not exist.

- [ ] **Step 3: Implement minimal**

Create `src/runtime/planning-pipeline/runner.ts`. (Sketch; implementer fills in following the spec section 5 + 13 + 14):

```ts
/**
 * PipelineRunner state machine.
 *
 * Walks a ReadonlyArray<PlanningStage> sequentially, projecting state
 * via atom writes (mirrors src/runtime/actor-message/intent-approve.ts
 * and plan-dispatch.ts). Pure mechanism per dev-substrate-not-prescription:
 * concrete stage logic lives in stage adapters, NOT here.
 */

import type { Host } from '../../substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';
import type { PlanningStage, StageInput, StageOutput, AuditFinding } from './types.js';
import {
  mkPipelineAtom,
  mkPipelineStageEventAtom,
  mkPipelineFailedAtom,
  mkPipelineAuditFindingAtom,
} from './atom-shapes.js';
import { readPipelineStageHilPolicy, readPipelineStageCostCapPolicy } from './policy.js';

const MAX_STAGES = 64;

export type PipelineResult =
  | { readonly kind: 'completed'; readonly pipelineId: AtomId }
  | { readonly kind: 'failed'; readonly pipelineId: AtomId; readonly failedStageName: string; readonly cause: string }
  | { readonly kind: 'hil-paused'; readonly pipelineId: AtomId; readonly stageName: string }
  | { readonly kind: 'halted'; readonly pipelineId?: AtomId };

export interface RunPipelineOptions {
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  readonly stagePolicyAtomId: string;
  readonly mode: 'single-pass' | 'substrate-deep';
  readonly now?: () => Time;
  readonly resumeFromStage?: string;
}

export async function runPipeline(
  stages: ReadonlyArray<PlanningStage>,
  host: Host,
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  if (stages.length > MAX_STAGES) {
    throw new Error(`runPipeline: stage count ${stages.length} exceeds MAX_STAGES ${MAX_STAGES}`);
  }
  // Kill-switch absolute priority before any reads.
  if (host.scheduler.killswitchCheck()) return { kind: 'halted' };
  const now = options.now ?? (() => new Date().toISOString() as Time);

  const pipelineId = `pipeline-${options.correlationId}` as AtomId;
  const pipelineAtom = mkPipelineAtom({
    pipelineId,
    principalId: options.principal,
    correlationId: options.correlationId,
    now: now(),
    seedAtomIds: options.seedAtomIds,
    stagePolicyAtomId: options.stagePolicyAtomId,
    mode: options.mode,
  });
  await host.atoms.put(pipelineAtom);

  let priorOutput: unknown = null;
  let totalCostUsd = 0;
  const startIdx = options.resumeFromStage
    ? stages.findIndex((s) => s.name === options.resumeFromStage)
    : 0;
  if (startIdx < 0) {
    return await failPipeline(host, pipelineId, options, now, 'unknown-stage', 'resume-from-stage not found in stages list', startIdx);
  }

  for (let i = startIdx; i < stages.length; i++) {
    if (host.scheduler.killswitchCheck()) {
      await host.atoms.put(mkPipelineStageEventAtom({
        pipelineId,
        stageName: stages[i]!.name,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition: 'exit-failure',
        durationMs: 0,
        costUsd: 0,
      }));
      return { kind: 'halted', pipelineId };
    }
    const stage = stages[i]!;
    // Claim-before-mutate: re-read pipeline atom, check state.
    const fresh = await host.atoms.get(pipelineId);
    if (fresh === null) return { kind: 'halted', pipelineId };
    if (fresh.taint !== 'clean') return { kind: 'halted', pipelineId };
    await host.atoms.update(pipelineId, { pipeline_state: 'running' });
    await host.atoms.put(mkPipelineStageEventAtom({
      pipelineId,
      stageName: stage.name,
      principalId: options.principal,
      correlationId: options.correlationId,
      now: now(),
      transition: 'enter',
      durationMs: 0,
      costUsd: 0,
    }));

    const t0 = Date.now();
    let output: StageOutput<unknown>;
    try {
      const stageInput: StageInput<unknown> = {
        host,
        principal: options.principal,
        correlationId: options.correlationId,
        priorOutput,
        pipelineId,
        seedAtomIds: options.seedAtomIds,
      };
      output = await stage.run(stageInput);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return await failPipeline(host, pipelineId, options, now, stage.name, cause, i);
    }
    const durationMs = Date.now() - t0;

    // Schema validation.
    if (stage.outputSchema !== undefined) {
      const parsed = stage.outputSchema.safeParse(output.value);
      if (!parsed.success) {
        return await failPipeline(host, pipelineId, options, now, stage.name, `schema-validation-failed: ${parsed.error.message}`, i);
      }
    }

    // Budget enforcement.
    const stageCap = stage.budget_cap_usd
      ?? (await readPipelineStageCostCapPolicy(host, stage.name)).cap_usd;
    if (stageCap !== null && stageCap !== undefined && output.cost_usd > stageCap) {
      return await failPipeline(host, pipelineId, options, now, stage.name, `budget-overflow: cost ${output.cost_usd} > cap ${stageCap}`, i);
    }
    totalCostUsd += output.cost_usd;

    // Auditor wiring.
    let findings: ReadonlyArray<AuditFinding> = [];
    if (stage.audit !== undefined) {
      findings = await stage.audit(output.value, {
        host,
        principal: options.principal,
        correlationId: options.correlationId,
        pipelineId,
        stageName: stage.name,
      });
      for (const finding of findings) {
        await host.atoms.put(mkPipelineAuditFindingAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          severity: finding.severity,
          category: finding.category,
          message: finding.message,
          citedAtomIds: finding.cited_atom_ids,
          citedPaths: finding.cited_paths,
        }));
      }
    }

    const hasCritical = findings.some((f) => f.severity === 'critical');
    if (hasCritical) {
      return await failPipeline(host, pipelineId, options, now, stage.name, 'critical-audit-finding', i);
    }

    // HIL gate.
    const hil = await readPipelineStageHilPolicy(host, stage.name);
    const shouldPause = hil.pause_mode === 'always'
      || (hil.pause_mode === 'on-critical-finding' && hasCritical);
    if (shouldPause) {
      await host.atoms.update(pipelineId, { pipeline_state: 'hil-paused' });
      await host.atoms.put(mkPipelineStageEventAtom({
        pipelineId,
        stageName: stage.name,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition: 'hil-pause',
        durationMs,
        costUsd: output.cost_usd,
      }));
      // Notifier hook (best-effort; do not throw if the channel is offline).
      try {
        await host.notifier.telegraph({
          to: hil.allowed_resumers[0] ?? String(options.principal),
          channel: 'inbox',
          subject: `Pipeline ${pipelineId} paused at ${stage.name}`,
          body: `Resume via a pipeline-resume atom signed by an allowed resumer.`,
        } as never);
      } catch {/* swallow per kill-switch-first non-blocking observability */}
      return { kind: 'hil-paused', pipelineId, stageName: stage.name };
    }

    await host.atoms.put(mkPipelineStageEventAtom({
      pipelineId,
      stageName: stage.name,
      principalId: options.principal,
      correlationId: options.correlationId,
      now: now(),
      transition: 'exit-success',
      durationMs,
      costUsd: output.cost_usd,
      ...(output.atom_id !== undefined ? { outputAtomId: output.atom_id } : {}),
    }));

    priorOutput = output.value;
  }

  await host.atoms.update(pipelineId, {
    pipeline_state: 'completed',
    metadata: { completed_at: now(), total_cost_usd: totalCostUsd },
  });
  return { kind: 'completed', pipelineId };
}

async function failPipeline(
  host: Host,
  pipelineId: AtomId,
  options: RunPipelineOptions,
  now: () => Time,
  stageName: string,
  cause: string,
  failedIndex: number,
): Promise<PipelineResult> {
  const chainPage = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
  const chain = chainPage.atoms
    .filter((a) => (a.metadata as Record<string, unknown>)?.pipeline_id === pipelineId)
    .map((a) => a.id);
  await host.atoms.put(mkPipelineFailedAtom({
    pipelineId,
    principalId: options.principal,
    correlationId: options.correlationId,
    now: now(),
    failedStageName: stageName,
    failedStageIndex: failedIndex,
    cause,
    chain,
    recoveryHint: `re-run from stage '${stageName}' after addressing the failure cause`,
  }));
  await host.atoms.update(pipelineId, { pipeline_state: 'failed' });
  return { kind: 'failed', pipelineId, failedStageName: stageName, cause };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/planning-pipeline/runner.test.ts`
Expected: PASS, all six describe assertions green.

- [ ] **Step 5: Canon-audit subagent**

Dispatch a canon-compliance auditor with the full spec section 14 threat model as context, prompt:

> Review `src/runtime/planning-pipeline/runner.ts` against the spec at `docs/superpowers/specs/2026-04-28-deep-planning-pipeline-design.md` section 14 (threat model) and the canon directives `inv-kill-switch-first`, `arch-atomstore-source-of-truth`, `dev-judgment-ladder-required-for-llm-actors`, `inv-governance-before-autonomy`, `dev-substrate-not-prescription`. Confirm: (a) kill-switch is checked BEFORE every stage; (b) claim-before-mutate prevents double-advance; (c) per-stage budget caps halt on breach; (d) schema validation runs before output persistence; (e) critical audit findings halt; (f) HIL pause flow is fail-closed (default-pause when audit is omitted on a stage with `on-critical-finding` HIL); (g) resume-from-stage marks downstream as superseded; (h) MAX_STAGES bound prevents runaway loops; (i) substrate purity preserved (no concrete prompt or vendor model id leaks). Return Approved or Issues Found with specifics.

Iterate until Approved.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/runtime/planning-pipeline/runner.ts test/runtime/planning-pipeline/runner.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add runner state machine"
```

---

## Task 6: Pipeline-pipeline barrel + index

**Files:**
- Create: `src/runtime/planning-pipeline/index.ts`
- Modify: `src/runtime/actor-message/index.ts:147` (add re-export OR omit; verified at this task)

**Security + correctness considerations:**
- Barrel-only: re-exports the public surface so consumers do not reach into individual files. NEVER expose internal helpers (`baseAtom`, `iteratePolicyAtoms`, `failPipeline`); those are file-local.
- Subpath-export pattern matches `src/runtime/actor-message/index.ts`: each new module's public symbols re-exported at the barrel.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime/planning-pipeline/types.test.ts`:

```ts
import * as PipelineExports from '../../../src/runtime/planning-pipeline/index.js';
describe('planning-pipeline barrel', () => {
  it('exports the public surface', () => {
    expect(typeof PipelineExports.runPipeline).toBe('function');
    expect(typeof PipelineExports.mkPipelineAtom).toBe('function');
    expect(typeof PipelineExports.mkPipelineStageEventAtom).toBe('function');
    expect(typeof PipelineExports.readPipelineStagesPolicy).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/planning-pipeline/types.test.ts`
Expected: FAIL because barrel does not exist.

- [ ] **Step 3: Implement minimal**

Create `src/runtime/planning-pipeline/index.ts`:

```ts
/**
 * Public surface of the planning-pipeline substrate.
 */

export type {
  PlanningStage,
  StageInput,
  StageOutput,
  StageContext,
  AuditFinding,
  RetryStrategy,
} from './types.js';

export {
  mkPipelineAtom,
  mkPipelineStageEventAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineResumeAtom,
  mkSpecAtom,
  PIPELINE_STATE_VALUES,
} from './atom-shapes.js';
export type {
  PipelineStateLabel,
  MkPipelineAtomInput,
  MkSpecAtomInput,
  MkPipelineStageEventAtomInput,
  MkPipelineAuditFindingAtomInput,
  MkPipelineFailedAtomInput,
  MkPipelineResumeAtomInput,
} from './atom-shapes.js';

export { runPipeline } from './runner.js';
export type { RunPipelineOptions, PipelineResult } from './runner.js';

export {
  readPipelineStagesPolicy,
  readPipelineStageHilPolicy,
  readPipelineDefaultModePolicy,
  readPipelineStageCostCapPolicy,
} from './policy.js';
export type {
  StageDescriptor,
  PipelineStagesPolicyResult,
  PipelineStageHilPolicyResult,
  PipelineDefaultModePolicyResult,
  PipelineStageCostCapPolicyResult,
} from './policy.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/planning-pipeline/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Canon-audit subagent**

Dispatch a canon-compliance auditor with prompt:

> Review `src/runtime/planning-pipeline/index.ts` against `dev-substrate-not-prescription`, `arch-host-interface-boundary`. Confirm: (a) only public surface is re-exported; (b) no internal helpers leak; (c) the barrel matches the pattern in `src/runtime/actor-message/index.ts`. Return Approved or Issues Found.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/runtime/planning-pipeline/index.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add public barrel"
```

---

## Task 6.5: Bootstrap per-principal tool-policy atoms (precursor for Tasks 7-11)

**Files:**
- Create: `.lag/atoms/principal-brainstorm-actor.json`
- Create: `.lag/atoms/principal-spec-author.json`
- Create: `.lag/atoms/principal-pipeline-auditor.json`
- Create: `.lag/atoms/principal-plan-dispatcher.json`
- Create: `.lag/atoms/pol-llm-tool-policy-brainstorm-actor.json`
- Create: `.lag/atoms/pol-llm-tool-policy-spec-author.json`
- Create: `.lag/atoms/pol-llm-tool-policy-pipeline-auditor.json`
- Create: `.lag/atoms/pol-llm-tool-policy-plan-dispatcher.json`
- Modify: `scripts/bootstrap-decisions-canon.mjs` (append the 8 new atoms to the bootstrap registry so a fresh clone provisions them)

**Security + correctness considerations:**
- Per `dev-actor-scoped-llm-tool-policy` every LLM-backed actor MUST have a per-principal tool-policy atom, otherwise calls fall through to `pol-llm-tool-policy-fallback-deny-all` and writes are refused. Tasks 7-11 reference adapters call into `host.llm.judge` for these four principals; without this precursor the adapters fail-closed and Tasks 7-11 cannot pass their own tests.
- Per `inv-governance-before-autonomy` default-deny posture: each policy atom carries an explicit `disallowedTools` list; only Read/Grep/Glob are allowed by omission. brainstorm-actor + spec-author + pipeline-auditor are READ-ONLY (mirror auditor-actor posture); plan-dispatcher is READ-ONLY by virtue of all writes routing through SubActorRegistry.invoke.
- Per `arch-principal-hierarchy-signed-by` each new principal carries `signed_by: 'claude-agent'` (peer to existing planner-shaped actors); taint cascades correctly under the existing arbitration stack.
- Provenance: each atom carries `provenance.kind: 'operator-seeded'` and `derived_from: ['operator-intent-deep-planning-pipeline-1777408799112']` so the precursor is auditable as flowing from the operator-intent.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/planning-pipeline/principal-policies.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { resolveLlmToolPolicy } from '../../../src/runtime/llm-tool-policy/resolver.js';

describe('planning-pipeline principal tool policies', () => {
  it.each([
    'brainstorm-actor',
    'spec-author',
    'pipeline-auditor',
    'plan-dispatcher',
  ])('resolves a non-fallback policy for %s', async (principal) => {
    const host = await createMemoryHost();
    // Bootstrap the precursor atoms (loaded via the bootstrap script in the next steps)
    const policy = await resolveLlmToolPolicy(host, principal);
    expect(policy.policy_atom_id).toMatch(/^pol-llm-tool-policy-/);
    expect(policy.policy_atom_id).not.toBe('pol-llm-tool-policy-fallback-deny-all');
    expect(policy.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    // Read-only posture: Read/Grep/Glob NOT in deny-list
    expect(policy.disallowedTools).not.toContain('Read');
    expect(policy.disallowedTools).not.toContain('Grep');
    expect(policy.disallowedTools).not.toContain('Glob');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/runtime/planning-pipeline/principal-policies.test.ts`
Expected: FAIL with "policy resolves to fallback-deny-all" for all four principals.

- [ ] **Step 3: Implement minimal**

Use the existing `decide-cli` shape for each atom. Each principal atom is operator-seeded with the canonical principal schema (id, role, signed_by, active, created_at). Each policy atom mirrors the existing `pol-llm-tool-policy-cto-actor.json` shape (kind: directive; metadata.disallowedTools = the standard deny-list; metadata.allowedTools = empty since allow-by-omission is the default).

For the brainstorm-actor / spec-author / pipeline-auditor / plan-dispatcher policy atoms, the disallowedTools list is identical to cto-actor's: `['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'SlashCommand']`.

Mint each via `node scripts/decide.mjs --spec-file <path>` per the decide skill convention (each spec.json carries id, type=directive, content prose citing dev-actor-scoped-llm-tool-policy, alternatives_rejected, what_breaks_if_revisited, derived_from chain to operator-intent-deep-planning-pipeline-1777408799112).

Append the 8 atoms to `scripts/bootstrap-decisions-canon.mjs` in the existing `BOOTSTRAP_ATOMS` registry so a fresh clone gets them on `npm run bootstrap`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/runtime/planning-pipeline/principal-policies.test.ts`
Expected: PASS, all 4 cases green.

- [ ] **Step 5: Canon-audit subagent**

Per `dev-implementation-canon-audit-loop`. Pass: CLAUDE.md + atoms `dev-actor-scoped-llm-tool-policy`, `pol-llm-tool-policy-fallback-deny-all`, `inv-governance-before-autonomy`, `arch-principal-hierarchy-signed-by` + the 8 new atom files + the diff. Reviewer verifies: deny-list matches the canonical 11-tool list; signed_by chain is intact; no operator real name; no AI-attribution; provenance.derived_from chains to the operator-intent. Iterate until Approved.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add .lag/atoms/principal-brainstorm-actor.json .lag/atoms/principal-spec-author.json .lag/atoms/principal-pipeline-auditor.json .lag/atoms/principal-plan-dispatcher.json .lag/atoms/pol-llm-tool-policy-brainstorm-actor.json .lag/atoms/pol-llm-tool-policy-spec-author.json .lag/atoms/pol-llm-tool-policy-pipeline-auditor.json .lag/atoms/pol-llm-tool-policy-plan-dispatcher.json scripts/bootstrap-decisions-canon.mjs test/runtime/planning-pipeline/principal-policies.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): bootstrap per-principal tool-policy atoms (precursor for Tasks 7-11)"
```

---

## Task 7: Reference brainstorm-stage adapter

**Files:**
- Create: `examples/planning-stages/brainstorm/index.ts`
- Test: `examples/planning-stages/brainstorm/test/brainstorm-stage.test.ts`

**Security + correctness considerations:**
- Reference adapter lives in `examples/`, NOT `src/`, per `dev-substrate-not-prescription`. Concrete prompt + LLM-judge wiring belongs here, not framework code.
- Stage-actor invocation routes through `host.llm.judge` with the per-principal `disallowedTools` deny-list resolved from `pol-llm-tool-policy-brainstorm-actor` (canon atom -- not yet created in v1; adapter falls back to deny-all-writes when missing per `inv-governance-before-autonomy`).
- Output zod schema validates: `open_questions: string[]`, `alternatives_surveyed: { option, rejection_reason }[]`, `decision_points: string[]`, `cost_usd: number`. Schema-validated BEFORE the runner persists.
- Auditor: walks every cited atom id in `alternatives_surveyed[*].rejection_reason` and verifies each resolves via `host.atoms.get`. Fabricated id -> `'critical'` finding (mitigates `dev-drafter-citation-verification-required`).
- Stage-actor compromise containment: a brainstorm-actor that emits a payload outside the schema fails at the runner; a brainstorm-actor with an LLM-emitted `cost_usd: -1` (signed-numeric prompt-injection) fails at the schema.

- [ ] **Step 1: Write the failing test**

Create `examples/planning-stages/brainstorm/test/brainstorm-stage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { brainstormStage } from '../index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type { AtomId, PrincipalId } from '../../../../src/types.js';

describe('brainstormStage', () => {
  it('exports a PlanningStage with name "brainstorm-stage"', () => {
    expect(brainstormStage.name).toBe('brainstorm-stage');
  });

  it('audit() flags a fabricated cited atom id as critical', async () => {
    const host = createMemoryHost();
    const findings = await brainstormStage.audit?.({
      open_questions: [],
      alternatives_surveyed: [{ option: 'foo', rejection_reason: 'cited atom-does-not-exist' }],
      decision_points: [],
      cost_usd: 0,
    } as never, {
      host,
      principal: 'brainstorm-actor' as PrincipalId,
      correlationId: 'corr',
      pipelineId: 'p' as AtomId,
      stageName: 'brainstorm-stage',
    });
    expect(findings?.some((f) => f.severity === 'critical')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run examples/planning-stages/brainstorm/test/brainstorm-stage.test.ts`
Expected: FAIL because `index.ts` does not exist.

- [ ] **Step 3: Implement minimal**

Create `examples/planning-stages/brainstorm/index.ts`. Implementer authors per the spec section 6.1; emits a `brainstorm-notes` atom (looser typing because v1 does not extend the AtomType union for this; uses generic `'observation'` until a future PR upgrades the union).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run examples/planning-stages/brainstorm/test/brainstorm-stage.test.ts`
Expected: PASS.

- [ ] **Step 5: Canon-audit subagent**

Dispatch with prompt:

> Review `examples/planning-stages/brainstorm/index.ts` against `dev-substrate-not-prescription`, `dev-drafter-citation-verification-required`, `inv-governance-before-autonomy`. Confirm: (a) lives in examples/, not src/; (b) every cited atom id is verified via host.atoms.get before persistence; (c) schema rejects negative costs and unknown shapes. Return Approved or Issues Found.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/planning-stages/brainstorm/
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add reference brainstorm-stage adapter"
```

---

## Task 8: Reference spec-stage adapter

**Files:**
- Create: `examples/planning-stages/spec/index.ts`
- Test: `examples/planning-stages/spec/test/spec-stage.test.ts`

**Security + correctness considerations:**
- Stage-actor `spec-author` runs with a `Read+Grep+Glob`-only deny-list resolved via `pol-llm-tool-policy-spec-author` (NOT yet created in v1; adapter falls back to deny-all-writes per `inv-governance-before-autonomy`).
- Output is the prose-shaped `spec` atom from Task 2; the adapter calls `mkSpecAtom` with verified `cited_paths` and `cited_atom_ids`.
- Auditor: re-reads every cited path via `host.atoms.get` (for atom-ids) and `fs.access` or equivalent read-only seam for paths. Fabricated path -> `'critical'` finding. Total Read bytes per audit capped at 1MB to defend against an LLM-emitted runaway list (per spec section 14.2).
- Spec-stage prompt-injection guard: spec text rejected if it contains the string `<system-reminder>` or any directive markup that could re-prompt downstream stage-actors.

- [ ] **Step 1: Write the failing test**

Skeleton mirroring Task 7. Validate `mkSpecAtom` integration and the path-not-found auditor flag.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run examples/planning-stages/spec/`
Expected: FAIL.

- [ ] **Step 3: Implement minimal**

Implementer follows spec section 6.2.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run examples/planning-stages/spec/`
Expected: PASS.

- [ ] **Step 5: Canon-audit subagent**

Dispatch with prompt: review `examples/planning-stages/spec/index.ts` against `dev-drafter-citation-verification-required`, `inv-governance-before-autonomy`, `dev-substrate-not-prescription`. Confirm path verification + audit byte cap + prompt-injection guard.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/planning-stages/spec/
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add reference spec-stage adapter"
```

---

## Task 9: Reference plan-stage adapter

**Files:**
- Create: `examples/planning-stages/plan/index.ts`
- Test: `examples/planning-stages/plan/test/plan-stage.test.ts`

**Security + correctness considerations:**
- Reuses the existing `PLAN_DRAFT` schema from `src/schemas/index.ts` (verified present); the plan-stage produces a plan atom matching the existing PLAN_DRAFT shape so the existing plan-dispatch loop does not need teaching.
- Plan stage GATES on `spec.audit_status == 'clean'`: a spec atom carrying findings cannot advance to plan. Default-deny per `inv-governance-before-autonomy`.
- The plan inherits the trust envelope from the upstream operator-intent. The adapter walks `seedAtomIds` for an `operator-intent` atom and copies the `trust_envelope` into `plan.metadata.delegation` so the existing autonomous-intent path triggers without an additional canon edit.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement minimal** -- implementer follows spec section 6.3.
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Canon-audit subagent** -- review against `dev-substrate-not-prescription`, `dev-drafter-citation-verification-required`, `pol-judgment-fallback-ladder`.
- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/planning-stages/plan/
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add reference plan-stage adapter"
```

---

## Task 10: Reference review-stage adapter (auditor wiring)

**Files:**
- Create: `examples/planning-stages/review/index.ts`
- Test: `examples/planning-stages/review/test/review-stage.test.ts`

**Security + correctness considerations (high-priority, full threat model from spec section 14.1):**
- This stage is the substrate-level fix for `dev-drafter-citation-verification-required`. Tonight's `runApprovedPlanDispatchPass` confabulation would have been caught here. The auditor MUST run before any dispatch.
- The review-stage dispatches a registered `pipeline-auditor` sub-actor with `Read+Grep+Glob`-only tool policy via `SubActorRegistry.invoke`. The auditor walks every cited path and atom id from the plan body, verifies each resolves, and emits `pipeline-audit-finding` atoms.
- Auditor read-tool exhaustion: every cited path is opened with a 64KB-per-file cap and a 1MB-total cap per audit run (mechanism constants). A path larger than 64KB is hashed (`host.atoms.contentHash`) and verified by hash-comparison rather than full read. Defends against an LLM-emitted huge-cited-paths list.
- Auditor compromise containment: the registered `pipeline-auditor` sub-actor cannot widen scope past Read+Grep+Glob because the deny-list is enforced at `host.llm.judge` time per `pol-llm-tool-policy-pipeline-auditor` (NEW canon atom required at Task 13).
- Output: `review-report` atom (`'observation'`-typed for v1; future PR widens AtomType union for `'review-report'`). Severity-tagged finding list with full provenance. Fail-closed: if the auditor errors, the stage halts with a `pipeline-failed` atom rather than a clean review-report stub.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement minimal** -- implementer follows spec section 6.4.
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Canon-audit subagent** -- pass spec section 14 threat model AND `dev-drafter-citation-verification-required` as context. Review must verify: (a) auditor sub-actor invocation; (b) per-file + per-audit byte caps; (c) auditor cannot widen scope; (d) hash-comparison fallback for files exceeding the per-file cap; (e) fail-closed on auditor error.
- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/planning-stages/review/
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add reference review-stage adapter"
```

---

## Task 11: Reference dispatch-stage adapter

**Files:**
- Create: `examples/planning-stages/dispatch/index.ts`
- Test: `examples/planning-stages/dispatch/test/dispatch-stage.test.ts`

**Security + correctness considerations:**
- The dispatch-stage MUST hand off to existing `runDispatchTick` from `src/runtime/actor-message/plan-dispatch.ts` rather than reimplementing dispatch. The pipeline composes with what is already shipped per the spec section 6.5.
- The dispatch-stage runs ONLY when the upstream `review-report` is all-clean OR carries an operator-acked `pipeline-resume` atom referencing the review-stage. Default-deny per `inv-governance-before-autonomy`.
- Stage is terminal per spec section 7 ordering invariant; the runner's pre-flight enforces this. The adapter does NOT attempt to advance after the dispatch.
- Dispatch produces a `'dispatch-record'` atom (`'observation'`-typed for v1; future widening). Provenance derives from the upstream plan + spec + brainstorm atoms.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement minimal** -- implementer follows spec section 6.5.
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Canon-audit subagent** -- review against the spec section 7 ordering invariants AND `inv-governance-before-autonomy`.
- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/planning-stages/dispatch/
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add reference dispatch-stage adapter"
```

---

## Task 12: Driver wiring (--mode=substrate-deep on run-cto-actor.mjs)

**Files:**
- Modify: `scripts/run-cto-actor.mjs`
- Test: manual verification (script-level changes; the runner test suite covers the substrate)

**Security + correctness considerations:**
- The `--mode` flag is read from argv but VALIDATED against the seed operator-intent's trust envelope per spec section 10. A non-operator-authored intent cannot enable `substrate-deep`. The validation lives in the script's argv parser BEFORE invocation.
- Default mode is `single-pass` (indie floor); the script reads `pol-planning-pipeline-default-mode` and falls back to `single-pass` per `dev-indie-floor-org-ceiling`.
- Drift signal per spec section 10: a CTO-class actor that needs the deep pipeline but was invoked without `--mode=substrate-deep` writes an escalation atom (the existing classification step gains a `'requires-deep-pipeline'` outcome -- implementer wires this in `host-llm-judgment.ts:303` if the prompt-engineering surface allows; otherwise the script emits the escalation directly).

- [ ] **Step 1: Write the failing test**

Manual verification: invoke `node scripts/run-cto-actor.mjs --request "x" --mode=substrate-deep` against a stub registry; assert the runner is called.

- [ ] **Step 2: Run test to verify it fails**

Expected: argv parser does not recognize `--mode`.

- [ ] **Step 3: Implement minimal**

In `scripts/run-cto-actor.mjs`, extend `parseArgs` to accept `--mode <single-pass|substrate-deep>`. When mode is `substrate-deep`, branch into `runPipeline` (loaded from `dist/runtime/planning-pipeline/index.js`) instead of `runActor`.

- [ ] **Step 4: Run test to verify it passes**

Expected: the script branches correctly based on mode.

- [ ] **Step 5: Canon-audit subagent**

Review against `dev-indie-floor-org-ceiling`, `dev-substrate-not-prescription`, spec section 10 + 14.5. Confirm: (a) default is `single-pass`; (b) `substrate-deep` requires an authorizing operator-intent; (c) framework code in `src/` is not touched (script-only).

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add scripts/run-cto-actor.mjs
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): add --mode=substrate-deep flag to run-cto-actor.mjs"
```

---

## Task 13: Bootstrap canon

**Files:**
- Create: `scripts/bootstrap-deep-planning-pipeline-canon.mjs`
- Verifies (no test file): generates atoms in `.lag/atoms/`

**Security + correctness considerations:**
- Bootstrap script writes operator-seeded canon atoms following the patterns in existing `scripts/bootstrap-*-canon.mjs` files. Atoms are written to `.lag/atoms/` via `host.atoms.put`; the canon-md manager renders them on next pull per `arch-canon-bracketed-section`.
- Atoms produced (each with full provenance, `principal_id: 'operator-principal'`, `layer: 'L3'`, `taint: 'clean'`):
  - `pol-planning-pipeline-stages-default` -- registers brainstorm/spec/plan/review/dispatch.
  - `pol-pipeline-stage-hil-brainstorm` -- `pause_mode: 'never'`.
  - `pol-pipeline-stage-hil-spec` -- `pause_mode: 'on-critical-finding'`.
  - `pol-pipeline-stage-hil-plan` -- `pause_mode: 'on-critical-finding'`.
  - `pol-pipeline-stage-hil-review` -- `pause_mode: 'never'`.
  - `pol-pipeline-stage-hil-dispatch` -- `pause_mode: 'on-critical-finding'`.
  - `pol-planning-pipeline-default-mode` -- `mode: 'single-pass'` (indie floor).
  - `dev-deep-planning-pipeline` -- L3 directive describing the pipeline shape (operator gates this via /decide).
- The script is idempotent: re-running with existing atoms is a no-op (uses `host.atoms.get` to pre-check).
- Atom-ids are deterministic so re-bootstrap does not duplicate.
- Per `dev-canon-proposals-via-cto-not-direct`, this bootstrap-script is the operator-ratified path for a batched seed; the operator approves by merging the PR.

- [ ] **Step 1: Author the script** (no separate test file; manual verification by running and inspecting `.lag/atoms/`).

- [ ] **Step 2: Run the script in the worktree**

```bash
node scripts/bootstrap-deep-planning-pipeline-canon.mjs --dry-run
```

Expected: prints the eight atoms to be written; no atoms persisted.

- [ ] **Step 3: Implement minimal**

Mirror the structure in any existing `scripts/bootstrap-*-canon.mjs`. Each atom uses the standard provenance shape from the spec section 9.

- [ ] **Step 4: Run the script for real**

```bash
node scripts/bootstrap-deep-planning-pipeline-canon.mjs
```

Expected: eight atoms in `.lag/atoms/`. Verify with `ls .lag/atoms/ | grep planning-pipeline`.

- [ ] **Step 5: Canon-audit subagent**

Review the script against `dev-canon-proposals-via-cto-not-direct`, `inv-l3-requires-human`, `inv-governance-before-autonomy`. Confirm: (a) every atom carries full provenance; (b) the L3 directive carries operator-approval metadata; (c) the HIL defaults match the spec section 8 indie floor; (d) the script is idempotent.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add scripts/bootstrap-deep-planning-pipeline-canon.mjs .lag/atoms/
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(planning-pipeline): bootstrap deep planning pipeline canon atoms"
```

---

## Task 14: End-to-end integration test on MemoryHost

**Files:**
- Create: `test/runtime/planning-pipeline/end-to-end.test.ts`

**Security + correctness considerations:**
- Integration test composes ALL FIVE reference stages (brainstorm + spec + plan + review + dispatch) against a `createMemoryHost()` fixture, seeds an operator-intent atom, and asserts the produced atom chain (`pipeline -> brainstorm-notes -> spec -> plan -> review-report -> dispatch-record`).
- Provenance walk: the test starts from the dispatch-record atom and walks `derived_from` backwards, asserting each upstream atom is reachable and matches the expected type. This is the substrate-level test for `arch-atomstore-source-of-truth`.
- Resume-from-stage: the test runs the pipeline, force-fails review-stage, then re-runs with `resumeFromStage: 'spec-stage'` and asserts the brainstorm-notes atom is preserved (not re-emitted) while the spec/plan/review atoms are superseded.
- Confabulation regression: a separate test seeds a spec atom with a fabricated `cited_paths` entry; asserts the review-stage's auditor catches it, emits a `pipeline-audit-finding` of severity `'critical'`, and the pipeline transitions to `failed`. This is the substrate-level test that prevents tonight's failure mode (per spec section 16 negative test).
- Malformed stages policy: a separate test seeds a `pol-planning-pipeline-stages-default` atom with an unknown stage principal; asserts the runner halts at pre-flight with a `pipeline-failed` atom (per spec section 7).

- [ ] **Step 1: Write the failing test**

Create `test/runtime/planning-pipeline/end-to-end.test.ts`. The test composes the five reference stages from `examples/planning-stages/` against a `createMemoryHost()`, seeds an operator-intent atom, and runs `runPipeline`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/planning-pipeline/end-to-end.test.ts`
Expected: FAIL (likely missing test scaffolding).

- [ ] **Step 3: Implement minimal**

Implementer composes the test from the existing fixtures. The expected atom chain is asserted by walking `provenance.derived_from`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/planning-pipeline/`
Expected: PASS, including the confabulation regression and malformed-stages negative.

- [ ] **Step 5: Canon-audit subagent**

Pass the spec section 14 threat model AND `arch-atomstore-source-of-truth`, `dev-drafter-citation-verification-required`, `inv-governance-before-autonomy` as context. Review the integration test for: (a) full atom chain assertion; (b) provenance walk-back to the seed operator-intent; (c) confabulation regression catches the substrate-level failure mode; (d) malformed-stages negative honors the pre-flight halt.

- [ ] **Step 6: Commit via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo add test/runtime/planning-pipeline/end-to-end.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "test(planning-pipeline): end-to-end with default stage set"
```

---

## Task 15: Pre-push validation + open PR

**Files:** all changed files in this branch (full-diff audit).

**Security + correctness considerations (this is the final gate; per `dev-coderabbit-cli-pre-push` + `dev-implementation-canon-audit-loop`):**
- Run the canon CLI gate on the full diff before pushing per `dev-coderabbit-cli-pre-push`. CR CLI must report zero critical and zero major findings; minor findings allowed but tracked.
- Run a single canon-compliance auditor sub-agent on the FULL DIFF (not per-task) with the spec section 14 threat model AND every L3 directive cited in this plan as context. The auditor returns Approved or Issues Found across the entire pipeline change.
- Pre-push grep checklist per memory `feedback_pre_push_grep_checklist`:
  - emdashes (CI rejects per `inv-no-private-terms`)
  - private-term leaks
  - operator personal-account login leaks (per the operator-personal-login-never-in-automation canon directive)
  - Co-Authored-By trailers (per `dev-no-claude-attribution`)
  - design/ADR refs in `src/` JSDoc (per memory `feedback_src_docs_mechanism_only_no_design_links`)
- Run `npm run typecheck && npm run build && npm test` to verify the full substrate compiles and every test passes.
- Push the branch via `git-as.mjs lag-ceo` (NEVER bare `git push` per `dev-gh-actions-require-bot-attribution`).
- Open the PR via `gh-as.mjs lag-ceo` with a Conventional Commits title per `dev-pr-titles-conventional-commits`.
- Trigger CodeRabbit review via `node scripts/cr-trigger.mjs <pr-number>` (machine-user account per `dev-cr-triggers-via-machine-user`), NEVER `gh-as lag-ceo pr comment`.

- [ ] **Step 1: Run the CR CLI on the full diff**

```bash
node scripts/cr-precheck.mjs --base main
```

Expected: zero critical, zero major findings. Address any before proceeding.

- [ ] **Step 2: Run the full canon-audit subagent on the diff**

Dispatch a canon-compliance auditor (`general-purpose` subagent_type) with prompt:

> Review the full diff on branch `feat/deep-planning-pipeline` against the spec at `docs/superpowers/specs/2026-04-28-deep-planning-pipeline-design.md` and the canon directives `inv-kill-switch-first`, `arch-atomstore-source-of-truth`, `arch-host-interface-boundary`, `dev-substrate-not-prescription`, `dev-indie-floor-org-ceiling`, `dev-judgment-ladder-required-for-llm-actors`, `dev-drafter-citation-verification-required`, `dev-canon-is-strategic-not-tactical`, `dev-canon-proposals-via-cto-not-direct`, `dev-pr-titles-conventional-commits`, `dev-no-claude-attribution`, `inv-governance-before-autonomy`, `inv-l3-requires-human`, `pol-judgment-fallback-ladder`. Confirm: (a) every spec section 1-17 has a corresponding implementation surface; (b) framework code in `src/` is mechanism-only (no concrete prompt or vendor model id); (c) atom-projected state matches `arch-atomstore-source-of-truth`; (d) the threat model from spec section 14 is fully covered; (e) the indie-floor default is `single-pass`; (f) HIL defaults match section 8; (g) the bootstrap canon atoms in `.lag/atoms/` carry full provenance; (h) no AI-attribution markers in any commit, file, or PR body. Return Approved or Issues Found with specifics.

Iterate until Approved.

- [ ] **Step 3: Run the pre-push grep checklist**

```bash
npm run lint:pre-push
```

Or, manually:

```bash
node scripts/pre-push-grep.mjs
```

Expected: zero hits across the checklist.

- [ ] **Step 4: Run the full test + typecheck + build**

```bash
npm run typecheck && npm run build && npm test
```

Expected: all green.

- [ ] **Step 5: Push the branch via lag-ceo**

```bash
node ../../scripts/git-as.mjs lag-ceo push origin feat/deep-planning-pipeline
```

- [ ] **Step 6: Open the PR via gh-as lag-ceo**

Author the PR body to a temp file, then pass it via `--body-file`. Shell heredocs are not reliable through the `gh-as.mjs` wrapper (it does not proxy stdin); use a tracked file so the body survives shell quoting:

```bash
cat > /tmp/dpp-pr-body.md <<'EOF'
## Summary

Ships the deep planning pipeline substrate per `docs/superpowers/specs/2026-04-28-deep-planning-pipeline-design.md`. Replaces the single-pass HostLlmPlanningJudgment with a pluggable, atom-projected, per-stage-audited pipeline (brainstorm + spec + plan + review + dispatch). Tactical fixes keep the existing single-pass path for cost amortization (mode-gated via `--mode=substrate-deep`).

## Surface

- `src/runtime/planning-pipeline/` (mechanism-only): types, atom-shape builders, runner state machine, canon policy parsers.
- `examples/planning-stages/` (concrete adapters per `dev-substrate-not-prescription`): five reference stages (brainstorm, spec, plan, review, dispatch).
- `scripts/run-cto-actor.mjs`: `--mode=substrate-deep` flag activates the pipeline path; default mode unchanged.
- `scripts/bootstrap-deep-planning-pipeline-canon.mjs`: operator-seeded canon atoms (default-stage policy + per-stage HIL + L3 directive).

## Test plan

- [ ] Unit tests pass: `npx vitest run test/runtime/planning-pipeline/`
- [ ] Integration test (5-stage end-to-end) passes
- [ ] Confabulation regression catches fabricated cited path
- [ ] Malformed stages policy halts at pre-flight
- [ ] Typecheck + build + full test suite green
- [ ] CR CLI pre-push gate: zero critical, zero major findings
- [ ] CodeRabbit review pass clean
EOF

node ../../scripts/gh-as.mjs lag-ceo gh pr create --base main --head feat/deep-planning-pipeline --title "feat(planning-pipeline): deep planning pipeline substrate" --body-file /tmp/dpp-pr-body.md
```

- [ ] **Step 7: Trigger CodeRabbit review via cr-trigger.mjs**

```bash
node ../../scripts/cr-trigger.mjs <pr-number>
```

Expected: CR review queued under the machine-user identity.

- [ ] **Step 8: Address CR findings via the standard pr-fix flow**

Out of scope for this plan; the executing agent transitions to the existing `pr-fix-actor` flow once CR posts findings.

---

## Open Questions (carried forward from spec section 18)

These remain unresolved by this plan and surface to the operator for triage:

1. `q-pipeline-llm-cost-attribution` -- does `cost_usd` aggregate adapter-reported costs, or is it the stage-actor's declared estimate? Implementation note: the v1 `StageOutput.cost_usd` is the stage-actor's declared estimate; adapter aggregation is a forward-compat upgrade tied to the agent-loop substrate's `tracks_cost: boolean` capability flag.
2. `q-pipeline-default-mode-bootstrap` -- does the default-mode atom flip to `substrate-deep` once Phase 55c is wired? Implementation note: ships with `single-pass` per `dev-indie-floor-org-ceiling`; flip is an operator-decision atom, not a code change.
3. `q-pipeline-stage-output-superseding` -- when `--resume-from-stage` rewinds, do downstream stage atoms get marked `superseded_by` immediately, or only after replacement atoms exist? Implementation note: v1 marks immediately on resume invocation; partial-state visibility is the trade for atom-store consistency.

---

**End of plan.** Execution proceeds via `superpowers:executing-plans` + `superpowers:subagent-driven-development`. Per `dev-coderabbit-cli-pre-push` and `dev-implementation-canon-audit-loop`, every substantive task carries the canon-audit subagent step between "tests pass" and "commit"; the final task is a CR CLI gate before push.
