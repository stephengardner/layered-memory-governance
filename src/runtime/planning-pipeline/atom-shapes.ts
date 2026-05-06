/**
 * Atom-shape builders for the deep planning pipeline.
 *
 * Each builder produces an Atom matching the canon "every atom must
 * carry provenance with a source chain" directive. Schema validation
 * via zod runs at construction time, NOT at host.atoms.put time, so
 * a malformed shape is caught at the call site (in the runner or a
 * stage adapter) rather than after the write attempt.
 *
 * Mechanism-only: this module declares NO concrete prompt, schema text,
 * or stage ordering. Stage adapters that author the prose live outside
 * src/; this module just stamps atoms.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';

/**
 * Short deterministic hash of an arbitrary string. Used to keep atom
 * ids unique when the same {severity, category} recurs across distinct
 * findings in the same stage (e.g. two cite-fail findings on the same
 * spec). 8 hex chars = 32 bits = collision probability < 2^-16 across
 * 256 findings per pipeline; the bound on findings per stage is below
 * that threshold by an order of magnitude in practice.
 */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export const PIPELINE_STATE_VALUES = [
  'pending',
  'running',
  'hil-paused',
  'failed',
  'completed',
] as const;
export type PipelineStateLabel = typeof PIPELINE_STATE_VALUES[number];

const SEVERITY = z.enum(['critical', 'major', 'minor']);
const TRANSITION = z.enum([
  'enter',
  'exit-success',
  'exit-failure',
  'hil-pause',
  'hil-resume',
  // Transition definitions for agentic stage adapters: each preserves
  // the existing event-atom shape and places transition-specific payload
  // on metadata. The type discriminator is metadata.transition, not
  // atom.type, so adding values does not change legacy event-atom
  // queries.
  'canon-bound',
  'canon-audit-complete',
  'agent-turn',
]);
const CANON_AUDIT_VERDICT = z.enum(['approved', 'issues-found']);
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
    pipeline_state: 'pending',
  };
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

/**
 * Optional payload carried by a 'canon-audit-complete' transition. The
 * canon-audit checkpoint runs after a stage's main agent loop produces
 * its output and before the runner persists the typed stage-output atom.
 * The verdict + findings are surfaced on the event atom so a console
 * deliberation-trail viewer renders the verdict without a separate
 * pipeline-audit-finding query.
 */
export interface CanonAuditFindingShape {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<string>;
  readonly cited_paths: ReadonlyArray<string>;
}

export interface MkPipelineStageEventAtomInput {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly transition:
    | 'enter'
    | 'exit-success'
    | 'exit-failure'
    | 'hil-pause'
    | 'hil-resume'
    | 'canon-bound'
    | 'canon-audit-complete'
    | 'agent-turn';
  readonly durationMs: number;
  readonly costUsd: number;
  readonly outputAtomId?: AtomId;
  /**
   * canon-bound: list of canon atom-ids the stage's agent-loop subagent
   * was bound to at the start of its session. Capped at MAX_CITED_LIST so
   * a runaway applicable-canon query cannot inflate a single event atom
   * past sane sizes.
   */
  readonly canonAtomIds?: ReadonlyArray<AtomId>;
  /**
   * canon-audit-complete: the verdict the post-output canon-audit
   * checkpoint returned. 'approved' means no halt-worthy issues;
   * 'issues-found' surfaces the findings list for HIL review.
   */
  readonly canonAuditVerdict?: 'approved' | 'issues-found';
  /**
   * canon-audit-complete: the findings list the audit produced. Capped at
   * MAX_CITED_LIST to bound a runaway audit emission.
   */
  readonly canonAuditFindings?: ReadonlyArray<CanonAuditFindingShape>;
  /**
   * agent-turn: pointer to the agent-turn atom the AgentLoopAdapter wrote
   * during this turn. The pipeline-stage-event entry is a thin index into
   * the existing agent-turn atom so console rendering does not have to
   * cross-walk by metadata fields.
   */
  readonly agentTurnAtomId?: AtomId;
  /**
   * agent-turn: zero-based index of this turn within the stage's agent
   * session. Mirrors AgentTurnMeta.turn_index from the substrate so
   * console rendering can sort without reading the agent-turn atom.
   */
  readonly turnIndex?: number;
}

export function mkPipelineStageEventAtom(input: MkPipelineStageEventAtomInput): Atom {
  TRANSITION.parse(input.transition);
  // Fail-closed at mint time on transition-specific payload shape. A
  // malformed adapter cannot smuggle an oversized canon list, an unknown
  // verdict, an out-of-bound findings array, or skip a required field for
  // its transition. Mirrors the cite-list bounding pattern enforced for
  // cited_atom_ids / cited_paths above.
  if (input.transition === 'canon-bound') {
    // canonAtomIds may be an empty list (a stage may have no applicable
    // canon directives), but the field MUST be DEFINED so the event
    // atom carries an explicit empty-list rather than an absent slot
    // that downstream renderers and audit walkers would treat as
    // "missing data" instead of "empty by design".
    if (input.canonAtomIds === undefined) {
      throw new Error(
        `mkPipelineStageEventAtom: transition='canon-bound' requires canon_atom_ids (may be [])`,
      );
    }
  }
  if (input.transition === 'canon-audit-complete') {
    if (input.canonAuditVerdict === undefined) {
      throw new Error(
        `mkPipelineStageEventAtom: transition='canon-audit-complete' requires canon_audit_verdict`,
      );
    }
  }
  if (input.transition === 'agent-turn') {
    if (input.agentTurnAtomId === undefined || input.turnIndex === undefined) {
      throw new Error(
        `mkPipelineStageEventAtom: transition='agent-turn' requires agent_turn_atom_id and turn_index`,
      );
    }
  }
  if (input.canonAtomIds !== undefined && input.canonAtomIds.length > MAX_CITED_LIST) {
    throw new Error(
      `mkPipelineStageEventAtom: canon_atom_ids capped at ${MAX_CITED_LIST}`,
    );
  }
  if (input.canonAuditVerdict !== undefined) {
    CANON_AUDIT_VERDICT.parse(input.canonAuditVerdict);
  }
  if (input.canonAuditFindings !== undefined && input.canonAuditFindings.length > MAX_CITED_LIST) {
    throw new Error(
      `mkPipelineStageEventAtom: canon_audit_findings capped at ${MAX_CITED_LIST}`,
    );
  }
  // Stamp a deterministic atom id. For 'agent-turn' transitions the id
  // additionally folds in the turn_index so a single stage's multi-turn
  // session produces N distinct event atoms (one per turn) without
  // re-using the same id and triggering an idempotent put-as-overwrite.
  // Other transitions remain {pipeline}-{stage}-{transition}-{correlation};
  // the per-stage one-event-per-transition contract is preserved.
  const idTail = input.transition === 'agent-turn' && input.turnIndex !== undefined
    ? `${input.transition}-${input.turnIndex}`
    : input.transition;
  const id = `pipeline-stage-event-${input.pipelineId}-${input.stageName}-${idTail}-${input.correlationId}` as AtomId;
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
      ...(input.canonAtomIds !== undefined
        ? { canon_atom_ids: input.canonAtomIds.map(String) }
        : {}),
      ...(input.canonAuditVerdict !== undefined
        ? { canon_audit_verdict: input.canonAuditVerdict }
        : {}),
      ...(input.canonAuditFindings !== undefined
        ? {
            // Defensive copy so a mutating caller cannot reach back through
            // the original input reference and skew the persisted finding
            // list. Mirrors the freeze pattern in runner.ts for the
            // verified-citation set.
            canon_audit_findings: input.canonAuditFindings.map((f) => ({
              severity: f.severity,
              category: f.category,
              message: f.message,
              cited_atom_ids: [...f.cited_atom_ids],
              cited_paths: [...f.cited_paths],
            })),
          }
        : {}),
      ...(input.agentTurnAtomId !== undefined
        ? { agent_turn_atom_id: input.agentTurnAtomId }
        : {}),
      ...(input.turnIndex !== undefined ? { turn_index: input.turnIndex } : {}),
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
  // Append a short deterministic hash of the message so two findings
  // sharing severity + category in the same stage do not collide on id.
  const messageDigest = shortHash(input.message);
  const id = `pipeline-audit-finding-${input.pipelineId}-${input.stageName}-${input.correlationId}-${input.severity}-${input.category}-${messageDigest}` as AtomId;
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

// ---------------------------------------------------------------------------
// Stage-output atoms (one per pipeline stage)
//
// Each stage's StageOutput.value is persisted via these mint helpers so
// the chain is observable from `host.atoms.query` alone. provenance.
// derived_from is `[pipelineId, ...priorOutputAtomIds]` so a walk back
// through the pipeline reaches the seed operator-intent. Stage adapters
// in examples/ remain unchanged: the runner mints these atoms from the
// StageOutput produced by stage.run(), preserving substrate purity (the
// stage adapter declares the output shape; the runner stamps the atom).
// Each helper:
//   - rejects an empty derivedFrom (the canon "every atom carries a
//     source chain" directive applies to every typed output);
//   - bounds content to MAX_STAGE_OUTPUT_CONTENT chars so a runaway
//     LLM emission cannot inflate atom storage;
//   - exposes the original StageOutput.value as `metadata.stage_output`
//     so the typed payload is queryable without re-parsing content.
// ---------------------------------------------------------------------------

/**
 * Hard cap on the serialized stage-output content stored in the atom.
 * Bounded so an adversarial or runaway LLM emission cannot grow an
 * atom file past sane single-record sizes. The pipeline's existing
 * per-stage budget cap and per-field schema bounds handle quality
 * signals; this is the substrate-side hard wall on what the runner
 * is allowed to persist. Anything longer is truncated with an explicit
 * marker so the truncation is visible to audit consumers, never silent.
 *
 * Exported so the runner's generic-stage-output fallback path uses the
 * same cap rather than re-declaring the constant (extracted at N=2 per
 * the duplication-floor canon).
 */
export const MAX_STAGE_OUTPUT_CONTENT = 256 * 1024;

/**
 * JSON-stringify a stage output value with a hard byte cap.
 *
 * Returns the full serialised value when under MAX_STAGE_OUTPUT_CONTENT;
 * otherwise returns the head truncated to leave room for the truncation
 * marker so the truncation is visible (never silent). Stage adapters
 * that need the full value beyond the cap should write it as a separate
 * atom and cite it from metadata.
 *
 * Exported so the runner's generic-stage-output fallback path reuses
 * this single implementation rather than re-declaring it (extracted at
 * N=2 per the duplication-floor canon).
 */
export function serializeStageOutput(value: unknown): string {
  const TRUNCATION_MARKER = '\n\n... [stage-output truncated; full value exceeded MAX_STAGE_OUTPUT_CONTENT] ...';
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    // Non-serialisable value (e.g. a circular reference); fall back to
    // a marker rather than throwing. The runner cannot verify
    // serialisability before invoking this helper because the
    // outputSchema validator is the authoritative shape gate.
    return '[stage-output not JSON-serialisable]';
  }
  if (json === undefined) {
    // JSON.stringify returns undefined for `undefined` and for some
    // function-only values; record the typeof so audit consumers see
    // why content is empty.
    return `[stage-output not representable: typeof=${typeof value}]`;
  }
  if (json.length <= MAX_STAGE_OUTPUT_CONTENT) return json;
  const head = json.slice(0, MAX_STAGE_OUTPUT_CONTENT - TRUNCATION_MARKER.length);
  return head + TRUNCATION_MARKER;
}

/**
 * Shared input shape for the four new stage-output mint helpers. The
 * plan-stage uses `mkPlanOutputAtoms` below, which threads through the
 * same canonical Plan atom shape used by the single-pass
 * planning-actor so console plan-detail and downstream consumers do
 * not branch on pipeline vs single-pass origin.
 */
export interface MkStageOutputAtomBaseInput {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  /**
   * The full provenance chain back through prior stages to the
   * pipeline atom (and through it, the seed operator-intent). Must
   * be non-empty: a stage-output atom that does not chain to the
   * pipeline atom cannot be discovered via the dispatch-stage's
   * planFilter or any audit walk.
   */
  readonly derivedFrom: ReadonlyArray<AtomId>;
  /**
   * The StageOutput.value the stage adapter produced. Persisted in
   * metadata.stage_output for queryable shape preservation; also
   * serialized into atom.content (with hard byte cap) so the atom's
   * primary surface remains a human-readable artifact.
   */
  readonly value: unknown;
  /**
   * Optional supplementary metadata the runner wants on the atom
   * (e.g. stage-specific cost breakdown, model id, latency). Merged
   * shallow under the standard pipeline_id + stage_name fields; the
   * runner-supplied keys win on collision because they are
   * load-bearing for cross-stage walking.
   */
  readonly extraMetadata?: Record<string, unknown>;
}

/**
 * Project a StageOutput.value into a JSON-safe form for embedding in
 * atom metadata. The value flows through serializeStageOutput first so
 * the size cap + circular-reference + non-serialisable fallbacks all
 * apply uniformly to metadata. JSON-serialisable values round-trip
 * through JSON.parse so the metadata stays a structured object (and
 * audit consumers can query nested fields without re-parsing); fallback
 * markers stay as the bare string the serialiser returned, which is
 * itself JSON-safe.
 *
 * Without this projection, embedding the raw value bypasses the size
 * cap an adversarial / runaway LLM emission would otherwise grow
 * unchecked through metadata. Atom storage adapters that JSON-encode
 * the metadata field on persist would also fail outright on a circular
 * value; the projection's marker fallback keeps writes proceeding.
 *
 * Exported so the runner's generic-stage-output fallback path uses the
 * same projection rather than re-declaring it (extracted at N=2 per
 * the duplication-floor canon).
 */
export function projectStageOutputForMetadata(value: unknown): unknown {
  const serialized = serializeStageOutput(value);
  if (
    serialized === '[stage-output not JSON-serialisable]'
    || serialized.startsWith('[stage-output not representable:')
    || serialized.includes('[stage-output truncated')
  ) {
    // Fallback markers are bare strings; embed them as-is so audit
    // consumers see the marker directly under metadata.stage_output.
    return serialized;
  }
  // serializeStageOutput already validated JSON.stringify succeeded,
  // so JSON.parse cannot throw on the projected string.
  return JSON.parse(serialized);
}

/**
 * Local helper: build the metadata block shared by every
 * stage-output atom. The pipeline_id + stage_name + stage_output
 * keys are load-bearing for the dispatch-stage's planFilter and for
 * audit consumers; runner-supplied fields take precedence over any
 * collision in extraMetadata so a stage adapter cannot accidentally
 * shadow them. stage_output is always passed through
 * projectStageOutputForMetadata so the serialise hard-cap +
 * circular-reference fallback apply to metadata writes too.
 */
function buildStageOutputMetadata(
  input: MkStageOutputAtomBaseInput,
): Record<string, unknown> {
  return {
    ...(input.extraMetadata ?? {}),
    pipeline_id: input.pipelineId,
    stage_name: input.stageName,
    stage_output: projectStageOutputForMetadata(input.value),
  };
}

/**
 * Local helper: enforce the non-empty derivedFrom invariant for every
 * stage-output mint. Extracted at N=2+ per the duplication-floor
 * canon; mint helpers must NEVER produce a stage-output atom with an
 * empty provenance chain because a chain-less atom is invisible to
 * the dispatch-stage's planFilter and to every audit walk.
 */
function requireNonEmptyDerivedFrom(
  helperName: string,
  derivedFrom: ReadonlyArray<AtomId>,
): void {
  if (derivedFrom.length === 0) {
    throw new Error(
      `${helperName}: derivedFrom must be non-empty (provenance directive)`,
    );
  }
}

/**
 * Slugify a stage name for inclusion in deterministic atom ids.
 * Mirrors the slugifyPlanTitle helper below; the same kebab-cased,
 * lowercase shape keeps stage-output ids parseable from the id alone.
 */
function slugifyStageName(stageName: string): string {
  return stageName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build the deterministic id used by every stage-output mint helper.
 * Format: `<typePrefix>-<pipelineId>-<stageSlug>-<correlationId>`.
 *
 * Including the stage slug ensures per-stage uniqueness when an
 * org-ceiling deployment registers two stages whose adapters declare
 * the SAME atom_type (e.g. two different review-stage variants both
 * emitting 'review-report'); without the stage slug the second stage's
 * id would collide with the first. Within a single stage, two writes
 * for the same {pipelineId, stageName, correlationId} collide rather
 * than create siblings (idempotent put on resume).
 */
function stageOutputAtomId(
  typePrefix: string,
  input: MkStageOutputAtomBaseInput,
): AtomId {
  const stageSlug = slugifyStageName(input.stageName);
  return `${typePrefix}-${input.pipelineId}-${stageSlug}-${input.correlationId}` as AtomId;
}

// ---------------------------------------------------------------------------
// brainstorm-output atom
// ---------------------------------------------------------------------------

export function mkBrainstormOutputAtom(input: MkStageOutputAtomBaseInput): Atom {
  requireNonEmptyDerivedFrom('mkBrainstormOutputAtom', input.derivedFrom);
  const id = stageOutputAtomId('brainstorm-output', input);
  return baseAtom({
    id,
    type: 'brainstorm-output',
    content: serializeStageOutput(input.value),
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: input.derivedFrom,
    metadata: buildStageOutputMetadata(input),
  });
}

// ---------------------------------------------------------------------------
// spec-output atom
// ---------------------------------------------------------------------------

export function mkSpecOutputAtom(input: MkStageOutputAtomBaseInput): Atom {
  requireNonEmptyDerivedFrom('mkSpecOutputAtom', input.derivedFrom);
  const id = stageOutputAtomId('spec-output', input);
  return baseAtom({
    id,
    type: 'spec-output',
    content: serializeStageOutput(input.value),
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: input.derivedFrom,
    metadata: buildStageOutputMetadata(input),
  });
}

// ---------------------------------------------------------------------------
// review-report atom
// ---------------------------------------------------------------------------

export function mkReviewReportAtom(input: MkStageOutputAtomBaseInput): Atom {
  requireNonEmptyDerivedFrom('mkReviewReportAtom', input.derivedFrom);
  const id = stageOutputAtomId('review-report', input);
  return baseAtom({
    id,
    type: 'review-report',
    content: serializeStageOutput(input.value),
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: input.derivedFrom,
    metadata: buildStageOutputMetadata(input),
  });
}

// ---------------------------------------------------------------------------
// dispatch-record atom
// ---------------------------------------------------------------------------

export function mkDispatchRecordAtom(input: MkStageOutputAtomBaseInput): Atom {
  requireNonEmptyDerivedFrom('mkDispatchRecordAtom', input.derivedFrom);
  const id = stageOutputAtomId('dispatch-record', input);
  return baseAtom({
    id,
    type: 'dispatch-record',
    content: serializeStageOutput(input.value),
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: input.derivedFrom,
    metadata: buildStageOutputMetadata(input),
  });
}

// ---------------------------------------------------------------------------
// plan atom (deep-pipeline plan-stage output; reuses the canonical
// 'plan' type so single-pass and pipeline-emitted plans share one
// downstream shape).
//
// The single-pass planning-actor's buildPlanAtom is the authoritative
// single-pass shape; this helper produces a plan atom in the same
// shape from a plan-stage StageOutput.value (which carries the
// PlanPayload.plans array under the key 'plans'). Each plan in the
// payload becomes one plan atom; the helper returns a frozen
// ReadonlyArray<Atom> so callers get a single allocation per stage
// run. Empty plans arrays return [] -- the runner's outputSchema
// validation at plan-stage rejects an empty plans array upstream, so
// reaching this helper with an empty list means the schema bounds
// were loosened, which is a separate canon-edit moment.
// ---------------------------------------------------------------------------

export interface MkPlanOutputAtomsInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly derivedFrom: ReadonlyArray<AtomId>;
  /**
   * The plan-stage StageOutput.value object whose `plans` key is an
   * array of plan entries (matching the plan adapter's
   * planEntrySchema in examples/planning-stages/plan/index.ts).
   * Typed loosely as `unknown` so this helper does not depend on the
   * plan-stage adapter module; the helper extracts an array under the
   * `plans` key and returns [] when the shape is missing or empty.
   */
  readonly value: unknown;
  /**
   * Optional supplementary metadata threaded from `StageOutput.extraMetadata`
   * into every minted plan atom. Mirrors `MkStageOutputAtomBaseInput.extraMetadata`
   * for the plan-stage shape so a stage-runner-resolved fact (e.g.
   * canon_directives_applied) is recorded uniformly across stage shapes.
   * Shallow-merged into each plan atom's `metadata` BELOW the plan-specific
   * keys (title, pipeline_id, principles_applied, etc.) so the plan-shape
   * keys win on collision; downstream readers that key on `delegation` /
   * `principles_applied` cannot be surprised by a stage-runner stamping
   * a same-named bag.
   */
  readonly extraMetadata?: Readonly<Record<string, unknown>>;
}

interface PlanEntryLike {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly derived_from?: ReadonlyArray<unknown>;
  readonly principles_applied?: ReadonlyArray<unknown>;
  readonly alternatives_rejected?: ReadonlyArray<unknown>;
  readonly what_breaks_if_revisit?: unknown;
  readonly confidence?: unknown;
  readonly delegation?: {
    readonly sub_actor_principal_id?: unknown;
    readonly reason?: unknown;
    readonly implied_blast_radius?: unknown;
  };
}

/**
 * Plan-shape metadata keys that are load-bearing for downstream
 * consumers (dispatch reads `delegation`, projections read `title` /
 * `pipeline_id`, audit walks read `principles_applied` /
 * `alternatives_rejected` / `what_breaks_if_revisit`). A stage-runner-
 * supplied `extraMetadata` must NEVER write any of these keys onto a
 * plan atom -- the canonical values come from the plan entry shape, not
 * from the open-ended stamp bag. Filtering at the merge site fences
 * every key uniformly, even when the plan-shape side resolves to an
 * empty object (e.g. an entry without `delegation` produces
 * `delegationMetadata = {}` and a naive spread-then-overwrite would NOT
 * shadow an `extraMetadata.delegation`).
 */
const RESERVED_PLAN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'title',
  'pipeline_id',
  'principles_applied',
  'alternatives_rejected',
  'what_breaks_if_revisit',
  'delegation',
]);

/**
 * Strip reserved plan-shape keys from a stage-runner-supplied
 * extraMetadata bag before merging into a plan atom's metadata.
 * Returns an empty object when the input is undefined so the caller
 * can spread the result unconditionally.
 */
function omitReservedPlanMetadata(
  extra: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (RESERVED_PLAN_METADATA_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function slugifyPlanTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Mint the plan atoms for a plan-stage StageOutput.value. Returns one
 * atom per plan entry in the payload; the runner persists each before
 * advancing to the review stage so the dispatch-stage's planFilter
 * can find them by walking derived_from.
 *
 * Every plan atom is shaped to match the single-pass planning-actor
 * buildPlanAtom output: `type: 'plan'`, `layer: 'L1'`, `plan_state:
 * 'proposed'`, with title / principles_applied / alternatives_rejected
 * / what_breaks_if_revisit / delegation in metadata. The deterministic
 * id format is `plan-<title-slug>-<principalId>-<pipelineId>-<index>`
 * so two plans in the same payload do not collide and a re-emit by a
 * resumed pipeline produces the same id (idempotent put on the
 * memory-host adapter).
 */
export function mkPlanOutputAtoms(input: MkPlanOutputAtomsInput): ReadonlyArray<Atom> {
  requireNonEmptyDerivedFrom('mkPlanOutputAtoms', input.derivedFrom);
  const value = input.value;
  if (typeof value !== 'object' || value === null) return [];
  const plansRaw = (value as { plans?: unknown }).plans;
  if (!Array.isArray(plansRaw) || plansRaw.length === 0) return [];

  const atoms: Atom[] = [];
  for (let i = 0; i < plansRaw.length; i++) {
    const entry = plansRaw[i] as PlanEntryLike;
    const title = asString(entry.title, '(untitled)');
    const slug = slugifyPlanTitle(title);
    // Deterministic id includes both the principalId (so two
    // principals running the same plan-stage payload do not collide)
    // and a per-entry index (so a payload with multiple plans
    // produces distinct atoms even when their titles slug-collide).
    // The pipelineId namespace ensures cross-pipeline isolation.
    const id =
      `plan-${slug}-${input.principalId}-${input.pipelineId}-${i}` as AtomId;

    // Build derived_from: start with the runner-supplied chain
    // (pipelineId + prior stage outputs) and append the plan entry's
    // own derived_from list so the chain captures BOTH the pipeline
    // provenance AND the LLM-cited atoms the plan claims to derive
    // from. The plan-stage's audit pass already verified those
    // citations resolve and are in the verified-citations set; the
    // runner does not re-validate here.
    const planDerivedFrom: AtomId[] = [
      ...input.derivedFrom,
      ...asStringArray(entry.derived_from).map((s) => s as AtomId),
    ];

    const principlesApplied = asStringArray(entry.principles_applied);
    const alternativesRejected = Array.isArray(entry.alternatives_rejected)
      ? entry.alternatives_rejected
        .filter((a): a is { option: string; reason: string } =>
          typeof a === 'object'
          && a !== null
          && typeof (a as { option?: unknown }).option === 'string'
          && typeof (a as { reason?: unknown }).reason === 'string',
        )
      : [];

    const delegation = entry.delegation;
    const delegationMetadata =
      delegation !== undefined && typeof delegation === 'object' && delegation !== null
        ? {
            delegation: {
              sub_actor_principal_id: asString(delegation.sub_actor_principal_id),
              reason: asString(delegation.reason),
              implied_blast_radius: asString(delegation.implied_blast_radius),
            },
          }
        : {};

    atoms.push({
      schema_version: 1,
      id,
      content: asString(entry.body, '(empty plan body)'),
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: {
          tool: 'planning-pipeline',
          agent_id: String(input.principalId),
          session_id: input.correlationId,
        },
        derived_from: planDerivedFrom,
      },
      confidence: asNumber(entry.confidence, 0.8),
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
      plan_state: 'proposed',
      metadata: {
        // Filter reserved plan-shape keys out of extraMetadata BEFORE
        // merging so a misbehaving stage runner cannot hijack a
        // load-bearing plan field. Spread-then-overwrite is unsafe for
        // a plan-entry that has NO delegation: delegationMetadata
        // resolves to {} and the spread does not overwrite an
        // extraMetadata.delegation, which would let the stamp inject
        // an authoritative delegation that downstream dispatch reads.
        // Filtering at write time fences every shape key uniformly,
        // including the conditional delegation key.
        ...omitReservedPlanMetadata(input.extraMetadata),
        title,
        pipeline_id: input.pipelineId,
        principles_applied: [...principlesApplied],
        alternatives_rejected: alternativesRejected.map((a) => a.option),
        what_breaks_if_revisit: asString(entry.what_breaks_if_revisit),
        ...delegationMetadata,
      },
    });
  }
  return atoms;
}
