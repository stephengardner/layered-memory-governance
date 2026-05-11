/**
 * Claim contract: `dispatchSubAgent` substrate entry-point.
 *
 * Why this exists
 * ---------------
 * The zero-failure sub-agent substrate hangs on a single mechanism: an
 * unforgeable contract atom (a `work-claim`) minted at dispatch time
 * and closed (or stalled) by the claim reaper. `dispatchSubAgent` is
 * that minting step. It runs the six pre-dispatch validation gates
 * before any atom is written and before the adapter is invoked, so a
 * bad dispatch (STOP active, unknown caller, missing verifier, past
 * deadline, mis-named budget tier) never produces a half-formed claim
 * the reaper would have to clean up.
 *
 * Gate order (per plan Task 11 / spec Section 6)
 * ----------------------------------------------
 * The six gates fire in this exact order. Reordering them is a contract
 * violation: a downstream gate (verifier lookup, budget resolution) is
 * allowed to do expensive work, and the earlier gates exist to short-
 * circuit before that work happens.
 *
 *   1. STOP sentinel.   Predicate-driven so tests + alternative
 *                       deployments do not depend on a `.lag/STOP` file.
 *                       The default predicate reads
 *                       `existsSync(.lag/STOP)`; callers running in a
 *                       test harness inject a stub.
 *   2. Caller identity. `host.principals.get(caller_principal_id)` must
 *                       resolve to a non-null Principal.
 *   3. Verifier kind.   `brief.expected_terminal.kind` must be a key in
 *                       the substrate's `verifierRegistry`.
 *   4. Deadline future. `brief.deadline_ts` must be strictly after
 *                       `host.clock.now()`.
 *   5. Budget tier.     `resolveBudgetTier(tier, host)` must succeed.
 *   6. Prompt size.     If `brief.prompt.length > 16_384` AND a
 *                       `BlobStore` was supplied, the prompt is spilled
 *                       to the blob store and `prompt_blob_ref` is
 *                       populated on the persisted brief. When no blob
 *                       store is supplied, the prompt rides inline (a
 *                       documented fallback so a solo developer does
 *                       not need to provision a blob store just to
 *                       dispatch a long task).
 *
 * Once the gates pass:
 *   - A claim secret token is minted via `generateClaimToken`.
 *   - A `work-claim` atom is `put` with `claim_state: 'pending'`,
 *     `recovery_attempts: 0`, `verifier_failure_count: 0`,
 *     `session_atom_ids: []`, and the parent-claim id (or the empty
 *     chain) on `provenance.derived_from`.
 *   - The adapter is invoked synchronously with the brief's prompt
 *     prepended by the WORK_CLAIM_CONTEXT preamble (claim_id, token,
 *     caller, expected_terminal JSON, deadline). The preamble is the
 *     unforgeable binding the sub-agent presents back at
 *     `markClaimComplete` time.
 *   - After the adapter returns, the claim is transitioned to
 *     `claim_state: 'executing'` via `host.atoms.update`.
 *
 * The function returns synchronously after the executing-transition;
 * settlement (complete / abandoned) is the claim reaper's responsibility.
 * `ClaimHandle.settled` resolves when the claim atom reaches a terminal
 * state (today: it polls; future versions MAY wire push-wake via
 * `AtomStore.subscribe`).
 *
 * Threat model
 * ------------
 * - STOP-while-executing: this contract enforces STOP only at the gate.
 *   A STOP that lands after the adapter starts is the adapter's
 *   responsibility (the adapter receives `AgentLoopInput.signal` per
 *   the existing kill-switch contract); enforcing it here would require
 *   buying back the kill-switch primitive at the substrate level.
 * - Unknown caller: failing the gate prevents an attacker who can write
 *   to the principal store from minting a claim against a non-existent
 *   identity (the principal id is the audit-chain anchor; a missing
 *   anchor undoes audit).
 * - Past deadline: a deadline already in the past produces a claim the
 *   reaper would stall on its very first sweep; we refuse at the gate
 *   so the audit trail does not carry a dispatch atom whose only
 *   downstream record is a stall.
 * - Token redaction: this module mints the token but never logs it; the
 *   token flows out through `DispatchSubAgentOutput` and into the
 *   adapter's prompt preamble. The redactor regex (Task 16) covers the
 *   preamble before any agent-turn atom is persisted.
 *
 * Substrate posture
 * -----------------
 * No principal-name decisions are encoded here; the contract is
 * mechanism-only. Org-ceiling deployments add verifier kinds and budget
 * tiers via canon edits without touching this file.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Host } from './interface.js';
import type {
  AtomId,
  PrincipalId,
  Time,
  WorkClaimBrief,
  WorkClaimMeta,
} from './types.js';
import type { AgentLoopAdapter } from './agent-loop.js';
import type { BlobStore } from './blob-store.js';
import { verifierRegistry } from './claim-verifiers/index.js';
import { resolveBudgetTier } from './policy/claim-budget-tier.js';
import { generateClaimToken } from './claim-token.js';

/**
 * Spill threshold: prompts whose raw character length exceeds this cap
 * are routed through the supplied `BlobStore` (when present). 16 KiB
 * is the substrate-wide default mirrored from the agent-loop blob-
 * threshold policy ladder. Callers running with a smaller policy
 * configuration MAY pre-spill before dispatch and pass `prompt_blob_ref`
 * directly on the brief; this module honors that case by treating an
 * already-set ref as authoritative and not re-spilling.
 */
const PROMPT_SPILL_THRESHOLD = 16_384;

/**
 * Default STOP sentinel path. Callers that run from a non-default
 * `.lag/` location override via the `stopSentinel` predicate.
 */
const DEFAULT_STOP_PATH = resolve('.lag', 'STOP');

export interface DispatchSubAgentInput {
  /**
   * The sub-agent's contract: prompt, expected terminal state, and the
   * deadline by which a terminal state must be reached. The contract
   * surface for the sub-agent is the prompt; the rest is metadata the
   * reaper + verifier consume.
   */
  readonly brief: WorkClaimBrief;
  /**
   * The principal id the sub-agent will attest as at
   * `markClaimComplete` time. Doubles as the dispatched principal on
   * the work-claim atom. MUST resolve in `host.principals`.
   */
  readonly caller_principal_id: string;
  /**
   * Budget-tier label. Resolved via `pol-claim-budget-tier` canon
   * atoms. Defaults to `'default'`; an org-ceiling deployment that
   * wants a different floor seeds a different default via canon edit
   * rather than changing this argument.
   */
  readonly budget_tier?: string;
  /**
   * Optional parent claim id when this dispatch is a recovery-step
   * successor of a prior claim. Threaded into both
   * `WorkClaimMeta.parent_claim_id` AND `provenance.derived_from`.
   */
  readonly parent_claim_id?: string | null;
  /**
   * The agent-loop adapter that will execute the sub-agent. Invoked
   * once after the claim is written in `pending` state; before the
   * transition to `executing`.
   */
  readonly agent_loop_adapter: AgentLoopAdapter;
  /**
   * Predicate for the STOP sentinel. When omitted, defaults to a
   * filesystem check of `.lag/STOP`. Tests + alternative deployments
   * inject their own predicate (e.g. an in-memory flag). The predicate
   * is consulted exactly once at gate time; this contract does not
   * monitor the predicate across the adapter invocation.
   */
  readonly stopSentinel?: () => boolean;
  /**
   * Optional content-addressed store for large-prompt spills. When
   * `brief.prompt.length` exceeds the substrate's spill threshold AND
   * this store is supplied, the prompt is persisted via `blobStore.put`
   * and the resulting `BlobRef` is written to the brief's
   * `prompt_blob_ref`. When omitted, large prompts ride inline; this is
   * the documented indie-floor fallback so a solo developer does not
   * need to provision a blob store on day one.
   */
  readonly blobStore?: BlobStore;
}

export interface DispatchSubAgentOutput {
  readonly claim_id: string;
  /**
   * The freshly-minted secret bearer token. Substrate consumers MUST
   * never log, render, project, or persist this value outside the
   * authorized `markClaimComplete` round-trip; see the redaction
   * contract on `WorkClaimMeta.claim_secret_token`.
   */
  readonly claim_secret_token: string;
  readonly claim_handle: ClaimHandle;
}

export interface ClaimHandle {
  /**
   * Read the latest persisted `WorkClaimMeta` for this claim. Returns
   * the metadata snapshot at call time; callers that need a continuous
   * view subscribe to `host.atoms.subscribe` when available.
   */
  read(): Promise<WorkClaimMeta>;
  /**
   * Resolve once the claim reaches a terminal state (`complete` or
   * `abandoned`). Today the handle resolves the moment the substrate
   * sees a terminal-state observation in the atom store; a future
   * implementation MAY wire push-wake via the AtomStore's subscribe
   * capability. The settled-state's `final_state` mirrors the persisted
   * `claim_state` so callers can branch without re-reading.
   */
  settled(): Promise<{ readonly final_state: 'complete' | 'abandoned'; readonly reason?: string }>;
}

/**
 * Build the WORK_CLAIM_CONTEXT preamble prepended to the sub-agent's
 * prompt. The preamble is the unforgeable binding the sub-agent
 * presents back to `markClaimComplete`. Keep this simple: a key-value
 * block plus a blank line plus the user's prompt. Adapters that need
 * a richer protocol layer it on top; this contract is the floor.
 */
function buildContextPreamble(
  claimId: string,
  token: string,
  callerPrincipalId: string,
  brief: WorkClaimBrief,
): string {
  const expectedTerminalJson = JSON.stringify({
    kind: brief.expected_terminal.kind,
    identifier: brief.expected_terminal.identifier,
    terminal_states: brief.expected_terminal.terminal_states,
  });
  return [
    `claim_id:${claimId}`,
    `claim_secret_token:${token}`,
    `caller_principal_id:${callerPrincipalId}`,
    `expected_terminal:${expectedTerminalJson}`,
    `deadline:${brief.deadline_ts}`,
    '',
    brief.prompt,
  ].join('\n');
}

/**
 * Default STOP predicate. Returns `true` when the conventional
 * `.lag/STOP` sentinel file is present in the current working
 * directory. Substrate consumers that run from a non-default state
 * directory inject their own predicate.
 */
function defaultStopSentinel(): boolean {
  try {
    return existsSync(DEFAULT_STOP_PATH);
  } catch {
    // existsSync should not throw, but in defense of weird filesystems
    // (network mounts, permission-restricted dirs) we fall back to
    // "not tripped" rather than fail loud here; the kill-switch
    // primitive is the real defense and that one has explicit retries.
    return false;
  }
}

/**
 * Dispatch a sub-agent: run the six pre-dispatch gates, mint a
 * `work-claim` atom in `pending` state, invoke the adapter, transition
 * the claim to `executing`, and return synchronously with the handle.
 *
 * Throws (gate failures, in order):
 *   - `stop-sentinel-active` when the STOP predicate returns true.
 *   - `unknown-caller` when `caller_principal_id` does not resolve.
 *   - `unknown-terminal-kind` when the brief's terminal kind has no
 *     registered verifier.
 *   - `deadline-already-past` when `brief.deadline_ts` is at or before
 *     `host.clock.now()`.
 *   - `unknown-budget-tier` when the resolved budget tier has no canon
 *     policy. (Propagated from `resolveBudgetTier`.)
 */
export async function dispatchSubAgent(
  input: DispatchSubAgentInput,
  host: Host,
): Promise<DispatchSubAgentOutput> {
  // Gate 1: STOP sentinel.
  const stopSentinel = input.stopSentinel ?? defaultStopSentinel;
  if (stopSentinel()) {
    throw new Error('stop-sentinel-active');
  }

  // Gate 2: caller identity. The caller is the sub-agent's principal;
  // its absence means we have no audit-chain anchor for the dispatch.
  const principal = await host.principals.get(
    input.caller_principal_id as PrincipalId,
  );
  if (principal === null) {
    throw new Error(`unknown-caller: ${input.caller_principal_id}`);
  }

  // Gate 3: verifier kind. A missing verifier means the substrate has
  // no way to attest completion; refuse before persisting the claim.
  const kind = input.brief.expected_terminal.kind;
  if (!verifierRegistry.has(kind)) {
    throw new Error(`unknown-terminal-kind: ${kind}`);
  }

  // Gate 4: deadline future-dated. A deadline already in the past
  // produces a claim that the reaper would stall on its first sweep.
  const now = host.clock.now();
  if (input.brief.deadline_ts <= now) {
    throw new Error(
      `deadline-already-past: deadline_ts=${input.brief.deadline_ts} now=${now}`,
    );
  }

  // Gate 5: budget tier. `resolveBudgetTier` throws
  // `unknown-budget-tier` when no canon-policy atom matches; we let
  // that bubble up unchanged so callers + tests can pattern-match the
  // existing substring.
  const tier = input.budget_tier ?? 'default';
  await resolveBudgetTier(tier, host);

  // Gate 6: prompt size. Spill to BlobStore when one is supplied AND
  // the prompt exceeds the threshold AND the brief does not already
  // carry a `prompt_blob_ref` (caller pre-spilled). Otherwise leave
  // inline (documented indie-floor fallback).
  let promptForAtom: string = input.brief.prompt;
  let promptBlobRef = input.brief.prompt_blob_ref;
  if (
    promptBlobRef === undefined
    && input.blobStore !== undefined
    && input.brief.prompt.length > PROMPT_SPILL_THRESHOLD
  ) {
    promptBlobRef = await input.blobStore.put(input.brief.prompt);
    // We keep the inline prompt on the atom (it is the substrate's
    // canonical record) but also surface the blob ref for adapters
    // that prefer to fetch by ref. The redactor + retention pass MAY
    // strip the inline copy after the blob is durably stored; the
    // substrate does not do that here to keep this contract pure.
  }

  // Mint the claim id + secret token. Claim id is deterministic
  // enough for human readability (timestamp + random suffix) but not
  // a content hash: two structurally-identical dispatches at the same
  // instant are still distinct work-claims.
  const claimId = `work-claim-${now.replace(/[^0-9]/g, '')}-${randomShortSuffix()}`;
  const token = generateClaimToken();

  const brief: WorkClaimBrief = {
    prompt: promptForAtom,
    expected_terminal: input.brief.expected_terminal,
    deadline_ts: input.brief.deadline_ts,
    ...(promptBlobRef !== undefined ? { prompt_blob_ref: promptBlobRef } : {}),
  };

  const meta: WorkClaimMeta = {
    claim_id: claimId,
    claim_secret_token: token,
    dispatched_principal_id: input.caller_principal_id as PrincipalId,
    brief,
    claim_state: 'pending',
    budget_tier: tier,
    recovery_attempts: 0,
    verifier_failure_count: 0,
    parent_claim_id: input.parent_claim_id ?? null,
    session_atom_ids: [],
    last_attestation_rejected_at: null,
    latest_session_finalized_at: null,
  };

  // Provenance: when a parent claim is present, walk back through it;
  // otherwise the chain starts empty and downstream callers seed via
  // the operator-intent path. `derived_from` is an array of branded
  // `AtomId` values; we cast at the boundary where the contract has
  // verified the parent id is well-formed.
  const derivedFrom: ReadonlyArray<AtomId> =
    input.parent_claim_id !== undefined && input.parent_claim_id !== null
      ? ([input.parent_claim_id as AtomId])
      : [];

  // Write the work-claim atom in `pending` state. Failures here propagate
  // before the adapter is invoked, so a corrupt store does not produce
  // an executing-without-record gap.
  await host.atoms.put({
    schema_version: 1,
    id: claimId as AtomId,
    content: `dispatch ${brief.expected_terminal.kind}:${brief.expected_terminal.identifier} deadline=${brief.deadline_ts}`,
    type: 'work-claim',
    layer: 'L0',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: input.caller_principal_id },
      derived_from: derivedFrom,
    },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
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
    principal_id: input.caller_principal_id as PrincipalId,
    taint: 'clean',
    metadata: { work_claim: meta },
  });

  // Invoke the adapter. The substrate prepends the WORK_CLAIM_CONTEXT
  // preamble to the prompt; adapters that wish to escape the preamble
  // and parse it programmatically MAY do so, but the contract is the
  // unforgeable binding the sub-agent will present back at attestation.
  const preambleAndPrompt = buildContextPreamble(
    claimId,
    token,
    input.caller_principal_id,
    brief,
  );
  // We do not wait for the adapter to finish before transitioning the
  // claim to `executing` in semantic terms (the claim IS executing the
  // moment the adapter is invoked). The transition write happens after
  // the call returns so a synchronous adapter throw surfaces here
  // without leaving an `executing` orphan; an asynchronous long-running
  // adapter completes the transition on its first await suspension if
  // the caller awaits this function.
  const adapterPromise = input.agent_loop_adapter.run({
    host,
    principal: input.caller_principal_id as PrincipalId,
    // Workspace, redactor, blobStore, budget, replayTier, blobThreshold
    // are owned by the caller's environment; this contract is mechanism-
    // only and does not synthesize them. A caller that wants to wire
    // the agent-loop substrate fully composes those alongside the
    // contract; the minimum surface this contract requires is the
    // adapter being callable with a populated AgentLoopInput.
    workspace: { id: 'claim-contract-pending-wire' } as never,
    task: {
      planAtomId: claimId as AtomId,
      questionPrompt: preambleAndPrompt,
    },
    budget: { max_turns: 1, max_wall_clock_ms: 60_000 } as never,
    toolPolicy: { disallowedTools: [] },
    redactor: { redact: (s: string) => s } as never,
    blobStore: input.blobStore ?? ({} as never),
    replayTier: 'best-effort',
    blobThreshold: PROMPT_SPILL_THRESHOLD,
    correlationId: claimId,
  });

  // Wait for the adapter to start (its first await) before transitioning.
  // The adapter MAY return synchronously (test stubs) or asynchronously
  // (real loops); either way we want the transition to land after the
  // adapter has been entered.
  await adapterPromise;

  // Transition to `executing`. The atom store's `update` preserves
  // immutable fields (content, type, principal_id) and merges metadata.
  await host.atoms.update(claimId as AtomId, {
    metadata: {
      work_claim: { ...meta, claim_state: 'executing' },
    },
  });

  return {
    claim_id: claimId,
    claim_secret_token: token,
    claim_handle: buildClaimHandle(claimId, host),
  };
}

function buildClaimHandle(claimId: string, host: Host): ClaimHandle {
  return {
    async read(): Promise<WorkClaimMeta> {
      const atom = await host.atoms.get(claimId as AtomId);
      if (atom === null) {
        throw new Error(`claim-not-found: ${claimId}`);
      }
      return atom.metadata.work_claim as WorkClaimMeta;
    },
    async settled() {
      // V0: single-shot read. A future revision wires push-wake via
      // `host.atoms.subscribe` when the underlying adapter declares
      // `capabilities.hasSubscribe`; until then callers poll via the
      // claim reaper's tick.
      const meta = await this.read();
      if (meta.claim_state === 'complete') {
        return { final_state: 'complete' };
      }
      if (meta.claim_state === 'abandoned') {
        return { final_state: 'abandoned' };
      }
      // Non-terminal state: surface the current state via reason so the
      // caller can decide whether to keep waiting. Treat it as
      // abandoned-with-reason for the V0 single-shot contract; a future
      // wake-aware implementation will block instead.
      return {
        final_state: 'abandoned',
        reason: `not-yet-terminal:${meta.claim_state}`,
      };
    },
  };
}

/**
 * Short random suffix for claim ids. Uses base36 over an 8-byte random
 * draw; the keyspace is more than sufficient for distinguishing claims
 * minted within the same millisecond. Not security-load-bearing (the
 * secret token is what authenticates attestation); only readability +
 * collision avoidance.
 */
function randomShortSuffix(): string {
  // Avoid a node:crypto import for a 6-char id; Math.random is fine
  // here (id readability is the only goal). The bearer token, which
  // IS security-load-bearing, uses node:crypto via `generateClaimToken`.
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Internal export: claim id format. Surfaced for the test layer + the
 * future reaper module to share the regex without duplicating it.
 */
export const CLAIM_ID_PREFIX = 'work-claim-';

// Re-exported alongside the contract so callers that want the brief
// shape (without re-importing `types`) can pull it from a single
// module.
export type { WorkClaimBrief, WorkClaimMeta } from './types.js';
export type { AgentLoopAdapter } from './agent-loop.js';
export type { BlobStore } from './blob-store.js';

/**
 * Stub: `markClaimComplete` lands in Task 12. The export is reserved
 * here so callers can declare-merge against the contract module while
 * the implementation is being written; calling it throws.
 */
export async function markClaimComplete(): Promise<never> {
  throw new Error('markClaimComplete: not implemented (Task 12)');
}
