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

/**
 * Content-addressed reference for the agentic-actor-loop `BlobStore`.
 * Format: `sha256:<64-hex>`. Constructed via `blobRefFromHash` and
 * parsed via `parseBlobRef` (both in `blob-store.ts`). Branded so
 * callers cannot accidentally pass arbitrary strings where a `BlobRef`
 * is required; the brand exists at type-check time only and has no
 * runtime representation.
 */
export type BlobRef = string & { readonly __brand: 'BlobRef' };

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
  | 'plan-approval-vote'
  // Claim + audit record for the pr-merge-reconcile pass. Written
  // with a deterministic id (sha256 of plan_id|pr_observation_id)
  // and derived_from: [plan_id, pr_observation_id], so a second
  // worker observing the same pr-observation gets a duplicate-id
  // conflict and skips. Functions as both the mutual-exclusion lock
  // and the historical record of the reconciliation event.
  | 'plan-merge-settled'
  // Per-plan idempotence record for the plan-proposal notify pass.
  // Written exactly once per plan when the LoopRunner notify pass
  // successfully delegates to a deployment-side notifier. Carries
  // provenance.derived_from: [planId] so the audit chain links the
  // push back to its plan, and metadata.plan_id mirrors that
  // pointer for projection-scoped queries. The notify pass refuses
  // to re-notify any plan whose id already appears in this set,
  // which keeps a long-running daemon from spamming the same plan
  // across thousands of ticks. The transport name (telegram, slack,
  // email, ...) lives in metadata.channel so a single atom type
  // covers every notifier; renaming or adding a channel does not
  // require a substrate migration.
  | 'plan-push-record'
  // Operator-authored trust envelope authorizing autonomous plan
  // dispatch. metadata.trust_envelope gates plan auto-approval and
  // sub-actor selection; metadata.expires_at is the real lifetime
  // gate (distinct from confidence decay). Lifetime caps and author
  // allowlists live in policy atoms, not this type. Distinct from
  // `directive` (L3 canon, persistent governance) and `observation`
  // (passive record): this is an L1 authorizing act that expires.
  | 'operator-intent'
  // Agentic actor loop substrate.
  // `agent-session`: one per agent run; principal-bound; carries the
  // session-level metadata (model, adapter, workspace, terminal
  // state, replay tier, budget, optional failure record). Lifecycle
  // is single-shot: written once when the session terminates.
  // `agent-turn`: one per LLM call within a session; carries the
  // turn-scoped metadata (input/output blob refs or inline payloads,
  // tool-call ledger, latency, optional failure record). Each turn
  // atom's `provenance.derived_from` points at the parent
  // `agent-session` atom for taint propagation, AND
  // `metadata.agent_turn.session_atom_id` carries the same pointer
  // for projection-scoped queries (the two pointers are required
  // to agree; a future validator may enforce this).
  | 'agent-session'
  | 'agent-turn'
  // Deep planning pipeline atom types. The 'spec' type is a
  // looser-shaped sibling of 'plan' (prose-shaped, intended as a
  // design-document atom that precedes a plan); the 'pipeline-*'
  // prefix groups runtime state and audit projection atoms together
  // so a Console filter can surface a single pipeline run as a
  // coherent timeline.
  //
  // Stage-output atom types persist each pipeline stage's
  // StageOutput.value as a queryable atom with a derived_from chain
  // tracing back to the seed operator-intent. Without these, a
  // pipeline run's stage outputs survive only as in-memory
  // priorOutput between adjacent stages and are unreachable from
  // host.atoms.query (the dispatch-stage's planFilter, the
  // operator's plan-detail console view, and any audit consumer all
  // need a typed atom to walk). The plan-stage's output uses the
  // existing 'plan' type (kept consistent with the single-pass
  // planning-actor output so console plan-detail and downstream
  // consumers do not need branching logic); the other four stages
  // get dedicated types so their schemas can diverge without
  // polluting the plan vocabulary.
  | 'spec'
  | 'brainstorm-output'
  | 'spec-output'
  | 'review-report'
  | 'dispatch-record'
  | 'pipeline'
  | 'pipeline-stage-event'
  | 'pipeline-audit-finding'
  | 'pipeline-failed'
  | 'pipeline-resume';

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
  /**
   * Execution state for atoms with `type: 'pipeline'`. Undefined on
   * non-pipeline atoms. Mutable (transitions via AtomStore.update).
   * Mirrors the plan_state field shape so consumers read it as a
   * top-level field, never via metadata.
   */
  readonly pipeline_state?: string;
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
  /**
   * Transition for pipeline atoms. The valid label set lives with the
   * pipeline runner; AtomPatch is mechanism-only and does not enumerate
   * the labels. Mirrors the plan_state field shape.
   */
  readonly pipeline_state?: string;
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
  /**
   * Framing hint for adapters that prepend a task-class preamble to the
   * caller's system prompt. `classifier` is right for short schema-bound
   * classifications (planning judgments). `code-author` is right for
   * long schema-bound code-generation calls where the model produces a
   * diff. Adapters that do not implement framing MAY ignore this field.
   *
   * The distinction matters because some Claude models with extended
   * thinking enabled will burn the entire output budget on deliberation
   * when given a frame that contradicts the actual task (e.g., a
   * "you are a classifier" frame on a code-drafting call) and emit zero
   * structured output.
   */
  readonly framingMode?: 'classifier' | 'code-author';
  /**
   * Vendor-neutral coarse effort scale forwarded to adapters that
   * surface a reasoning-depth knob. Adapters MAP this to their own
   * provider-specific scale; adapters that lack the knob MAY ignore
   * this field. Vendor-specific extensions (e.g. Anthropic's `xhigh`
   * or `max` levels above `high`) live in adapter-level option types,
   * never here. When omitted the adapter-level default applies, which
   * itself MAY be omitted to defer to the underlying CLI/model default.
   */
  readonly effort?: 'low' | 'medium' | 'high';
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

// ---------------------------------------------------------------------------
// Agentic actor loop substrate
// ---------------------------------------------------------------------------

/**
 * Replay determinism tier the session was executed under. `best-effort`
 * captures the LLM transcript only and makes no replay promise.
 * `content-addressed` additionally pins all tool inputs/outputs to
 * `BlobRef`s so a future replay can re-feed the model deterministically
 * (modulo provider sampling noise) without re-running tools. `strict`
 * further requires the adapter to pin a `canon_snapshot_blob_ref` so
 * canon at session-start is reproducible, at the cost of an extra
 * 10-100 KB blob per session.
 */
export type ReplayTier = 'best-effort' | 'content-addressed' | 'strict';

/**
 * Coarse failure taxonomy used by sessions and turns. Distinguished so
 * the surrounding plan-state machine (and any retry policy) can branch
 * on whether the failure is worth retrying (`transient`: rate limit,
 * network blip, EBUSY), a contract violation that should be surfaced
 * to the operator (`structural`: out-of-budget, agent stuck,
 * policy-refused tool), or a host-level fault that should trip a
 * circuit breaker (`catastrophic`: workspace-acquire failure, redactor
 * crashed, atom-store write failed). The default classifier in
 * `agent-loop.ts` covers common error shapes; adapters may override
 * for adapter-specific failure modes.
 */
export type FailureKind = 'transient' | 'structural' | 'catastrophic';

/**
 * Structured failure record stored on session/turn metadata when the
 * agentic loop did not complete cleanly. `reason` is a short
 * operator-readable explanation; `stage` is the loop checkpoint where
 * the failure surfaced (e.g. `'workspace-acquire'`, `'agent-init'`,
 * `'turn-3'`, `'commit'`) so postmortems can map the failure to a
 * specific seam without parsing free text. Modeled as an interface so
 * future fields (cause chain, retry count) can be added without a
 * breaking type change.
 */
export interface FailureRecord {
  readonly kind: FailureKind;
  readonly reason: string;
  /** e.g. 'workspace-acquire', 'agent-init', 'turn-3', 'commit'. */
  readonly stage: string;
}

/**
 * Stored on atoms with `type: 'agent-session'` under
 * `metadata.agent_session`. One per agent run, principal-bound, written
 * once when the session terminates. Modeled as an interface (not a
 * type alias) so adapters can extend via declaration-merging if a
 * future need arises; today, the structured `extra` slot is the
 * sanctioned extension point.
 */
export interface AgentSessionMeta {
  readonly model_id: string;
  readonly adapter_id: string;
  readonly workspace_id: string;
  readonly started_at: Time;
  readonly completed_at?: Time;
  readonly terminal_state: 'completed' | 'budget-exhausted' | 'error' | 'aborted';
  readonly replay_tier: ReplayTier;
  /**
   * Pinned content-hash of the canon snapshot at session-start. Required
   * by the `strict` replay tier; omitted for `best-effort` and
   * `content-addressed`.
   */
  readonly canon_snapshot_blob_ref?: BlobRef;
  readonly budget_consumed: {
    readonly turns: number;
    readonly wall_clock_ms: number;
    readonly usd?: number;
  };
  readonly failure?: FailureRecord;
  /**
   * Open extension slot for adapter-specific metadata. Kept as
   * `Readonly<Record<string, unknown>>` rather than a typed surface so
   * substrate consumers do not need to fork the type to record
   * implementation-specific signals (e.g. CLI exit codes, MCP tool
   * counts). Adapters MUST namespace keys to avoid collision.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Stored on atoms with `type: 'agent-turn'` under `metadata.agent_turn`.
 * One atom per LLM call within a session; the parent session is
 * referenced by BOTH `provenance.derived_from` (the substrate-wide
 * chain pointer used by taint propagation and the standard atom-graph
 * traversal) AND `session_atom_id` below (the projection-specific
 * pointer used by `buildSessionTree` for ordering and cheap
 * session-scoped queries without parsing provenance arrays). Both
 * pointers MUST agree; collapsing to one is a substrate violation a
 * future validator may enforce.
 */
export interface AgentTurnMeta {
  readonly session_atom_id: AtomId;
  /** 0-based turn index within the session. */
  readonly turn_index: number;
  /**
   * Either an inline payload (small turns; convenient for tests and
   * solo-dev replay) or a `BlobRef` into the content-addressed store
   * (large turns; required for the `content-addressed` and `strict`
   * replay tiers). The discriminated-union shape keeps the storage
   * decision a property of each turn rather than a global setting.
   */
  readonly llm_input: { readonly ref: BlobRef } | { readonly inline: string };
  readonly llm_output: { readonly ref: BlobRef } | { readonly inline: string };
  readonly tool_calls: ReadonlyArray<{
    readonly tool: string;
    readonly args: { readonly ref: BlobRef } | { readonly inline: string };
    readonly result: { readonly ref: BlobRef } | { readonly inline: string };
    readonly latency_ms: number;
    readonly outcome: 'success' | 'tool-error' | 'policy-refused';
  }>;
  readonly latency_ms: number;
  readonly failure?: FailureRecord;
  /**
   * Open extension slot, namespaced by adapter. Same rationale as
   * `AgentSessionMeta.extra`.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

