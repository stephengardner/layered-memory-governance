/**
 * workspace-specific adapter stub. Pressure-tests the host interface against the
 * production substrate (Python ChromaDB bridge, chromadb, git, claude CLI, fs).
 *
 * Every method throws; this file is a design artifact. The real implementation
 * lands in Phase 7 of the roadmap. Its purpose is to validate at compile time
 * that the interface is expressible over the production substrate.
 *
 * If this file type-checks and each docstring has a plausible implementation
 * strategy, the interface is sound.
 *
 * Conventions in this file:
 *  - Each method has a short comment describing the exact implementation path.
 *  - Lines beginning with "INTERFACE-CHECK:" flag constraints the substrate
 *    imposes that could warrant an interface revision.
 */

import { UnsupportedError } from '../../substrate/errors.js';
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
} from '../../substrate/types.js';
import type {
  AtomStore,
  Auditor,
  CanonStore,
  Clock,
  Host,
  LLM,
  Notifier,
  PrincipalStore,
  Scheduler,
  SchedulerHandler,
  Transaction,
  TransactionalCapable,
} from '../../substrate/interface.js';

const NI = (method: string): never => {
  throw new UnsupportedError(
    `PhxAdapter.${method} is a Phase 1 stub; real implementation lands in Phase 7.`,
  );
};

// ---------------------------------------------------------------------------
// AtomStore - external palace + chromadb
// ---------------------------------------------------------------------------

export class BridgeAtomStore implements AtomStore {
  /**
   * chromadb col.add({ids:[atom.id], documents:[atom.content],
   * embeddings:[embed(atom.content)], metadatas:[flatten(atom)]}).
   * On id collision, catch and rethrow as ConflictError.
   */
  async put(_atom: Atom): Promise<AtomId> {
    return NI('put');
  }

  /** col.get({ids:[id], include:['documents','metadatas','embeddings']}). */
  async get(_id: AtomId): Promise<Atom | null> {
    return NI('get');
  }

  /**
   * col.get({where: filterToChromaWhere(filter), limit, offset: decodeCursor(cursor),
   *          include:['documents','metadatas']}). Chroma where supports
   * $eq $ne $in $nin $and $or $gt $gte $lt $lte which covers AtomFilter.
   */
  async query(
    _filter: AtomFilter,
    _limit: number,
    _cursor?: string,
  ): Promise<AtomPage> {
    return NI('query');
  }

  /**
   * If query is string: col.query({queryTexts:[query], nResults:k, where:...}).
   * If query is Vector: col.query({queryEmbeddings:[query], nResults:k, ...}).
   * Score = 1 - distance (chroma returns L2 or cosine distance; we configure cosine).
   */
  async search(
    _query: string | Vector,
    _k: number,
    _filter?: AtomFilter,
  ): Promise<ReadonlyArray<SearchHit>> {
    return NI('search');
  }

  /**
   * col.update({ids:[id], metadatas:[patchToMetadata(patch)]}).
   * INTERFACE-CHECK: chroma update is metadata-only, which is fine because
   * Atom.content is immutable by spec. All patchable fields live in metadata.
   */
  async update(_id: AtomId, _patch: AtomPatch): Promise<Atom> {
    return NI('update');
  }

  /**
   * First query(filter) to get ids, then col.update with the patch applied
   * to each. For taint cascade, which can touch thousands of atoms.
   */
  async batchUpdate(_filter: AtomFilter, _patch: AtomPatch): Promise<number> {
    return NI('batchUpdate');
  }

  /**
   * Use chroma collection's configured embedding function, same one the external store
   * mine uses, so embeddings are consistent across write paths.
   * INTERFACE-CHECK: must be deterministic within adapter version. Conformance
   * suite verifies embed(x) == embed(x).
   */
  async embed(_text: string): Promise<Vector> {
    return NI('embed');
  }

  /** Pure math: dot(a,b) / (norm(a) * norm(b)). */
  similarity(_a: Vector, _b: Vector): number {
    throw NI('similarity');
  }

  /**
   * Normalize: lowercase, collapse whitespace, strip non-semantic trailing
   * punctuation. sha256 hex of normalized UTF-8 bytes, truncated to 32 chars.
   * Used for deterministic dedup of canonical-form atoms (paths, identifiers).
   */
  contentHash(_text: string): string {
    throw NI('contentHash');
  }
}

// ---------------------------------------------------------------------------
// CanonStore - git-managed file in lag/canon/
// ---------------------------------------------------------------------------

export class PhxCanonStore implements CanonStore {
  /**
   * Canon lives in lag/canon/current.md (its own git repo).
   * If selector is provided, extract a heading-based section; else return full.
   * INTERFACE-CHECK: the choice of separate-file vs CLAUDE.md-bracketed-section
   * is an adapter decision, not an interface one. A sibling adapter can embed.
   */
  async read(_selector?: string): Promise<string> {
    return NI('read');
  }

  /**
   * Generate proposalId = sha256(diff + principal_id + rationale).
   * Write proposals/<proposalId>.json with {diff, principal_id, rationale,
   * created_at, status: "pending"}. Idempotent on identical content.
   */
  async propose(
    _diff: Diff,
    _principalId: PrincipalId,
    _rationale: string,
  ): Promise<ProposalId> {
    return NI('propose');
  }

  /**
   * Load proposal, write diff.after to target path, `git add` both files,
   * `git commit -m "canon: <rationale> [proposal:<id>][approver:<id>]"`,
   * return commit sha.
   */
  async commit(
    _proposalId: ProposalId,
    _approverId: PrincipalId,
  ): Promise<CommitRef> {
    return NI('commit');
  }

  /**
   * `git revert <ref> --no-edit`, then `git commit --amend` to add reason and
   * principal to the revert commit message. Return the new sha.
   */
  async revert(
    _commitRef: CommitRef,
    _reason: string,
    _principalId: PrincipalId,
  ): Promise<CommitRef> {
    return NI('revert');
  }

  /** `git log --format=...` over the target path, parse into Commit[]. */
  async history(
    _pathFilter?: string,
    _limit?: number,
  ): Promise<ReadonlyArray<Commit>> {
    return NI('history');
  }
}

// ---------------------------------------------------------------------------
// LLM - claude CLI via Execa
// ---------------------------------------------------------------------------

export class PhxLLM implements LLM {
  /**
   * Build prompt:
   *   userMessage = `DATA:\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n
   *                  Respond with JSON matching the provided schema.`
   * Run Execa('claude', [
   *   '-p', userMessage,
   *   '--model', options.model,
   *   '--max-budget-usd', options.max_budget_usd,
   *   '--disallowedTools', '*',
   *   '--disable-slash-commands',
   *   '--append-system-prompt-file', systemFileWith(system),
   *   '--json-schema', JSON.stringify(schema),
   *   '--output-format', 'json',
   * ]).
   * Parse stdout JSON. Validate against schema. Compute prompt_fingerprint
   * as sha256(system), schema_fingerprint as sha256(JSON.stringify(schema)).
   * Measure latency via clock delta around the Execa call.
   * input_tokens / output_tokens / cost_usd from --output-format json if
   * claude reports them; else return -1.
   * INTERFACE-CHECK: adapter limitation re: unreliable token reporting is
   * documented; interface expects -1 sentinel and does not require these.
   */
  async judge<T = unknown>(
    _schema: JsonSchema,
    _system: string,
    _data: Readonly<Record<string, unknown>>,
    _options: LlmOptions,
  ): Promise<JudgeResult<T>> {
    return NI('judge');
  }
}

// ---------------------------------------------------------------------------
// Notifier - file-based queue
// ---------------------------------------------------------------------------

export class PhxNotifier implements Notifier {
  /**
   * handle = sha256(event.summary + event.created_at).
   * Write pending/<handle>.json with {event, diff, defaultDisposition,
   * timeoutAt: clock.now() + timeoutMs, status: "pending"}.
   * Idempotent: same payload returns same handle.
   */
  async telegraph(
    _event: Event,
    _diff: Diff | null,
    _defaultDisposition: Disposition,
    _timeoutMs: number,
  ): Promise<NotificationHandle> {
    return NI('telegraph');
  }

  /** Read pending/<handle>.json or responded/<handle>.json, return status. */
  async disposition(_handle: NotificationHandle): Promise<Disposition> {
    return NI('disposition');
  }

  /**
   * Poll disposition() with exponential backoff. On timeout, apply
   * defaultDisposition and move file to responded/, return that.
   */
  async awaitDisposition(
    _handle: NotificationHandle,
    _maxWaitMs: number,
  ): Promise<Disposition> {
    return NI('awaitDisposition');
  }

  /** Update status, move to responded/, log to Auditor. */
  async respond(
    _handle: NotificationHandle,
    _disposition: Disposition,
    _responderId: PrincipalId,
  ): Promise<void> {
    return NI('respond');
  }
}

// ---------------------------------------------------------------------------
// Scheduler - node cron + timers
// ---------------------------------------------------------------------------

export class PhxScheduler implements Scheduler {
  /** Register with a node cron library (e.g. node-cron) keyed on cronExpr. */
  recurring(
    _taskId: string,
    _cronExpr: string,
    _handler: SchedulerHandler,
  ): RegistrationId {
    throw NI('recurring');
  }

  /** setTimeout(handler, delayMs). Track the timer for cancel(). */
  defer(
    _taskId: string,
    _delayMs: number,
    _handler: SchedulerHandler,
  ): RegistrationId {
    throw NI('defer');
  }

  /** Look up registration, clearTimeout or cancel cron job. */
  cancel(_reg: RegistrationId): void {
    NI('cancel');
  }

  /**
   * Check for file at lag/STOP. Return true if present.
   * INTERFACE-CHECK: scheduled handlers must call this before running, not
   * just at init. Documented per-method.
   */
  killswitchCheck(): boolean {
    throw NI('killswitchCheck');
  }
}

// ---------------------------------------------------------------------------
// Auditor - JSONL append-only log
// ---------------------------------------------------------------------------

export class PhxAuditor implements Auditor {
  /**
   * auditId = sha256(JSON.stringify(event) + now). Append serialized event to
   * <palace-root>/audit.jsonl. Return id.
   * INTERFACE-CHECK: append-only is enforced by convention and conformance test
   * (file size is non-decreasing). chmod a-w would break subsequent writes.
   */
  async log(_event: AuditEvent): Promise<AuditId> {
    return NI('log');
  }

  /** Stream audit.jsonl, filter in JS. Linear scan fine for V0. */
  async query(
    _filter: AuditFilter,
    _limit: number,
  ): Promise<ReadonlyArray<AuditEvent>> {
    return NI('query');
  }

  /** Append to <palace-root>/metrics.jsonl. Non-blocking: queue + background flush. */
  metric(
    _name: string,
    _value: number,
    _tags?: Readonly<Record<string, string>>,
  ): void {
    NI('metric');
  }
}

// ---------------------------------------------------------------------------
// PrincipalStore - JSON files per principal
// ---------------------------------------------------------------------------

export class PhxPrincipalStore implements PrincipalStore {
  /** Read <palace-root>/principals/<id>.json, parse. null if missing. */
  async get(_id: PrincipalId): Promise<Principal | null> {
    return NI('get');
  }

  /** Write principals/<id>.json atomically (write-then-rename). */
  async put(_p: Principal): Promise<PrincipalId> {
    return NI('put');
  }

  /**
   * Load principal; if compromised_at set, return false unconditionally.
   * Else evaluate permission matrix: action vs principal.permitted_layers /
   * permitted_scopes for the target.
   */
  async permits(
    _principalId: PrincipalId,
    _action: Action,
    _target: Target,
  ): Promise<boolean> {
    return NI('permits');
  }

  /**
   * Load principal, set compromised_at and reason, write back.
   * Log to Auditor. Trigger taint propagation callback the LAG layer registered.
   */
  async markCompromised(
    _id: PrincipalId,
    _atTime: Time,
    _reason: string,
  ): Promise<void> {
    NI('markCompromised');
  }

  /** Scan principals/, load each, filter where compromised_at is null && active. */
  async listActive(): Promise<ReadonlyArray<Principal>> {
    return NI('listActive');
  }
}

// ---------------------------------------------------------------------------
// Clock - wall time
// ---------------------------------------------------------------------------

export class PhxClock implements Clock {
  /** new Date().toISOString(). */
  now(): Time {
    throw NI('now');
  }

  /** process.hrtime.bigint(). */
  monotonic(): bigint {
    throw NI('monotonic');
  }
}

// ---------------------------------------------------------------------------
// Transactions - NOT SUPPORTED
// ---------------------------------------------------------------------------

export class PhxTransactional implements TransactionalCapable {
  supportsTransactions(): boolean {
    return false;
  }
  /**
   * Omitted (optional member). LAG must use compensating actions:
   *   put atom (L2 -> L3 promoted copy)
   *   canon.commit proposal
   *   auditor.log
   * On step-2 failure, revert step 1 via atom.update(taint="quarantined").
   * On step-3 failure, enqueue dead-letter, alert.
   */
}

// ---------------------------------------------------------------------------
// Composite Host
// ---------------------------------------------------------------------------

export function createBridgeHost(): Host {
  return {
    atoms: new BridgeAtomStore(),
    canon: new PhxCanonStore(),
    llm: new PhxLLM(),
    notifier: new PhxNotifier(),
    scheduler: new PhxScheduler(),
    auditor: new PhxAuditor(),
    principals: new PhxPrincipalStore(),
    clock: new PhxClock(),
    transactional: new PhxTransactional(),
  };
}

// ---------------------------------------------------------------------------
// Interface validation findings (phase 1, ported from Python stub)
// ---------------------------------------------------------------------------

/*
All 30+ methods across 8 interface groups map cleanly to bridge substrate.
No interface changes required. Notable findings:

  1. Chroma metadata-only updates are fine because atom content is immutable.
     Confirms the Atom.content immutability choice.
  2. Canon location is adapter choice (separate file vs bracketed section).
     Interface abstracts correctly via selector.
  3. Claude CLI may not reliably report tokens/cost. Interface handles via
     -1 sentinel in JudgeMetadata. Documented as adapter limitation.
  4. Transactions across chroma + git + filesystem cannot be atomic without
     a distributed coordinator. Optional capability accepts this; LAG uses
     compensating actions for promotions.
  5. File-based notification queue is sufficient for V0. Interface abstracts
     the channel; Slack / Claude Code session-inject are alternate adapters.
  6. Scheduler killswitchCheck is called at every handler invocation, per
     docstring; conformance tests should verify.
  7. JSONL append-only audit log with linear-scan query. Scales to ~1M.
     Migrate to sqlite with indexes at scale, same interface, adapter swap.

Interface locked at v1.0. Proceeding to Phase 2: memory and file adapters.
*/
