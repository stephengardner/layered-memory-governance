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
  // Re-prompt loop transitions (auditor-feedback feedback loop). Emit
  // 'retry-after-findings' when the runner re-invokes the same stage
  // with prior audit findings folded into the prompt context; the
  // attempt_index discriminates the multiple events one stage now
  // emits per run (attempt 1 + attempt 2 each emit enter/exit pairs,
  // plus a single retry-after-findings event between them). Mirrors
  // the per-stage one-event-per-transition contract: a stage that
  // re-prompts once emits exactly one retry-after-findings event.
  'retry-after-findings',
  // Plan-stage validator-retry loop. Emit 'validator-retry-after-failure'
  // when the runner re-invokes the same stage with a prior
  // schema-validation error folded into the prompt context; the
  // attempt_index discriminates multiple events emitted by one stage
  // (attempt 1 schema-fails + attempt 2 schema-fails + final halt all
  // surface as distinct atoms). Sibling of 'retry-after-findings':
  // teaches back AFTER schema validation but BEFORE persistence + audit,
  // matching the substrate-side `decideValidatorRetryAction` decision
  // shape. A stage that retries once on a validator failure emits
  // exactly one validator-retry-after-failure event.
  'validator-retry-after-failure',
]);
const CANON_AUDIT_VERDICT = z.enum(['approved', 'issues-found']);
const AUDIT_STATUS = z.enum(['unchecked', 'clean', 'findings']);
const MODE = z.enum(['single-pass', 'substrate-deep']);

const MAX_CITED_LIST = 256;

/**
 * Hard cap on the validator error message stored on a
 * `validator-retry-after-failure` event atom. Bounds the message so a
 * deeply-nested Zod error (a multi-issue payload, a refinement chain)
 * cannot inflate the event atom past sane sizes. The runner truncates
 * before mint via the same bound; this constant is the mint-side guard
 * that catches a direct-mint caller bypassing the trim. Exported so
 * the runner can reference the same constant via the helper rather
 * than re-declaring it (extracted at N=2 per the duplication-floor
 * canon).
 */
export const MAX_VALIDATOR_ERROR_MESSAGE_LEN = 4096;

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

/**
 * Upfront cost projection stamped on the pipeline atom at run-start.
 * `projected_total_usd` is the sum of every stage's effective cap
 * (stage.budget_cap_usd or canon pol-pipeline-stage-cost-cap), or null
 * when any stage is uncapped (no projection possible). Console + audit
 * walks read this to surface "estimated total" alongside the running
 * `total_cost_usd`.
 */
export interface PipelineCostProjection {
  readonly projected_total_usd: number | null;
  readonly capped_stage_count: number;
  readonly uncapped_stage_names: ReadonlyArray<string>;
}

export interface MkPipelineAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  readonly stagePolicyAtomId: string;
  readonly mode: 'single-pass' | 'substrate-deep';
  readonly costProjection?: PipelineCostProjection;
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
        ...(input.costProjection !== undefined
          ? { cost_projection: input.costProjection }
          : {}),
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
    | 'agent-turn'
    | 'retry-after-findings'
    | 'validator-retry-after-failure';
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
  /**
   * retry-after-findings: 1-based attempt index the runner is ABOUT to
   * invoke after this retry event. The attempt that just produced the
   * findings is `attemptIndex - 1`; attempt 2 (the first re-prompt)
   * carries `attemptIndex = 2`. The 1-based shape matches the spec
   * section 4.3 ("attempt_index") and the way operators count
   * attempts; the runner is the only writer so the off-by-one is
   * contained.
   */
  readonly attemptIndex?: number;
  /**
   * retry-after-findings: severity-bucketed count of the findings the
   * just-completed attempt produced. Surfaced on the event metadata so
   * a console projection or audit walk renders "stage X retried after
   * 1 critical / 2 major / 0 minor" without re-walking the per-finding
   * atoms. The runner builds this from the findings list at emit time.
   */
  readonly findingsSummary?: {
    readonly critical: number;
    readonly major: number;
    readonly minor: number;
  };
  /**
   * validator-retry-after-failure: the validator (zod) error message
   * the just-completed attempt produced. Surfaced on the event metadata
   * so a console projection or audit walk renders the exact error
   * without re-walking persisted stage-output atoms (which the runner
   * does NOT write on a validator failure -- the failed payload never
   * lands on disk, mirroring the existing schema-validation-failed
   * halt path). Bounded at MAX_VALIDATOR_ERROR_MESSAGE_LEN so a runaway
   * Zod emission cannot inflate the event atom past sane sizes; the
   * runner truncates with an explicit marker.
   */
  readonly validatorErrorMessage?: string;
  /**
   * 1-based re-entry counter for cross-stage walks. Set when a stage
   * is re-entered AFTER its first entry within the same pipeline run
   * (a cross-stage re-prompt walked the runner back to an upstream
   * stage and is now re-running it). When >= 2 the helper appends
   * `-re-entry-<n>` to the atom id so the second / third / Nth entry
   * does not collide with the first; metadata.stage_entry_index
   * stamps the same value. Absent (or 1) preserves the existing id
   * shape so pre-cross-stage pipelines stay round-trippable.
   */
  readonly stageEntryIndex?: number;
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
  if (input.transition === 'retry-after-findings') {
    // The retry event MUST carry the attempt index the runner is about
    // to invoke. Without it, an audit walk cannot tell two distinct
    // retry events on the same stage (max_attempts > 2) apart -- the
    // atom-id discriminator below depends on a defined attempt index
    // for uniqueness. findingsSummary is optional in the schema sense
    // (a malformed summary is recoverable) but the runner emits it on
    // every retry, so when present we validate the per-bucket counts.
    if (input.attemptIndex === undefined) {
      throw new Error(
        `mkPipelineStageEventAtom: transition='retry-after-findings' requires attempt_index`,
      );
    }
    if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 2) {
      throw new Error(
        `mkPipelineStageEventAtom: attempt_index must be an integer >= 2 (got ${input.attemptIndex}); `
          + 'attempt 1 produces the first audit, attempt 2 is the first re-prompt.',
      );
    }
    if (input.findingsSummary !== undefined) {
      const { critical, major, minor } = input.findingsSummary;
      if (
        !Number.isInteger(critical) || critical < 0
        || !Number.isInteger(major) || major < 0
        || !Number.isInteger(minor) || minor < 0
      ) {
        throw new Error(
          `mkPipelineStageEventAtom: findings_summary buckets must be non-negative integers`,
        );
      }
    }
  }
  if (input.transition === 'validator-retry-after-failure') {
    // The validator-retry event MUST carry the attempt index the
    // runner is about to invoke, mirroring retry-after-findings.
    // Without it, an audit walk cannot tell two distinct retry events
    // on the same stage (max_attempts > 2) apart -- the atom-id
    // discriminator below depends on a defined attempt index for
    // uniqueness. validatorErrorMessage is required: the event's whole
    // purpose is to record the validator error the runner is teaching
    // back; an event with no error message is the canon-broken shape
    // (a "retry without context" event).
    if (input.attemptIndex === undefined) {
      throw new Error(
        `mkPipelineStageEventAtom: transition='validator-retry-after-failure' requires attempt_index`,
      );
    }
    if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 2) {
      throw new Error(
        `mkPipelineStageEventAtom: attempt_index must be an integer >= 2 (got ${input.attemptIndex}); `
          + 'attempt 1 produces the first validator failure, attempt 2 is the first retry.',
      );
    }
    if (input.validatorErrorMessage === undefined
        || typeof input.validatorErrorMessage !== 'string'
        || input.validatorErrorMessage.length === 0) {
      throw new Error(
        `mkPipelineStageEventAtom: transition='validator-retry-after-failure' requires `
          + `validator_error_message (non-empty string)`,
      );
    }
    if (input.validatorErrorMessage.length > MAX_VALIDATOR_ERROR_MESSAGE_LEN) {
      // Defensive bound; the runner truncates at emit time but a
      // direct mint caller could pass an unbounded value. Fail loud
      // rather than silently truncating since the atom contract is
      // "the message is what the validator saw"; if the caller wants
      // truncation, they invoke the runner-side trim helper.
      throw new Error(
        `mkPipelineStageEventAtom: validator_error_message length `
          + `${input.validatorErrorMessage.length} exceeds MAX_VALIDATOR_ERROR_MESSAGE_LEN `
          + `${MAX_VALIDATOR_ERROR_MESSAGE_LEN}; truncate at the call site before minting.`,
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
  // Same posture for 'retry-after-findings' and
  // 'validator-retry-after-failure': max_attempts > 2 means a stage
  // may emit multiple retry events, each carrying a distinct
  // attempt_index. Other transitions remain
  // {pipeline}-{stage}-{transition}-{correlation}; the per-stage
  // one-event-per-transition contract is preserved.
  let idTail = input.transition as string;
  if (input.transition === 'agent-turn' && input.turnIndex !== undefined) {
    idTail = `${input.transition}-${input.turnIndex}`;
  } else if (input.transition === 'retry-after-findings' && input.attemptIndex !== undefined) {
    idTail = `${input.transition}-${input.attemptIndex}`;
  } else if (input.transition === 'validator-retry-after-failure' && input.attemptIndex !== undefined) {
    idTail = `${input.transition}-${input.attemptIndex}`;
  }
  // Cross-stage re-entry suffix. When a stage is re-entered via a
  // cross-stage walk (stageEntryIndex >= 2) the suffix discriminates
  // the second / third / Nth enter-exit event pair from the first.
  // Absent (or 1) preserves the historical id shape so the first
  // entry's events remain at the canonical id. Applies to ALL
  // transitions so the second entry's enter/exit/retry events all
  // stamp distinct ids; otherwise enter on the second entry would
  // collide with enter on the first.
  const validatedEntryIndex = safeAttemptIndexSuffix(input.stageEntryIndex);
  const entrySuffix = validatedEntryIndex !== undefined
    ? `-re-entry-${validatedEntryIndex}`
    : '';
  const id = `pipeline-stage-event-${input.pipelineId}-${input.stageName}-${idTail}-${input.correlationId}${entrySuffix}` as AtomId;
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
      ...(input.attemptIndex !== undefined ? { attempt_index: input.attemptIndex } : {}),
      ...(input.findingsSummary !== undefined
        ? {
            findings_summary: {
              critical: input.findingsSummary.critical,
              major: input.findingsSummary.major,
              minor: input.findingsSummary.minor,
            },
          }
        : {}),
      ...(input.validatorErrorMessage !== undefined
        ? { validator_error_message: input.validatorErrorMessage }
        : {}),
      ...(validatedEntryIndex !== undefined
        ? { stage_entry_index: validatedEntryIndex }
        : {}),
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
  /**
   * 1-based attempt index from the auditor-feedback re-prompt loop;
   * appended to the atom id when >= 2 so a finding that recurs across
   * attempts does not collide on the canonical
   * {severity, category, messageDigest} id. Omitted (or 1) preserves
   * the pre-loop atom id shape so existing audit walks stay readable.
   * The stamp also lands on metadata.attempt_index for query-side
   * filtering by attempt.
   */
  readonly attemptIndex?: number;
  /**
   * 1-based re-entry counter for cross-stage walks. Mirrors the
   * stage-event atom's shape: when a stage is re-entered via a
   * cross-stage walk and emits findings on the second / third / Nth
   * entry, the suffix discriminates the per-entry atoms. Without
   * this discriminator, two entries that emitted findings with the
   * same {severity, category, messageDigest} would collide on the
   * deterministic id. Absent (or 1) preserves the existing id shape.
   */
  readonly stageEntryIndex?: number;
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
  // Append an attempt suffix when the runner is on a re-prompt
  // (attemptIndex >= 2) so a finding that recurs across attempts
  // produces a distinct atom per attempt rather than colliding on
  // {severity, category, messageDigest}. Attempt 1 (or absent /
  // malformed) preserves the historical id shape so existing
  // audit-walk fixtures and live consumers stay round-trippable.
  // Mirrors the stage-output id suffix policy via safeAttemptIndexSuffix.
  const validatedAttempt = safeAttemptIndexSuffix(input.attemptIndex);
  const attemptSuffix = validatedAttempt !== undefined
    ? `-attempt-${validatedAttempt}`
    : '';
  const validatedEntryIndex = safeAttemptIndexSuffix(input.stageEntryIndex);
  const entrySuffix = validatedEntryIndex !== undefined
    ? `-re-entry-${validatedEntryIndex}`
    : '';
  const id = `pipeline-audit-finding-${input.pipelineId}-${input.stageName}-${input.correlationId}-${input.severity}-${input.category}-${messageDigest}${attemptSuffix}${entrySuffix}` as AtomId;
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
      ...(validatedAttempt !== undefined
        ? { attempt_index: validatedAttempt }
        : {}),
      ...(validatedEntryIndex !== undefined
        ? { stage_entry_index: validatedEntryIndex }
        : {}),
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
// pipeline-cross-stage-reprompt atom (one per cross-stage re-prompt event)
//
// Written by the runner when an auditor's finding directs re-invocation
// of an upstream stage rather than the current stage. The atom is the
// visibility surface for the back-and-forth deliberation thread: the
// metadata fields carry enough state for a Console or audit consumer
// to render the FROM -> TO handoff without re-walking the per-stage
// event chain.
//
// `thread_parent` is the chain pointer used by the Console renderer:
// the first re-prompt in a chain has `thread_parent: null` (root); each
// subsequent re-prompt within the same pipeline points at the
// immediately prior re-prompt atom's id. Renderers walk the chain via
// this field rather than scanning derived_from, which keeps
// derived_from as a flat unordered set of taint roots and
// thread_parent as a render-only ordering hint.
// ---------------------------------------------------------------------------

/**
 * Shape of the finding payload embedded under metadata.finding on a
 * pipeline-cross-stage-reprompt atom. Mirrors the AuditFinding
 * interface but materialised as a JSON-serialisable record so the
 * persisted shape round-trips through the AtomStore unchanged.
 */
export interface CrossStageRepromptFindingShape {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<string>;
  readonly cited_paths: ReadonlyArray<string>;
  readonly reprompt_target: string;
}

export interface MkPipelineCrossStageRepromptAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  /** Auditing stage that emitted the finding. */
  readonly fromStage: string;
  /** Upstream stage the runner is about to re-invoke. */
  readonly toStage: string;
  /** Finding payload preserved verbatim on metadata. */
  readonly finding: CrossStageRepromptFindingShape;
  /**
   * Cumulative pipeline attempt counter at re-prompt time. Mirrors
   * the unified attempt counter the runner increments across every
   * retry mechanism so a single field captures "which iteration was
   * I on when this re-prompt fired".
   */
  readonly attempt: number;
  /**
   * Atom id of the immediately prior cross-stage re-prompt atom in
   * the same pipeline, or `null` for the first re-prompt in the
   * chain. Renderers walk this field to reconstruct the deliberation
   * thread; substrate persists it on metadata.thread_parent so a
   * single read drives the rendering.
   */
  readonly threadParent: AtomId | null;
  /**
   * Source-roots for the re-prompt event. MUST include the pipeline
   * atom id; SHOULD include the source observation atom id (the atom
   * that carried the finding, e.g. the upstream stage-output atom
   * the finding's cited_atom_ids reference). Mirrors the derived_from
   * shape used elsewhere in the pipeline subgraph: a flat unordered
   * set of taint roots.
   */
  readonly sourceRoots: ReadonlyArray<AtomId>;
  /**
   * Annotation per spec citation-drift option A: when the cross-stage
   * walk re-invokes the target stage, the runner re-derives
   * verifiedCitedAtomIds from the latest upstream atoms in scope. This
   * field labels which run's upstream the citations were resolved
   * against so the Console projection and audit trail show explicitly
   * "the re-runs after this re-prompt grounded against attempt-N of
   * stage-X".
   */
  readonly verifiedCitedAtomIdsOrigin: string;
}

/**
 * Maximum bytes of the persisted finding.message field. Bounds an
 * over-long auditor emission so the visibility atom cannot grow past
 * sane sizes. Mirrors the per-finding cap in
 * `auditor-feedback-reprompt.ts`; truncation marker preserved so the
 * trim is visible to audit consumers.
 */
const MAX_CROSS_STAGE_FINDING_MESSAGE_LEN = 4096;

export function mkPipelineCrossStageRepromptAtom(
  input: MkPipelineCrossStageRepromptAtomInput,
): Atom {
  if (input.fromStage.length === 0) {
    throw new Error(
      'mkPipelineCrossStageRepromptAtom: fromStage must be non-empty',
    );
  }
  if (input.toStage.length === 0) {
    throw new Error(
      'mkPipelineCrossStageRepromptAtom: toStage must be non-empty',
    );
  }
  if (input.fromStage === input.toStage) {
    throw new Error(
      'mkPipelineCrossStageRepromptAtom: fromStage and toStage must differ '
        + '(self-target findings route through the intra-stage path, not here)',
    );
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error(
      `mkPipelineCrossStageRepromptAtom: attempt must be a positive integer (got ${input.attempt})`,
    );
  }
  if (input.sourceRoots.length === 0) {
    throw new Error(
      'mkPipelineCrossStageRepromptAtom: sourceRoots must be non-empty (provenance directive)',
    );
  }
  if (!input.sourceRoots.includes(input.pipelineId)) {
    throw new Error(
      'mkPipelineCrossStageRepromptAtom: sourceRoots must include pipelineId '
        + 'so the provenance chain stays attached to the pipeline subgraph',
    );
  }
  if (input.finding.cited_atom_ids.length > MAX_CITED_LIST) {
    throw new Error(
      `mkPipelineCrossStageRepromptAtom: finding.cited_atom_ids capped at ${MAX_CITED_LIST}`,
    );
  }
  if (input.finding.cited_paths.length > MAX_CITED_LIST) {
    throw new Error(
      `mkPipelineCrossStageRepromptAtom: finding.cited_paths capped at ${MAX_CITED_LIST}`,
    );
  }
  // Bound the message to keep atom storage bounded. Truncate with an
  // explicit marker so the trim is visible to audit consumers rather
  // than silently disappearing.
  const TRUNCATION_MARKER = '... [truncated]';
  const boundedMessage = input.finding.message.length > MAX_CROSS_STAGE_FINDING_MESSAGE_LEN
    ? `${input.finding.message.slice(
        0,
        MAX_CROSS_STAGE_FINDING_MESSAGE_LEN - TRUNCATION_MARKER.length,
      )}${TRUNCATION_MARKER}`
    : input.finding.message;
  // Atom id folds in the attempt counter so a pipeline that emits
  // multiple cross-stage re-prompts produces distinct atoms (one per
  // re-prompt) rather than colliding on the canonical
  // {pipelineId, fromStage, toStage} key. The attempt counter is the
  // discriminator because the unified counter is the only field
  // guaranteed to advance between re-prompts (the from/to pair may
  // recur exactly when a recurring root cause keeps the loop alive
  // until the cap fires).
  const id = `pipeline-cross-stage-reprompt-${input.pipelineId}-${input.fromStage}-${input.toStage}-attempt-${input.attempt}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-cross-stage-reprompt',
    content: `${input.fromStage} -> ${input.toStage}: ${input.finding.category}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [...input.sourceRoots],
    metadata: {
      pipeline_id: input.pipelineId,
      correlation_id: input.correlationId,
      from_stage: input.fromStage,
      to_stage: input.toStage,
      attempt: input.attempt,
      thread_parent: input.threadParent,
      verified_cited_atom_ids_origin: input.verifiedCitedAtomIdsOrigin,
      finding: {
        severity: input.finding.severity,
        category: input.finding.category,
        message: boundedMessage,
        cited_atom_ids: [...input.finding.cited_atom_ids],
        cited_paths: [...input.finding.cited_paths],
        reprompt_target: input.finding.reprompt_target,
      },
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
  /**
   * 1-based index of the attempt that produced this output. Omitted
   * (or 1) on first-attempt writes for ID backward-compatibility; set
   * to 2+ on re-prompt attempts so the persisted stage-output atom
   * does not collide with the prior attempt's atom id under the
   * auditor-feedback re-prompt loop. The runner emits the index on
   * metadata.attempt_index so an audit walk can show the per-attempt
   * payload trail without parsing the atom id.
   *
   * Substrate posture: optional + back-compat. A stage that never
   * re-prompts continues to write a single atom id of
   * `<typePrefix>-<pipelineId>-<stageSlug>-<correlationId>`; a stage
   * with a re-prompt suffix appends `-attempt-<index>` for index >= 2.
   */
  readonly attemptIndex?: number;
  /**
   * 1-based re-entry counter for cross-stage walks. When a stage is
   * re-entered via a cross-stage re-prompt and produces a fresh
   * stage-output, the persisted atom would collide on the canonical
   * `<typePrefix>-<pipelineId>-<stageSlug>-<correlationId>` id with
   * the first entry's output. The suffix `-re-entry-<n>` (n >= 2)
   * discriminates the per-entry atoms; absent or 1 preserves the
   * historical id shape.
   */
  readonly stageEntryIndex?: number;
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
    // Stamp attempt_index when >= 2 so an audit walk can sort
    // multiple per-attempt atoms produced by the auditor-feedback
    // re-prompt loop without re-parsing the atom id suffix. Omitted
    // on attempt 1 (or absent) so existing single-attempt audit
    // consumers do not see a spurious field on pre-loop atoms; the
    // suffix on the atom id and the stamp on metadata are kept in
    // lock-step via safeAttemptIndexSuffix (both fire only on a
    // validated integer >= 2; malformed input collapses to omit).
    ...((): Record<string, unknown> => {
      const suffix = safeAttemptIndexSuffix(input.attemptIndex);
      return suffix !== undefined ? { attempt_index: suffix } : {};
    })(),
    // Stamp stage_entry_index when >= 2 so an audit walk can sort
    // multiple per-entry atoms produced by the cross-stage re-prompt
    // walk without re-parsing the atom id suffix. Omitted on entry 1
    // (or absent) so existing single-entry consumers do not see a
    // spurious field on pre-cross-stage atoms; mirrors the
    // attempt_index posture.
    ...((): Record<string, unknown> => {
      const suffix = safeAttemptIndexSuffix(input.stageEntryIndex);
      return suffix !== undefined ? { stage_entry_index: suffix } : {};
    })(),
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
 * Validate + normalise an attempt-index value from a user-supplied
 * MkStageOutputAtomBaseInput / MkPlanOutputAtomsInput /
 * MkPipelineAuditFindingAtomInput. The contract surface says
 * `attemptIndex` is a positive integer; this helper enforces it.
 *
 * - Returns the integer when it is a finite, integer, >= 2 value.
 *   The id-suffix branch fires; metadata.attempt_index is stamped.
 * - Returns `undefined` for any other input shape (NaN, Infinity,
 *   non-integer, < 2, missing). The id-suffix branch is skipped;
 *   metadata.attempt_index is omitted. This is the safe back-compat
 *   behavior: a malformed attempt index produces a first-attempt atom
 *   id rather than corrupting the id with NaN / `attempt-1.5` / etc.
 *
 * The runner caller always passes a clean integer because it tracks
 * the attempt counter in code; this helper exists for direct mint
 * callers (tests, future programmatic mints) where the value is
 * outside the runner's control. Mirrors the safeMaxAttempts coercion
 * in auditor-feedback-reprompt.ts: the substrate fails closed on
 * malformed input rather than propagating it into atom ids.
 */
export function safeAttemptIndexSuffix(attemptIndex: number | undefined): number | undefined {
  if (typeof attemptIndex !== 'number') return undefined;
  if (!Number.isFinite(attemptIndex) || !Number.isInteger(attemptIndex)) return undefined;
  if (attemptIndex < 2) return undefined;
  return attemptIndex;
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
 * Format: `<typePrefix>-<pipelineId>-<stageSlug>-<correlationId>` for
 * attempt 1 (or unspecified); `<typePrefix>-<pipelineId>-<stageSlug>-<correlationId>-attempt-<index>`
 * for attempts >= 2 under the auditor-feedback re-prompt loop.
 *
 * Including the stage slug ensures per-stage uniqueness when an
 * org-ceiling deployment registers two stages whose adapters declare
 * the SAME atom_type (e.g. two different review-stage variants both
 * emitting 'review-report'); without the stage slug the second stage's
 * id would collide with the first.
 *
 * The attempt-index suffix is the runner's mechanism for distinct
 * per-attempt atoms under the re-prompt loop. Within a single attempt,
 * two writes for the same {pipelineId, stageName, correlationId,
 * attemptIndex} still collide rather than create siblings (idempotent
 * put on resume). The suffix is omitted on attemptIndex=1 (or absent)
 * so existing deployments without re-prompts continue producing the
 * historical atom id shape; audit walks pre-dating the loop stay
 * readable.
 */
function stageOutputAtomId(
  typePrefix: string,
  input: MkStageOutputAtomBaseInput,
): AtomId {
  const stageSlug = slugifyStageName(input.stageName);
  const base = `${typePrefix}-${input.pipelineId}-${stageSlug}-${input.correlationId}`;
  // Only suffix when attemptIndex is a validated finite integer >= 2.
  // safeAttemptIndexSuffix returns undefined for any other shape so
  // a malformed input (NaN, Infinity, fractional, negative) collapses
  // to the historical first-attempt id rather than corrupting the id.
  // Substrate posture: opt-in suffix, default-back-compat,
  // fail-closed on malformed input.
  const attemptSfx = safeAttemptIndexSuffix(input.attemptIndex);
  const attemptPart = attemptSfx !== undefined
    ? `-attempt-${attemptSfx}`
    : '';
  // Cross-stage re-entry suffix mirrors the attempt suffix shape: the
  // canonical id appends `-re-entry-<n>` when the stage was re-entered
  // (stageEntryIndex >= 2). Stacks with -attempt-<n> when both fire
  // (a re-entered stage that internally re-prompts) so each
  // {entry, attempt} pair produces a distinct atom.
  const entrySfx = safeAttemptIndexSuffix(input.stageEntryIndex);
  const entryPart = entrySfx !== undefined
    ? `-re-entry-${entrySfx}`
    : '';
  return `${base}${attemptPart}${entryPart}` as AtomId;
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
  /**
   * 1-based index of the attempt that produced this plan-stage output.
   * Mirrors `MkStageOutputAtomBaseInput.attemptIndex`: omitted or 1 on
   * a first-attempt write preserves the historical id shape; >= 2
   * appends `-attempt-<index>` to each plan atom's id so the
   * re-prompt loop's per-attempt atoms do not collide. The stamp also
   * lands on `metadata.attempt_index` for audit-walk filtering.
   */
  readonly attemptIndex?: number;
  /**
   * 1-based re-entry counter for cross-stage walks. Mirrors
   * `MkStageOutputAtomBaseInput.stageEntryIndex`: when the plan-stage
   * is re-entered via a cross-stage walk and emits fresh plan atoms,
   * the suffix `-re-entry-<n>` (n >= 2) discriminates the per-entry
   * atoms. Absent or 1 preserves the historical id shape.
   */
  readonly stageEntryIndex?: number;
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
  readonly target_paths?: ReadonlyArray<unknown>;
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
  // target_paths is the plan-stage's authoritative deliverable-path
  // allowlist consumed by the drafter (extractStringArray reads
  // plan.metadata.target_paths first, falling back to body extraction
  // only when the structured field is absent). Reserving the key here
  // fences a misbehaving stage runner from injecting a synthetic
  // target_paths via extraMetadata that bypasses the plan-stage
  // schema's Form-A completeness check.
  'target_paths',
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
    // Append `-attempt-<index>` for attemptIndex >= 2 (validated via
    // safeAttemptIndexSuffix) so the auditor-feedback re-prompt
    // loop's per-attempt atoms do not collide with the prior
    // attempt's plan ids. Mirrors the stageOutputAtomId helper
    // suffix policy: attempt 1 (or absent / malformed) keeps the
    // historical shape, fail-closed on bad input.
    const validatedAttempt = safeAttemptIndexSuffix(input.attemptIndex);
    const attemptSuffix = validatedAttempt !== undefined
      ? `-attempt-${validatedAttempt}`
      : '';
    // Cross-stage re-entry suffix mirrors the attempt suffix shape.
    // Stacks with -attempt-<n> when both fire so each
    // {entry, attempt} pair produces a distinct plan atom.
    const validatedEntryIndex = safeAttemptIndexSuffix(input.stageEntryIndex);
    const entrySuffix = validatedEntryIndex !== undefined
      ? `-re-entry-${validatedEntryIndex}`
      : '';
    const id =
      `plan-${slug}-${input.principalId}-${input.pipelineId}-${i}${attemptSuffix}${entrySuffix}` as AtomId;

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

    // Propagate the plan-entry's target_paths into the atom's
    // metadata so the drafter's `extractStringArray(meta,
    // 'target_paths')` lookup finds it. Empty array =>
    // navigational-mode (Form B per substrate fix #288); the
    // drafter falls back to extractTargetPathsFromProse on plan
    // content. Non-empty array => concrete-mode (Form A); the
    // drafter's modify-fence scopes the diff to exactly this set.
    const targetPaths = asStringArray(entry.target_paths);
    const targetPathsMetadata = targetPaths.length > 0 ? { target_paths: [...targetPaths] } : {};

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
        ...targetPathsMetadata,
        // Stamp attempt_index when >= 2 so an audit walk can sort
        // multiple per-attempt plan atoms produced by the auditor-
        // feedback re-prompt loop. Kept in lock-step with the id
        // suffix via safeAttemptIndexSuffix: attempt 1 (or absent /
        // malformed) omits the field; validated integer >= 2 stamps
        // it. Mirrors buildStageOutputMetadata's same posture.
        ...(validatedAttempt !== undefined
          ? { attempt_index: validatedAttempt }
          : {}),
        // Stamp stage_entry_index when >= 2 so an audit walk can sort
        // multiple per-entry plan atoms produced by the cross-stage
        // re-prompt walk. Mirrors the attempt_index posture.
        ...(validatedEntryIndex !== undefined
          ? { stage_entry_index: validatedEntryIndex }
          : {}),
      },
    });
  }
  return atoms;
}
