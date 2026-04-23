/**
 * Decision -> runCodeAuthor executor handoff.
 *
 * `executeDecision` is the thin adapter that closes the virtual-org
 * governance loop: a `deliberate()` call produces a Decision atom,
 * and `executeDecision` turns that Decision into an invocation of
 * the `runCodeAuthor` sub-actor primitive. Successful invocations
 * return a `PrOpenedAtom`; any failure path returns an
 * `ExecutionFailedAtom` so the governance layer keeps provenance
 * chained through failed executions too.
 *
 * Why atoms on both paths (and no throws):
 *   The Decision -> PR edge is the first place where a deliberation
 *   outcome reaches out to an external system (GitHub). A thrown
 *   exception severs the provenance chain and leaves the caller
 *   guessing. An `ExecutionFailedAtom` carries the failure reason +
 *   stage + derived_from back to the Decision + Question, so a
 *   post-mortem auditor can reconstruct what the deliberation
 *   decided, what was attempted, and where it stopped.
 *
 * Boundary discipline:
 *   - `codeAuthorFn` is injectable. The default is `runCodeAuthor`
 *     from the actor-message primitive. Tests inject a mock so no
 *     real plan-atom synthesis, fence load, or GitHub call happens
 *     under test. A non-default consumer (LangGraph-driven, external
 *     workflow engine) can inject its own fn.
 *   - `prResolver` is optional: when the injected `codeAuthorFn`
 *     returns a `dispatched` summary without the PR fields embedded,
 *     `prResolver` supplies them. The real `runCodeAuthor` records
 *     the PR handle on its observation atom, but the summary only
 *     carries a text representation; tests use the resolver to
 *     pin the atom content deterministically. For a production
 *     caller wiring the full chain, `prResolver` would read the
 *     observation atom written by `runCodeAuthor`.
 *   - The module does not write to the AtomStore. It returns a
 *     pattern-layer atom shape the boot script persists via its
 *     existing `atomStore.put(atom)` path. Separating shape from
 *     persistence mirrors the deliberation coordinator's sink
 *     pattern.
 *
 * derived_from ordering: [decision.id, question.id]
 *   The Decision is the direct parent; the Question is the
 *   grandparent. Pinning this order lets a downstream audit walker
 *   answer "which decision produced this PR?" in one lookup without
 *   re-scanning the full chain.
 *
 * principal_id discipline: the emitted atom is authored by
 *   `executorPrincipalId`, NOT by the Decision's author. The
 *   deliberation author (typically `vo-cto` for virtual-org) made
 *   the call; the executor principal (typically `vo-code-author`)
 *   carried it out. Mixing the two would mis-attribute the PR to
 *   the deliberation author and break the audit chain.
 */

import type { Host } from '../../substrate/interface.js';
import type { Atom, AtomId, PrincipalId } from '../../substrate/types.js';
import type {
  Decision,
  Question,
} from '../../substrate/deliberation/patterns.js';
import {
  runCodeAuthor,
  type CodeAuthorPayload,
  type CodeAuthorExecutor,
} from '../../runtime/actor-message/code-author-invoker.js';
import type { InvokeResult } from '../../runtime/actor-message/sub-actor-registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the codeAuthorFn signature. Matches `runCodeAuthor`'s
 * public signature so a caller can pass either the real function or
 * a test-time mock without shims.
 */
export type CodeAuthorFn = (
  host: Host,
  payload: CodeAuthorPayload,
  correlationId: string,
  options?: {
    readonly principalId?: PrincipalId;
    readonly executor?: CodeAuthorExecutor;
    readonly signal?: AbortSignal;
    readonly now?: () => number;
    readonly idNonce?: string;
  },
) => Promise<InvokeResult>;

/**
 * PR handle bundle. Populated by `prResolver` when the injected
 * codeAuthorFn doesn't return the fields natively on the dispatch
 * summary. A production caller using the real `runCodeAuthor`
 * resolves these off the observation atom's metadata.
 */
export interface PrHandle {
  readonly prNumber: number;
  readonly commitSha: string;
  readonly branchName: string;
  readonly url?: string;
}

export interface ExecuteDecisionArgs {
  readonly decision: Decision;
  readonly question: Question;
  /** Principal id authoring the emitted atom (typically 'vo-code-author'). */
  readonly executorPrincipalId: string;
  readonly host: Host;
  /** Injectable for tests; defaults to the real runCodeAuthor. */
  readonly codeAuthorFn?: CodeAuthorFn;
  /**
   * Called on success to resolve the PR number + commit + branch.
   * Optional; when absent the executor parses the dispatched summary
   * string. When both are absent, a PR handle of { prNumber: -1 }
   * is recorded so the caller sees "something dispatched, details
   * unresolved."
   */
  readonly prResolver?: () => Promise<PrHandle>;
  /** Fired on success only, never on failure. */
  readonly onPrOpened?: (atom: PrOpenedAtom) => void;
  /**
   * Override the correlation id passed to `codeAuthorFn`. Defaults
   * to `execute-decision-${decision.id}`.
   */
  readonly correlationId?: string;
  /** Clock injection for deterministic atom ids. */
  readonly now?: () => number;
  /**
   * Caller-supplied factory that produces the Plan atom to be
   * materialized before `codeAuthorFn` runs. The returned atom's id
   * is what the invoker sees as `payload.plan_id`.
   *
   * Default: `defaultPlanAtomFactory`, which produces an Atom with
   * `id: plan-from-<decision.id>`, `type: 'plan'`, `plan_state:
   * 'executing'`, `content: decision.answer`,
   * `provenance.derived_from: [decision.id]`, and
   * `principal_id: executorPrincipalId`. Swap in a custom factory
   * when the caller wants a different id convention or richer
   * metadata (e.g. a LangGraph node embedding workflow state).
   *
   * Per host-gap doc §2: the Decision atom is the signed
   * authorizing artifact; reusing `decision.id` for the Plan atom
   * would either collide on write or overwrite the Decision,
   * breaking the audit chain. The Plan is a separate, mutable L1
   * atom the executor transitions through `plan_state`.
   */
  readonly planAtomFactory?: (decision: Decision) => Atom;
}

/**
 * Pattern-layer atom: a successful Decision -> PR handoff.
 * Intentionally narrower than the core Atom type so the boot
 * script's existing sink layer (pattern -> core atom) owns the full
 * provenance shape. Kept as an `observation` atom with `kind:
 * 'pr-opened'` metadata to slot into the same audit filters the
 * existing coordinator sink uses.
 */
export interface PrOpenedAtom {
  readonly id: string;
  readonly type: 'observation';
  readonly kind: 'pr-opened';
  /** JSON-encoded { prNumber, branchName, commitSha, url }. */
  readonly content: string;
  readonly principal_id: string;
  /** [decision.id, question.id] in that order. */
  readonly derivedFrom: ReadonlyArray<string>;
  readonly created_at: string;
}

export interface ExecutionFailedAtom {
  readonly id: string;
  readonly type: 'observation';
  readonly kind: 'execution-failed';
  /** JSON-encoded { reason, stderr, stage }. */
  readonly content: string;
  readonly principal_id: string;
  /** [decision.id, question.id] in that order. */
  readonly derivedFrom: ReadonlyArray<string>;
  readonly created_at: string;
}

export type ExecuteDecisionResult = PrOpenedAtom | ExecutionFailedAtom;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function executeDecision(
  args: ExecuteDecisionArgs,
): Promise<ExecuteDecisionResult> {
  const {
    decision,
    question,
    executorPrincipalId,
    host,
    codeAuthorFn = runCodeAuthor,
    prResolver,
    onPrOpened,
    correlationId = `execute-decision-${decision.id}`,
    now = () => Date.now(),
    planAtomFactory,
  } = args;

  const derivedFrom: ReadonlyArray<string> = [decision.id, question.id];
  const createdAt = new Date(now()).toISOString();

  // Materialize a fresh Plan atom BEFORE invoking `runCodeAuthor`.
  //
  // Per host-gap doc §2: the Decision atom is the signed authorizing
  // artifact and carries `type: 'decision'` + `authorPrincipal:
  // vo-cto`; those fields are load-bearing for audit. The invoker
  // re-resolves `payload.plan_id` via `host.atoms.get()` and asserts
  // `plan.type === 'plan'` + `plan.plan_state === 'executing'`, so
  // passing `decision.id` here would (a) collide on write if a plan
  // already exists at that id, or (b) cause the invoker to reject
  // the atom with type=decision. A separate, mutable Plan atom the
  // executor can transition through `plan_state` is the correct
  // shape.
  //
  // Id convention `plan-from-<decision.id>` is the host-gap doc
  // recommendation (b); a caller with a different convention passes
  // `planAtomFactory`.
  const planAtom: Atom = planAtomFactory !== undefined
    ? planAtomFactory(decision)
    : defaultPlanAtomFactory(decision, executorPrincipalId, createdAt);
  await host.atoms.put(planAtom);

  const payload: CodeAuthorPayload = { plan_id: planAtom.id };

  let invokeResult: InvokeResult;
  try {
    invokeResult = await codeAuthorFn(host, payload, correlationId, {
      principalId: executorPrincipalId as PrincipalId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return buildFailedAtom({
      decision,
      executorPrincipalId,
      derivedFrom,
      createdAt,
      reason,
      stage: 'code-author-fn-threw',
    });
  }

  if (invokeResult.kind === 'error') {
    return buildFailedAtom({
      decision,
      executorPrincipalId,
      derivedFrom,
      createdAt,
      reason: invokeResult.message,
      stage: 'code-author-returned-error',
    });
  }

  // `kind: 'completed'` means the invoker ran without an executor
  // injected (observation-only path). We still treat it as success
  // for the Decision -> handoff contract: the code-author principal
  // acknowledged the decision. A future caller that needs a true
  // PR-handle can gate on `invokeResult.kind === 'dispatched'`.
  let prHandle: PrHandle;
  if (prResolver !== undefined) {
    prHandle = await prResolver();
  } else {
    prHandle = parseDispatchSummary(invokeResult);
  }

  const atom: PrOpenedAtom = {
    id: `pr-opened-${decision.id}-${createdAt}`,
    type: 'observation',
    kind: 'pr-opened',
    content: JSON.stringify({
      prNumber: prHandle.prNumber,
      branchName: prHandle.branchName,
      commitSha: prHandle.commitSha,
      url: prHandle.url ?? renderPrUrl(prHandle.prNumber),
    }),
    principal_id: executorPrincipalId,
    derivedFrom,
    created_at: createdAt,
  };

  if (onPrOpened !== undefined) {
    onPrOpened(atom);
  }
  return atom;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildFailedAtom(opts: {
  readonly decision: Decision;
  readonly executorPrincipalId: string;
  readonly derivedFrom: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly reason: string;
  readonly stage: string;
}): ExecutionFailedAtom {
  return {
    id: `execution-failed-${opts.decision.id}-${opts.createdAt}`,
    type: 'observation',
    kind: 'execution-failed',
    content: JSON.stringify({
      reason: opts.reason,
      stderr: '',
      stage: opts.stage,
    }),
    principal_id: opts.executorPrincipalId,
    derivedFrom: opts.derivedFrom,
    created_at: opts.createdAt,
  };
}

/**
 * Parse a dispatched-result summary for a PR number. The real
 * `runCodeAuthor` writes its PR handle on the observation atom's
 * metadata; the summary is a human-readable one-liner of form
 * `code-author dispatched plan X as PR #123 (abcdef0)`. When the
 * caller hasn't supplied a prResolver we fall back to parsing this
 * string so the PR number at minimum gets into the PrOpenedAtom.
 *
 * Returns a sentinel { -1, 'unknown', 'unknown' } when the parse
 * fails; the caller sees a recognizable marker rather than a silent
 * misread.
 */
function parseDispatchSummary(result: InvokeResult): PrHandle {
  if (result.kind !== 'dispatched' && result.kind !== 'completed') {
    return { prNumber: -1, commitSha: 'unknown', branchName: 'unknown' };
  }
  const match = result.summary.match(/PR #(\d+) \(([0-9a-f]+)\)/);
  if (match === null) {
    return { prNumber: -1, commitSha: 'unknown', branchName: 'unknown' };
  }
  return {
    prNumber: Number.parseInt(match[1]!, 10),
    commitSha: match[2]!,
    branchName: 'unknown',
  };
}

function renderPrUrl(prNumber: number): string {
  // Synthetic URL format so audit-consumers always see a recognizable
  // shape; a production caller with github remote context would
  // inject an explicit url via prResolver.
  return `pr://unresolved/#${prNumber}`;
}

/**
 * Default Plan-atom factory: produces a minimal `type: 'plan'`,
 * `plan_state: 'executing'` atom derived from a Decision.
 *
 * Id convention: `plan-from-<decision.id>`. Per host-gap doc §2 the
 * Decision's own id is reserved for the signed authorizing atom; the
 * Plan lives at a derived id so the two never collide and the
 * invoker's `plan_state === 'executing'` guard resolves to this
 * atom.
 *
 * `provenance.derived_from: [decision.id]` anchors the provenance
 * chain one hop back to the Decision; a downstream audit walker
 * reaches the Question via the Decision's own derived_from. The
 * plan is authored by `executorPrincipalId` (typically
 * `vo-code-author`), NOT the deliberation author, so the act of
 * execution is attributed correctly.
 *
 * Layer: L1 (observed/in-flight). A plan is mutable until it
 * terminates (`succeeded` / `failed` / `abandoned`); treating it as
 * L1 matches the life-cycle axis in substrate/types.ts which keeps
 * the trust axis (layer) orthogonal to the state-machine axis
 * (plan_state).
 */
function defaultPlanAtomFactory(
  decision: Decision,
  executorPrincipalId: string,
  createdAt: string,
): Atom {
  const id = `plan-from-${decision.id}` as AtomId;
  return {
    schema_version: 1,
    id,
    content: decision.answer,
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: executorPrincipalId,
        tool: 'executeDecision',
      },
      derived_from: [decision.id as AtomId],
    },
    confidence: 1.0,
    created_at: createdAt,
    last_reinforced_at: createdAt,
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
    principal_id: executorPrincipalId as PrincipalId,
    taint: 'clean',
    metadata: {
      kind: 'plan-from-decision',
      decision_id: decision.id,
    },
    plan_state: 'executing',
  };
}
