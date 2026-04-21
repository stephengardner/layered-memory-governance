/**
 * Host interface. The boundary between LAG framework logic and any concrete
 * implementation (stores, LLM providers, notification channels, schedulers,
 * filesystem, git, MCP). LAG never reaches around this interface.
 *
 * See `design/host-interface.md` for the full specification, sandboxing
 * requirements, concurrency model, and conformance contract.
 */

import type {
  Action,
  Atom,
  AtomFilter,
  AtomId,
  AtomPage,
  AtomPatch,
  AuditEvent,
  AuditFilter,
  AuditId,
  Commit,
  CommitRef,
  Diff,
  Disposition,
  Event,
  JsonSchema,
  JudgeResult,
  LlmOptions,
  NotificationHandle,
  Principal,
  PrincipalId,
  ProposalId,
  RegistrationId,
  SearchHit,
  Target,
  Time,
  Vector,
} from './types.js';

// ---------------------------------------------------------------------------
// AtomStore
// ---------------------------------------------------------------------------

export interface AtomStore {
  /**
   * Persist a new atom. Atom.id is expected to be set by caller (content-derived hash).
   * Throws ConflictError if an atom with the same id already exists.
   */
  put(atom: Atom): Promise<AtomId>;

  /** Retrieve a single atom by id. Returns null if not present. */
  get(id: AtomId): Promise<Atom | null>;

  /** Metadata-filtered retrieval. Paginated via opaque cursor. */
  query(
    filter: AtomFilter,
    limit: number,
    cursor?: string,
  ): Promise<AtomPage>;

  /**
   * Semantic search, optionally filtered. Returns up to k hits.
   * Score is normalized to [0, 1] where 1 is best.
   */
  search(
    query: string | Vector,
    k: number,
    filter?: AtomFilter,
  ): Promise<ReadonlyArray<SearchHit>>;

  /** Apply a patch to an atom's mutable fields. Content is immutable. */
  update(id: AtomId, patch: AtomPatch): Promise<Atom>;

  /** Bulk update matching the filter. Returns count affected. */
  batchUpdate(filter: AtomFilter, patch: AtomPatch): Promise<number>;

  /** Compute an embedding. Deterministic within an adapter version. */
  embed(text: string): Promise<Vector>;

  /** Cosine similarity of two vectors. Pure, synchronous. */
  similarity(a: Vector, b: Vector): number;

  /** Normalized content hash for deterministic dedup. Pure, synchronous. */
  contentHash(text: string): string;

  /**
   * Optional capability discovery. Consumers that want to wire a
   * NOTIFY-style wake (Postgres LISTEN/NOTIFY, Redis pubsub, etc.)
   * check `capabilities?.hasSubscribe` before calling `subscribe`.
   * Polling remains correct even when subscribe is available; the
   * wake is a latency optimization, not a correctness primitive.
   *
   * Capability-query shape (not a required method) so adapter
   * implementations that never opt in carry zero extra code.
   */
  readonly capabilities?: AtomStoreCapabilities;

  /**
   * Optional push wake. When `capabilities.hasSubscribe` is true,
   * consumers can subscribe to changes matching a filter. The returned
   * async iterable yields AtomSubscribeEvent values (atom id + event
   * kind) when a matching write lands. Consumers that need the full
   * atom re-query the store via `get()`; we keep the event shape
   * minimal so adapters do not have to serialize the full atom
   * payload into the event stream.
   *
   * Termination via AbortSignal so callers can unwind cleanly; the
   * iterator MUST return `{done: true}` when the signal aborts.
   *
   * Adapters that do not support push-wake must not implement this
   * method; the presence of the method on the prototype is the
   * declared contract. `capabilities.hasSubscribe` is the feature
   * flag a consumer queries to decide whether to call.
   */
  subscribe?(filter: AtomFilter, signal?: AbortSignal): AsyncIterable<AtomSubscribeEvent>;
}

/**
 * Feature declaration for an AtomStore. Consumers query this before
 * invoking optional methods like subscribe; missing field is
 * equivalent to `false`.
 */
export interface AtomStoreCapabilities {
  /**
   * True when the adapter supports push-wake via `subscribe()`. A
   * consumer that sees false (or `undefined`) falls back to polling.
   * A consumer that sees true may STILL poll as a correctness
   * backstop (NOTIFY can drop silently).
   */
  readonly hasSubscribe: boolean;
}

/**
 * One subscribe() event. Shape is deliberately minimal: the atom id
 * + a kind indicator. Consumers re-query the store for the full atom
 * when they need it, so adapters don't have to serialize the full
 * atom into the event stream.
 */
export interface AtomSubscribeEvent {
  readonly kind: 'put' | 'update';
  readonly atomId: AtomId;
}

// ---------------------------------------------------------------------------
// CanonStore
// ---------------------------------------------------------------------------

export interface CanonStore {
  /** Read canon. Selector may target a bracketed section; null returns whole canon. */
  read(selector?: string): Promise<string>;

  /** Create a proposal. Does not commit. Idempotent on identical (diff, principal, rationale). */
  propose(
    diff: Diff,
    principalId: PrincipalId,
    rationale: string,
  ): Promise<ProposalId>;

  /** Apply an approved proposal atomically. Returns commit ref for rollback. */
  commit(proposalId: ProposalId, approverId: PrincipalId): Promise<CommitRef>;

  /** Reverse a commit. The revert is itself a commit; returns its ref. */
  revert(
    commitRef: CommitRef,
    reason: string,
    principalId: PrincipalId,
  ): Promise<CommitRef>;

  /** Canon change history for audit and taint cascade. */
  history(pathFilter?: string, limit?: number): Promise<ReadonlyArray<Commit>>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LLM {
  /**
   * Single sandboxed primitive for every LLM-in-the-loop call. Specialization
   * happens via the schema argument: dedup, arbitrate, validate, classify,
   * propose-diff, summarize, anomaly-check, etc.
   *
   * Adapter MUST:
   *  - Render `data` values as DATA (templated, escaped), never as prompt.
   *  - Isolate context: no session history leakage.
   *  - Disable all tool access.
   *  - Validate output against `schema`; throw ValidationError on mismatch.
   *  - Log prompt_fingerprint and schema_fingerprint to the Auditor.
   */
  judge<T = unknown>(
    schema: JsonSchema,
    system: string,
    data: Readonly<Record<string, unknown>>,
    options: LlmOptions,
  ): Promise<JudgeResult<T>>;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

export interface Notifier {
  telegraph(
    event: Event,
    diff: Diff | null,
    defaultDisposition: Disposition,
    timeoutMs: number,
  ): Promise<NotificationHandle>;

  disposition(handle: NotificationHandle): Promise<Disposition>;

  awaitDisposition(
    handle: NotificationHandle,
    maxWaitMs: number,
  ): Promise<Disposition>;

  respond(
    handle: NotificationHandle,
    disposition: Disposition,
    responderId: PrincipalId,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type SchedulerHandler = () => void | Promise<void>;

export interface Scheduler {
  /** Register a recurring task by cron expression. */
  recurring(
    taskId: string,
    cronExpr: string,
    handler: SchedulerHandler,
  ): RegistrationId;

  /** One-shot deferred task. */
  defer(
    taskId: string,
    delayMs: number,
    handler: SchedulerHandler,
  ): RegistrationId;

  cancel(reg: RegistrationId): void;

  /** Called by every scheduled handler before running. If true, halt all writes. */
  killswitchCheck(): boolean;
}

// ---------------------------------------------------------------------------
// Auditor
// ---------------------------------------------------------------------------

export interface Auditor {
  log(event: AuditEvent): Promise<AuditId>;

  query(filter: AuditFilter, limit: number): Promise<ReadonlyArray<AuditEvent>>;

  /** Non-blocking metric emission. */
  metric(
    name: string,
    value: number,
    tags?: Readonly<Record<string, string>>,
  ): void;
}

// ---------------------------------------------------------------------------
// PrincipalStore
// ---------------------------------------------------------------------------

export interface PrincipalStore {
  get(id: PrincipalId): Promise<Principal | null>;

  put(p: Principal): Promise<PrincipalId>;

  permits(
    principalId: PrincipalId,
    action: Action,
    target: Target,
  ): Promise<boolean>;

  markCompromised(
    id: PrincipalId,
    atTime: Time,
    reason: string,
  ): Promise<void>;

  listActive(): Promise<ReadonlyArray<Principal>>;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface Clock {
  /** Current wall time as ISO-8601 UTC string. */
  now(): Time;

  /** Strictly-increasing nanosecond counter since adapter init. */
  monotonic(): bigint;
}

// ---------------------------------------------------------------------------
// Embedder (pluggable retrieval backend)
// ---------------------------------------------------------------------------

/**
 * Pluggable vector embedder used by AtomStore.search.
 *
 * The default TrigramEmbedder (src/adapters/_common/trigram-embedder.ts)
 * is good enough for LAG's common case; per-user memory with reinforced
 * subjects; but collapses on pure-semantic paraphrase. Wire a different
 * implementation (Anthropic embeddings API, local mini-lm via
 * onnxruntime-node, ...) by passing it to createMemoryHost / createFileHost.
 *
 * Conformance contract (see test/conformance/shared/embedder-spec.ts):
 *   - embed(x) is deterministic across calls within a process.
 *   - similarity is symmetric: s(a, b) === s(b, a).
 *   - similarity of identical inputs rounds to 1.0.
 *   - Embedding dimension is stable across calls on the same instance.
 *
 * Return-range convention: similarity matches AtomStore.similarity
 * (raw cosine in [-1, 1]). AtomStore.search normalizes this to [0, 1]
 * for SearchHit.score internally; Embedder authors should NOT pre-
 * normalize.
 */
export interface Embedder {
  /**
   * Stable identifier for this embedder's output space. If present,
   * CachingEmbedder namespaces its on-disk cache by this id so that
   * switching embedders does not poison cross-session retrieval.
   *
   * Convention: `<family>-<variant>` (e.g. 'trigram-fnv-128',
   * 'onnx-all-minilm-l6-v2'). Include any parameter that affects
   * output dimensions or values.
   *
   * Optional so that quick in-process embedders (tests, stubs) need
   * not declare one; the caching decorator will require it explicitly
   * if omitted.
   */
  readonly id?: string;

  /** Produce a vector for the input text. */
  embed(text: string): Promise<Vector>;

  /** Score two vectors. Raw cosine in [-1, 1]. */
  similarity(a: Vector, b: Vector): number;
}

// ---------------------------------------------------------------------------
// Transactions (optional capability)
// ---------------------------------------------------------------------------

export interface Transaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface TransactionalCapable {
  supportsTransactions(): boolean;
  /**
   * Only present when supportsTransactions() returns true.
   * Adapters that cannot support atomic multi-resource transactions omit this
   * and rely on compensating actions in LAG logic.
   */
  transaction?<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Host: the composed bundle passed to LAG logic
// ---------------------------------------------------------------------------

export interface Host {
  readonly atoms: AtomStore;
  readonly canon: CanonStore;
  readonly llm: LLM;
  readonly notifier: Notifier;
  readonly scheduler: Scheduler;
  readonly auditor: Auditor;
  readonly principals: PrincipalStore;
  readonly clock: Clock;
  readonly transactional?: TransactionalCapable;
}
