/**
 * LAG core types.
 *
 * Every stored unit is an Atom. Arbitration, decay, taint, promotion all
 * operate over Atoms. Principals are themselves L3 Atoms with a specialized
 * shape; this file represents them separately for ergonomics.
 *
 * Branded string types (AtomId, PrincipalId, ...) prevent accidental mixing
 * at the type level. Construct via cast: `"abc123" as AtomId`.
 */

// ---------------------------------------------------------------------------
// Scalars and branded identifiers
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp with millisecond precision. */
export type Time = string;

export type AtomId = string & { readonly __brand: 'AtomId' };
export type PrincipalId = string & { readonly __brand: 'PrincipalId' };
export type ProposalId = string & { readonly __brand: 'ProposalId' };
export type CommitRef = string & { readonly __brand: 'CommitRef' };
export type AuditId = string & { readonly __brand: 'AuditId' };
export type NotificationHandle = string & { readonly __brand: 'NotificationHandle' };
export type RegistrationId = string & { readonly __brand: 'RegistrationId' };

/** Dense vector of floats. Length is adapter-determined. */
export type Vector = ReadonlyArray<number>;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type Layer = 'L0' | 'L1' | 'L2' | 'L3';

export type Scope = 'session' | 'project' | 'user' | 'global';

export type Disposition =
  | 'approve'
  | 'reject'
  | 'ignore'
  | 'timeout'
  | 'pending';

export type Severity = 'info' | 'warn' | 'critical';

export type TaintState = 'clean' | 'tainted' | 'quarantined';

export type AtomType =
  | 'directive'
  | 'observation'
  | 'decision'
  | 'preference'
  | 'reference'
  | 'ephemeral'
  | 'plan'
  | 'question'
  // Inter-actor messaging primitives. actor-message and
  // actor-message-ack model the send/ack pair; circuit-breaker-trip
  // and circuit-breaker-reset model a write-time back-pressure surface
  // any consumer wrapping AtomStore can produce.
  | 'actor-message'
  | 'actor-message-ack'
  | 'circuit-breaker-trip'
  | 'circuit-breaker-reset'
  // Multi-reviewer plan approval vote. Each atom is one reviewer's
  // signal on one plan; the approval pass counts distinct-principal
  // votes against a policy-defined threshold. derived_from points at
  // the plan being voted on; metadata.vote is 'approve' or 'reject';
  // metadata.role is an optional free-string used by role-quorum
  // policies. Votes inherit the atom store's standard guards (taint,
  // superseded_by); a reviewer rescinds by superseding their own vote.
  | 'plan-approval-vote';

/**
 * Execution lifecycle for atoms with `type: 'plan'`. Plans are composite
 * atoms that represent proposed action; their state machine is separate
 * from the L0-L3 layer axis (which governs trust). A plan's layer says
 * how vetted the proposal is; its plan_state says where it is in
 * execution.
 *
 * Allowed transitions:
 *   proposed   -> approved | abandoned
 *   approved   -> executing | abandoned
 *   executing  -> succeeded | failed | abandoned
 *   {succeeded, failed, abandoned} are terminal.
 */
export type PlanState =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'abandoned';

/**
 * Lifecycle for atoms with `type: 'question'`.
 *
 * Questions are HIL-addressed requests for input. The state machine
 * disambiguates Q-A binding under network delay: every answer is
 * linked to the specific pending question via `derived_from`, so
 * the audit trail reconstructs which response addressed which
 * question regardless of arrival order.
 *
 * Allowed transitions:
 *   pending   -> answered | expired | abandoned
 *   {answered, expired, abandoned} are terminal.
 */
export type QuestionState =
  | 'pending'
  | 'answered'
  | 'expired'
  | 'abandoned';

export type ValidationStatus =
  | 'verified'
  | 'unchecked'
  | 'stale'
  | 'invalid';

export type ProvenanceKind =
  | 'user-directive'
  | 'agent-observed'
  | 'agent-inferred'
  | 'llm-refined'
  | 'canon-promoted'
  // Atoms written by a bootstrap script at initial seeding time. Distinct
  // from `user-directive` (which implies a conversational claim from a
  // live session) because seed atoms are foundational and come from an
  // operator-authored script.
  | 'operator-seeded';

export type Action =
  | 'read'
  | 'write'
  | 'promote'
  | 'commit_canon'
  | 'mark_compromised';

// ---------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------

export interface ProvenanceSource {
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly tool?: string;
  readonly file_path?: string;
}

export interface Provenance {
  readonly kind: ProvenanceKind;
  readonly source: ProvenanceSource;
  /** Parent atoms this was synthesized from. Powers taint propagation. */
  readonly derived_from: ReadonlyArray<AtomId>;
}

export interface AtomSignals {
  readonly agrees_with: ReadonlyArray<AtomId>;
  readonly conflicts_with: ReadonlyArray<AtomId>;
  readonly validation_status: ValidationStatus;
  readonly last_validated_at: Time | null;
}

export interface Atom {
  readonly schema_version: number;
  readonly id: AtomId;
  readonly content: string;
  readonly type: AtomType;
  readonly layer: Layer;
  readonly provenance: Provenance;
  /** Confidence in [0, 1]; declining without reinforcement. */
  readonly confidence: number;
  readonly created_at: Time;
  readonly last_reinforced_at: Time;
  readonly expires_at: Time | null;
  readonly supersedes: ReadonlyArray<AtomId>;
  readonly superseded_by: ReadonlyArray<AtomId>;
  readonly scope: Scope;
  readonly signals: AtomSignals;
  readonly principal_id: PrincipalId;
  readonly taint: TaintState;
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Execution state for atoms with `type: 'plan'`. Undefined on non-plan
   * atoms. Mutable (transitions via AtomStore.update). See PlanState for
   * the transition rules.
   */
  readonly plan_state?: PlanState;
  /**
   * Lifecycle state for atoms with `type: 'question'`. Undefined on
   * non-question atoms. Mutable via AtomStore.update. See QuestionState.
   */
  readonly question_state?: QuestionState;
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export interface PermittedScopes {
  readonly read: ReadonlyArray<Scope>;
  readonly write: ReadonlyArray<Scope>;
}

export interface PermittedLayers {
  readonly read: ReadonlyArray<Layer>;
  readonly write: ReadonlyArray<Layer>;
}

export interface Principal {
  readonly id: PrincipalId;
  readonly name: string;
  readonly role: string;
  readonly permitted_scopes: PermittedScopes;
  readonly permitted_layers: PermittedLayers;
  readonly goals: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
  readonly active: boolean;
  /** If non-null, all writes at/after this time are tainted. */
  readonly compromised_at: Time | null;
  /** Hierarchy parent; null for root (user). */
  readonly signed_by: PrincipalId | null;
  readonly created_at: Time;
}

// ---------------------------------------------------------------------------
// Diff and Proposal
// ---------------------------------------------------------------------------

export interface Diff {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
}

export type ProposalStatus = 'pending' | Disposition;

export interface Proposal {
  readonly id: ProposalId;
  /**
   * Atom this proposal is about. Null when the proposal is an authored
   * canon edit that does not map 1:1 to a single atom (e.g. a hand-
   * crafted governance change, or a consolidation of many atoms). When
   * set, the proposal is a promotion/commit carrying a specific atom.
   */
  readonly atom_id: AtomId | null;
  readonly diff: Diff;
  readonly principal_id: PrincipalId;
  readonly rationale: string;
  readonly created_at: Time;
  readonly timeout_at: Time;
  readonly default_disposition: Disposition;
  readonly status: ProposalStatus;
  readonly approver_id: PrincipalId | null;
}

export interface Commit {
  readonly ref: CommitRef;
  readonly diff: Diff;
  readonly principal_id: PrincipalId;
  readonly approver_id: PrincipalId;
  readonly committed_at: Time;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Queries and patches
// ---------------------------------------------------------------------------

export interface AtomFilter {
  readonly ids?: ReadonlyArray<AtomId>;
  readonly layer?: ReadonlyArray<Layer>;
  readonly type?: ReadonlyArray<AtomType>;
  readonly scope?: ReadonlyArray<Scope>;
  readonly principal_id?: ReadonlyArray<PrincipalId>;
  readonly taint?: ReadonlyArray<TaintState>;
  readonly created_before?: Time;
  readonly created_after?: Time;
  readonly min_confidence?: number;
  readonly max_confidence?: number;
  /** If true, superseded atoms are included. Default false. */
  readonly superseded?: boolean;
  /** Filter by plan_state. Only meaningful for type='plan' atoms. */
  readonly plan_state?: ReadonlyArray<PlanState>;
  /** Filter by question_state. Only meaningful for type='question' atoms. */
  readonly question_state?: ReadonlyArray<QuestionState>;
}

export interface AtomPatch {
  readonly confidence?: number;
  readonly last_reinforced_at?: Time;
  readonly expires_at?: Time | null;
  /** Appended to existing array. */
  readonly supersedes?: ReadonlyArray<AtomId>;
  /** Appended to existing array. */
  readonly superseded_by?: ReadonlyArray<AtomId>;
  readonly signals?: Partial<AtomSignals>;
  readonly taint?: TaintState;
  /** Merged into existing metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Transition for plan atoms. Validated by transitionPlanState(). */
  readonly plan_state?: PlanState;
  /** Transition for question atoms. Validated by transitionQuestionState(). */
  readonly question_state?: QuestionState;
}

export interface Target {
  readonly scope?: Scope;
  readonly layer?: Layer;
  readonly atom_id?: AtomId;
  readonly path?: string;
}

// ---------------------------------------------------------------------------
// Events and audit
// ---------------------------------------------------------------------------

export type EventKind =
  | 'proposal'
  | 'canon_edit'
  | 'principal_change'
  | 'anomaly'
  | 'taint_alert';

export interface Event {
  readonly kind: EventKind;
  readonly severity: Severity;
  readonly summary: string;
  readonly body: string;
  readonly atom_refs: ReadonlyArray<AtomId>;
  readonly principal_id: PrincipalId;
  readonly created_at: Time;
}

export interface AuditRefs {
  readonly atom_ids?: ReadonlyArray<AtomId>;
  readonly proposal_ids?: ReadonlyArray<ProposalId>;
  readonly commit_refs?: ReadonlyArray<CommitRef>;
}

export interface AuditEvent {
  readonly kind: string;
  readonly principal_id: PrincipalId;
  readonly timestamp: Time;
  readonly refs: AuditRefs;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditFilter {
  readonly kind?: ReadonlyArray<string>;
  readonly principal_id?: ReadonlyArray<PrincipalId>;
  readonly after?: Time;
  readonly before?: Time;
  readonly atom_ids?: ReadonlyArray<AtomId>;
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

export interface LlmOptions {
  readonly model: string;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly timeout_ms?: number;
  readonly seed?: number;
  readonly max_budget_usd: number;
  /** Default true. If false, caller accepts the risk of non-sandboxed execution. */
  readonly sandboxed?: boolean;
  /**
   * Runtime-revocation signal. Implementations that spawn a child
   * process or stream from a remote should subscribe; on abort the
   * call rejects (with AbortError, or an implementation-specific
   * equivalent) and any in-flight work unwinds. Implementations that
   * cannot honour mid-call abort MAY ignore this field. Callers
   * should treat a thrown AbortError as "kill-switch tripped" rather
   * than "judge failed".
   */
  readonly signal?: AbortSignal;
  /**
   * Names of tools the LLM subprocess must NOT be allowed to call
   * during this invocation. Implementations that launch a subagent
   * capable of tool use (e.g. Claude CLI) forward this list; text-
   * in-text-out implementations MAY ignore it.
   *
   * When undefined, the implementation's own safety default applies.
   * Per-invocation override exists so a caller holding a principal-
   * scoped policy can tailor access without reconstructing the
   * implementation. Deny-list shape matches the Claude CLI contract;
   * adapters with an allow-list-first surface invert at the boundary.
   */
  readonly disallowedTools?: ReadonlyArray<string>;
}

export interface JudgeMetadata {
  readonly model_used: string;
  /** -1 if the adapter cannot report tokens. */
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** -1 if unreported. */
  readonly cost_usd: number;
  readonly latency_ms: number;
  /** sha256 of the system prompt used. */
  readonly prompt_fingerprint: string;
  /** sha256 of the output schema. */
  readonly schema_fingerprint: string;
}

export interface JudgeResult<T = unknown> {
  readonly output: T;
  readonly metadata: JudgeMetadata;
}

/** Opaque JSON schema payload. Enforced by adapter via zod or ajv. */
export type JsonSchema = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Query pagination result
// ---------------------------------------------------------------------------

export interface AtomPage {
  readonly atoms: ReadonlyArray<Atom>;
  readonly nextCursor: string | null;
}

export interface SearchHit {
  readonly atom: Atom;
  /** Normalized to [0, 1] where 1 is the best match. */
  readonly score: number;
}
