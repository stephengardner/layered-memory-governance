/**
 * AgentLoopAdapter: the substrate seam for any actor that wants
 * multi-turn agentic reasoning.
 *
 * Why this exists
 * ---------------
 * The single-shot `LLM.judge()` primitive is sufficient for one-prompt
 * decisions (classify, dedup, propose-diff). For tasks that need
 * iterative reasoning + tool use (read a file, edit it, run tests,
 * fix errors, commit), an actor needs a multi-turn loop. This seam is
 * that loop; concrete implementations (Claude Code, LangGraph, custom
 * node loops) are pluggable: the framework defines the contract here,
 * adapters live in `examples/agent-loops/` and may be swapped wholesale.
 *
 * Threat model
 * ------------
 * - The agent process inherits whatever credentials are in
 *   `input.workspace`'s `.lag/apps/`. The caller (the actor or
 *   executor invoking the adapter) is responsible for cred
 *   provisioning with the minimum scope before invoking the adapter;
 *   concrete callers live outside this seam.
 * - Adapters MUST apply `input.redactor` to ALL content before atom
 *   write. A redactor crash MUST surface as `catastrophic`; never
 *   fall through to write unredacted content.
 * - Tool calls denied by `input.toolPolicy` MUST emit
 *   `tool_calls[].outcome: 'policy-refused'` and the agent MUST
 *   receive a structured refusal it can reason about. Silent denial
 *   is a substrate violation.
 * - `input.budget` is the runaway guard. Adapters MUST honor
 *   `max_turns` + `max_wall_clock_ms`; `max_usd` is honored only when
 *   `capabilities.tracks_cost === true`.
 * - `AgentLoopResult.artifacts.commitSha` is adapter-supplied.
 *   Consumers (the executor that called the adapter) MUST verify the
 *   commit exists in the workspace before trusting it; an adapter
 *   could in principle return a stale or fabricated SHA.
 *
 * Contract
 * --------
 * The adapter MUST:
 *   1. Write an `agent-session` atom on entry, populating
 *      `started_at`, `replay_tier`, `workspace_id`, and an optimistic
 *      `terminal_state` (typically `'completed'`). `AgentSessionMeta`
 *      has no `state` field; lifecycle is captured via `started_at`,
 *      optional `completed_at`, and `terminal_state`. The same atom
 *      is updated on exit.
 *   2. Write an `agent-turn` atom for each LLM call BEFORE issuing
 *      the call (so the audit trail captures even mid-turn crashes).
 *   3. Apply `input.redactor` to all content before atom write.
 *   4. Honor `input.budget` (turns + wall_clock_ms; usd if capable).
 *   5. Honor `input.signal` if `capabilities.supports_signal === true`.
 *   6. Update the session atom on exit (terminal_state, failure,
 *      budget_consumed, completed_at).
 *
 * The adapter MAY:
 *   - Persist large turn payloads via `input.blobStore` according to
 *     `input.blobThreshold`.
 *   - Compute and persist `canon_snapshot_blob_ref` when
 *     `input.replayTier === 'strict'`.
 *   - Override `defaultClassifyFailure` via
 *     `capabilities.classify_failure` to cover adapter-specific error
 *     shapes.
 */

import type {
  AtomId,
  FailureKind,
  FailureRecord,
  PrincipalId,
  ReplayTier,
} from './types.js';
import type { Host } from './interface.js';
import type { Workspace } from './workspace-provider.js';
import type { BlobStore } from './blob-store.js';
import type { Redactor } from './redactor.js';
import type { BudgetCap } from './agent-budget.js';

export interface AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities;
  run(input: AgentLoopInput): Promise<AgentLoopResult>;
}

export interface AdapterCapabilities {
  /** Adapter can report per-call USD cost; executor honors `max_usd` only if true. */
  readonly tracks_cost: boolean;
  /** Adapter honors `AgentLoopInput.signal` for cooperative cancellation. */
  readonly supports_signal: boolean;
  /**
   * Adapter-specific failure classifier. Adapters that do not need
   * adapter-specific error shapes set this to `defaultClassifyFailure`.
   */
  readonly classify_failure: (err: unknown) => FailureKind;
}

export interface ToolPolicy {
  readonly disallowedTools: ReadonlyArray<string>;
  readonly rationale?: string;
}

export interface AgentTask {
  readonly planAtomId: AtomId;
  readonly questionPrompt?: string;
  readonly fileContents?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly successCriteria?: string;
  readonly targetPaths?: ReadonlyArray<string>;
}

export interface AgentLoopInput {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly workspace: Workspace;
  readonly task: AgentTask;
  readonly budget: BudgetCap;
  readonly toolPolicy: ToolPolicy;
  readonly redactor: Redactor;
  readonly blobStore: BlobStore;
  readonly replayTier: ReplayTier;
  /** Already clamped via `clampBlobThreshold`. */
  readonly blobThreshold: number;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface AgentLoopResult {
  /**
   * Terminal kind aligned with `AgentSessionMeta.terminal_state` so the
   * adapter return value and the persisted session atom share one
   * vocabulary. `'aborted'` is reserved for adapters that honor an
   * `AbortSignal` and want to return cooperatively rather than throw
   * `AbortError`; adapters that declare
   * `capabilities.supports_signal === false` will not produce this
   * kind.
   */
  readonly kind: 'completed' | 'budget-exhausted' | 'error' | 'aborted';
  readonly sessionAtomId: AtomId;
  readonly turnAtomIds: ReadonlyArray<AtomId>;
  readonly failure?: FailureRecord;
  readonly artifacts?: {
    readonly commitSha?: string;
    readonly branchName?: string;
    readonly touchedPaths?: ReadonlyArray<string>;
  };
}

/**
 * Default failure classifier. Adapters override via
 * `capabilities.classify_failure` for adapter-specific error shapes.
 *
 * Heuristics:
 *   - HTTP 429 / 502 / 503 / 504    -> transient (rate / upstream blip)
 *   - ECONN* / EBUSY / EAGAIN /
 *     ETIMEDOUT / ENOTFOUND         -> transient (network / fs blip)
 *   - AbortError                    -> catastrophic (signal aborted)
 *   - everything else               -> structural
 *
 * The intentional bias: lean toward `structural` for unknown errors.
 * Retrying an unknown failure burns budget; escalating asks the
 * operator. Operator escalation is recoverable; runaway retry is not.
 *
 * AbortError mapping rationale: signal-driven cancellation maps to
 * `catastrophic` (not a literal "host fault") because (a) running a
 * retry loop on an operator's "cancel" is the worst possible UX -
 * the operator clicked stop, the loop must halt; and (b) it's a
 * control-flow event that needs to terminate the chain, semantically
 * equivalent to a host fault from the agent loop's perspective. The
 * `FailureKind` doc-comment uses "host-level fault" as the canonical
 * description of `catastrophic`; treat operator-cancel as the same
 * "do not retry, stop the chain" outcome.
 */
export function defaultClassifyFailure(err: unknown): FailureKind {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'catastrophic';
  }
  if (err === null || err === undefined || typeof err !== 'object') {
    return 'structural';
  }
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown };
  const status = typeof e.statusCode === 'number'
    ? e.statusCode
    : (typeof e.status === 'number' ? e.status : undefined);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return 'transient';
  }
  if (typeof e.code === 'string' && (
    e.code.startsWith('ECONN') ||
    e.code === 'EBUSY' ||
    e.code === 'EAGAIN' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ENOTFOUND'
  )) {
    return 'transient';
  }
  return 'structural';
}
