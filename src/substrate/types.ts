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
  //
  // GC posture: both types are reaped via the pipeline-reaper at TTL
  // (see the convention block on `AtomPatch.metadata`). When a parent
  // pipeline atom is reaped, its derived agent-session and agent-turn
  // children cascade-reap immediately (ttl-derived from the parent),
  // since their lifetime is bounded by the pipeline run. Standalone
  // agent-session atoms not derived from a pipeline reap on the
  // independent `agentSessionMs` TTL.
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
  //
  // GC posture: every type in this block is reaped via the pipeline
  // reaper at TTL (see the convention block on `AtomPatch.metadata`).
  // The 'pipeline' atom is the subgraph root; its children
  // ('pipeline-stage-event', 'pipeline-audit-finding',
  // 'pipeline-failed', 'pipeline-resume', 'brainstorm-output',
  // 'spec-output', 'review-report', 'dispatch-record') cascade-reap
  // when the root reaps. The 'spec' type is reaped on the same TTL
  // as the pipeline whose plan-stage produced it. None of these
  // types are deleted; reaping is a leaf metadata write
  // (`reaped_at` + `reaped_reason`) plus a confidence floor.
  | 'spec'
  | 'brainstorm-output'
  | 'spec-output'
  | 'review-report'
  | 'dispatch-record'
  | 'pipeline'
  | 'pipeline-stage-event'
  | 'pipeline-audit-finding'
  | 'pipeline-failed'
  | 'pipeline-resume'
  // PR-orphan reconciler substrate.
  // `pr-driver-claim`: one principal claiming responsibility for
  // driving a specific PR to merged (or operator-explicit closed)
  // state. metadata.pr.{owner,repo,number} identifies the PR;
  // metadata.principal_id is the claimant; metadata.status is
  // 'claimed' | 'released'; metadata.expires_at provides an upper
  // bound on the claim's lifetime so a sub-agent that terminates
  // without an explicit release does not pin the PR forever. Released
  // by writing a successor claim atom with status='released' and
  // supersedes=[priorClaimId]. Pure-data atom; the orphan reconciler
  // tick reads claims to decide whether a PR has an active driver.
  // `pr-orphan-detected`: written by the orphan reconciler when a PR
  // has no active driver-claim AND the latest activity threshold has
  // expired. metadata.pr.{owner,repo,number} identifies the PR;
  // metadata.cadence_bucket is a deterministic-id seed so a single
  // detection per PR per cadence window is enforced via
  // host.atoms.put's duplicate-id guard. Functions as both the
  // mutual-exclusion lock against repeated dispatch and the
  // historical record of the orphan event.
  | 'pr-driver-claim'
  | 'pr-orphan-detected'
  // Zero-failure sub-agent substrate.
  // `work-claim`: one atom per dispatched sub-agent run, carrying the
  // unforgeable contract between dispatcher and sub-agent. The claim's
  // brief (prompt + expected_terminal + deadline_ts) plus its lifecycle
  // state machine (pending -> executing -> attesting -> complete or
  // pending -> stalled -> abandoned) is the substrate authority that
  // gates `markClaimComplete`. `metadata.work_claim.claim_secret_token`
  // is a high-entropy bearer secret authenticating the sub-agent at
  // attestation time; redaction is mandatory in every persisted log or
  // atom-derived string (enforced by the redactor pass).
  // `claim-attestation-accepted`: written by the verifier when ground
  // truth confirms the sub-agent's reported terminal state. Pure-data
  // atom; functions as the historical record of a successful claim
  // closure.
  // `claim-attestation-rejected`: written when attestation fails for
  // any reason (token mismatch, principal mismatch, ground-truth
  // mismatch, verifier error/timeout, STOP sentinel, etc.). Carries a
  // closed-set rejection reason for audit. Does not by itself terminate
  // the claim; the reaper recovers from repeated rejections via the
  // bounded recovery ladder.
  // `claim-stalled`: written by the reaper when a claim crosses a
  // deadline or grace-period boundary. Carries the recovery counters at
  // the moment of stall so a postmortem can reconstruct the recovery
  // path without replaying the reaper.
  // `claim-escalated`: written by the reaper when the recovery cap is
  // reached and the claim's failure surfaces to the operator. Carries
  // the cumulative failure reasons and the chain of session-atom ids
  // that participated in the failed recovery attempts.
  | 'work-claim'
  | 'claim-attestation-accepted'
  | 'claim-attestation-rejected'
  | 'claim-stalled'
  | 'claim-escalated';

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
  /**
   * Merged into existing metadata.
   *
   * Reserved metadata convention for the pipeline reaper (see
   * `src/runtime/plans/reaper.ts` and the future `pipeline-reaper.ts`):
   *
   *   - `reaped_at` (ISO-8601 UTC timestamp string): when the atom was
   *     marked reaped. MUST be obtained from `host.clock.now()`, never
   *     constructed via `new Date().toISOString()` directly. Routing
   *     timestamps through the host clock keeps the substrate
   *     deterministic under test pinning and consistent across adapters.
   *   - `reaped_reason` (finite string discriminator): why the atom was
   *     reaped. Examples: `'terminal-pipeline-ttl'`, `'stage-event-ttl'`,
   *     `'orphaned-stage-event'`. The vocabulary is finite (enumerated
   *     by the reaper module that owns each kind) so projections and
   *     audit consumers can branch deterministically; free-form strings
   *     defeat that.
   *
   * Atoms are never deleted from the AtomStore (no deletion verb on the
   * substrate; provenance chains and `derived_from` traversal must keep
   * resolving). Reaping is a leaf metadata write plus a confidence
   * floor; consumers (Console projections, arbitration) check
   * `metadata.reaped_at` to decide whether to surface or deprioritize.
   */
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
  | 'taint_alert'
  // Substrate-emitted alert when a principal attempts an action it
  // is not authorized to perform on a work-claim it does not own
  // (post-terminal attest, stolen-token attempt detected upstream of
  // the rejection atom). Distinct from `anomaly` because it carries
  // a specific cause-and-actor pair the Notifier surface can route
  // to a principal-misbehavior channel without parsing free text.
  | 'principal-misbehavior'
  // Substrate-emitted alert when the claim reaper escalates a work-claim
  // that has exhausted its recovery-attempts cap and been abandoned. The
  // payload carries `{ claim_id, recovery_attempts }` so the Notifier
  // surface can route to an operator-escalation channel without parsing
  // free text. Distinct from `principal-misbehavior` because the agent
  // did NOT misbehave; the work-shape was just unreachable in the
  // budget the substrate is willing to spend on it.
  | 'claim-stuck';

export interface Event {
  readonly kind: EventKind;
  readonly severity: Severity;
  readonly summary: string;
  readonly body: string;
  readonly atom_refs: ReadonlyArray<AtomId>;
  readonly principal_id: PrincipalId;
  readonly created_at: Time;
  /**
   * Structured payload for event kinds that carry concrete actor +
   * artifact references (e.g. `principal-misbehavior` carries
   * `{ claim_id, caller_principal_id }`). The payload is shape-open
   * because different event kinds need different fields; consumers
   * narrow on `kind` first then read the fields they expect. Optional
   * because legacy kinds (`proposal`, `canon_edit`, `principal_change`,
   * `anomaly`, `taint_alert`) carry their information in `body` and
   * `atom_refs` already.
   */
  readonly payload?: Readonly<Record<string, unknown>>;
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

// ---------------------------------------------------------------------------
// Zero-failure sub-agent substrate
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for an atom of `type: 'work-claim'`. The transition
 * graph is:
 *
 *   pending   -> executing | stalled | abandoned
 *   executing -> attesting | stalled | abandoned
 *   attesting -> complete  | executing | stalled
 *   stalled   -> executing | abandoned
 *   {complete, abandoned} are terminal.
 *
 * Mistyping a state name in implementation code surfaces as a TS error
 * rather than a silent runtime drift; the closed union is the gate.
 */
export type ClaimState =
  | 'pending'
  | 'executing'
  | 'attesting'
  | 'complete'
  | 'stalled'
  | 'abandoned';

/**
 * The contract handed to a dispatched sub-agent. `prompt` is the inline
 * task description; `prompt_blob_ref` is the optional content-addressed
 * pointer when the prompt is large (mirrors the inline/ref discriminator
 * pattern used by `AgentTurnMeta.llm_input`).
 *
 * `expected_terminal.kind` is open-extensible (a deployment may register
 * a verifier for any string label); the four canonical kinds shipped at
 * substrate level are 'pr', 'plan', 'task', and 'research-atom'.
 * `terminal_states` is the closed set of acceptable end-states for that
 * kind (e.g. `['MERGED']` for a PR claim required to land, or
 * `['succeeded']` for a plan claim).
 *
 * `deadline_ts` is the substrate's reaper boundary; a claim that has not
 * reached a terminal state by `deadline_ts` enters the stalled queue and
 * the bounded recovery ladder takes over.
 */
export interface WorkClaimBrief {
  readonly prompt: string;
  readonly prompt_blob_ref?: BlobRef;
  readonly expected_terminal: {
    readonly kind: 'pr' | 'plan' | 'task' | 'research-atom' | string;
    readonly identifier: string;
    readonly terminal_states: ReadonlyArray<string>;
  };
  readonly deadline_ts: Time;
}

/**
 * Stored on atoms with `type: 'work-claim'` under `metadata.work_claim`.
 *
 * `claim_secret_token` is a high-entropy bearer secret (43-char base64url
 * from `crypto.randomBytes(32)` in the substrate). It authenticates the
 * dispatched sub-agent at `markClaimComplete` time and is the single
 * gate distinguishing a legitimate attestation from a spoofed write.
 *
 * MUST be redacted from every persisted log, every atom-derived
 * projection (canon-md render, session-tree projection, console payload,
 * dashboard export), and every external surface (operator notification
 * body, error message, audit detail). The substrate redactor ships a
 * regex that matches the token shape and replaces it with a placeholder;
 * consumers that bypass the redactor (custom projections, ad-hoc
 * scripts) MUST implement equivalent redaction or refuse to render claim
 * atoms. A leaked token authorizes any holder to close the claim and is
 * treated as a security incident.
 *
 * `budget_tier` is a string label (`'default' | 'raised' | 'max' | ...`)
 * resolved at dispatch time against the claim-budget-tier policy atoms;
 * the string is open-extensible so an org-ceiling deployment can
 * register additional tiers via canon edit without a substrate release.
 * Runtime validation of the resolved tier (max_turns, max_wall_clock_ms,
 * max_usd) happens in the claim contract dispatcher, not at type-check
 * time.
 */
export interface WorkClaimMeta {
  readonly claim_id: string;
  /**
   * High-entropy bearer secret. See the surrounding `WorkClaimMeta`
   * JSDoc for the redaction contract. NEVER log, render, project, or
   * surface this field outside the substrate's authorized
   * `markClaimComplete` code path. A leak is a security incident.
   */
  readonly claim_secret_token: string;
  readonly dispatched_principal_id: PrincipalId;
  readonly brief: WorkClaimBrief;
  readonly claim_state: ClaimState;
  readonly budget_tier: string;
  readonly recovery_attempts: number;
  readonly verifier_failure_count: number;
  /** Set when the claim was spawned as a recovery successor of another claim. */
  readonly parent_claim_id: string | null;
  /** Agent-session atom ids associated with this claim's execution attempts. */
  readonly session_atom_ids: ReadonlyArray<AtomId>;
  readonly last_attestation_rejected_at: Time | null;
  readonly latest_session_finalized_at: Time | null;
}

/**
 * Closed-set reason codes for `claim-attestation-rejected` atoms.
 *
 * Eight failure axes plus two verifier-infrastructure modes:
 *   - stop-sentinel: the kill-switch sentinel was active at attestation time.
 *   - claim-not-found: no work-claim atom matched the claim id.
 *   - claim-already-terminal: the claim was already in a terminal state.
 *   - token-mismatch: the bearer token did not equal the claim's secret.
 *   - principal-mismatch: the attesting principal was not the dispatched one.
 *   - identifier-mismatch: the attested identifier did not equal the brief.
 *   - kind-mismatch: the attested terminal kind did not match the brief.
 *   - ground-truth-mismatch: the verifier returned a different observed state.
 *   - verifier-error: the verifier handler threw or returned a structural error.
 *   - verifier-timeout: the verifier did not respond within the configured cap.
 */
export type AttestationRejectionReason =
  | 'stop-sentinel'
  | 'claim-not-found'
  | 'claim-already-terminal'
  | 'token-mismatch'
  | 'principal-mismatch'
  | 'identifier-mismatch'
  | 'kind-mismatch'
  | 'ground-truth-mismatch'
  | 'verifier-error'
  | 'verifier-timeout';

/**
 * Stored on atoms with `type: 'claim-attestation-accepted'` under
 * `metadata.claim_attestation`. Written when the verifier confirms the
 * sub-agent's reported terminal state against ground truth. Functions
 * as the audit record of a successful claim closure; the claim-contract
 * code transitions the linked work-claim to `claim_state: 'complete'`
 * in the same write batch.
 */
export interface ClaimAttestationAcceptedMeta {
  readonly claim_id: string;
  readonly observed_state: string;
  readonly verified_at: Time;
}

/**
 * Stored on atoms with `type: 'claim-attestation-rejected'` under
 * `metadata.claim_attestation`. Written when attestation fails for any
 * reason in `AttestationRejectionReason`. Does NOT by itself terminate
 * the claim; the reaper consumes rejection records and routes the claim
 * through the bounded recovery ladder.
 *
 * `observed_state` is set when the verifier produced a concrete state
 * that simply did not match the brief; `error` is set when the failure
 * is structural (verifier crashed, token check failed before any
 * verifier ran). At most one is meaningful per rejection.
 */
export interface ClaimAttestationRejectedMeta {
  readonly claim_id: string;
  readonly reason: AttestationRejectionReason;
  readonly observed_state?: string;
  readonly error?: string;
}

/**
 * Stored on atoms with `type: 'claim-stalled'` under
 * `metadata.claim_stall`. Written by the reaper when a claim crosses a
 * deadline or grace-period boundary. Snapshots the recovery counters at
 * the moment of stall so a postmortem can reconstruct the recovery path
 * without replaying the reaper from logs.
 */
export interface ClaimStalledMeta {
  readonly claim_id: string;
  readonly reason: string;
  readonly recovery_attempts_at_stall: number;
  readonly verifier_failure_count_at_stall: number;
}

/**
 * Stored on atoms with `type: 'claim-escalated'` under
 * `metadata.claim_escalation`. Written by the reaper when the recovery
 * cap is reached and the failure surfaces to the operator. Carries the
 * cumulative failure reasons and the chain of session-atom ids that
 * participated in the failed recovery attempts so the operator can
 * inspect the full trail in one place.
 */
export interface ClaimEscalatedMeta {
  readonly claim_id: string;
  readonly failure_reasons: ReadonlyArray<string>;
  readonly session_atom_ids: ReadonlyArray<AtomId>;
}
