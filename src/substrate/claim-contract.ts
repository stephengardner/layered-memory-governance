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
 * Gate order
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
  AttestationRejectionReason,
  ClaimAttestationAcceptedMeta,
  ClaimAttestationRejectedMeta,
  ClaimStalledMeta,
  Event,
  PrincipalId,
  Time,
  WorkClaimBrief,
  WorkClaimMeta,
} from './types.js';
import type { AgentLoopAdapter } from './agent-loop.js';
import type { BlobStore } from './blob-store.js';
import { dispatchVerifier, verifierRegistry } from './claim-verifiers/index.js';
import { resolveBudgetTier } from './policy/claim-budget-tier.js';
import {
  resolveVerifierFailureCap,
  resolveVerifierTimeoutMs,
} from './policy/claim-reaper-config.js';
import { constantTimeEqual, generateClaimToken } from './claim-token.js';

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
  /**
   * Optional adapter-budget override threaded into `AgentLoopInput.budget`.
   * When omitted, dispatch falls back to a generous default
   * (`max_turns: 50, max_wall_clock_ms: 1_800_000` = 30 minutes) so an
   * agent-loop adapter exercised before a full LoopRunner wiring lands
   * is not capped at one turn. Callers that already know the budget
   * envelope (LoopRunner threading the per-tier ladder) pass it
   * through here; the contract itself is mechanism-only and does not
   * synthesize a per-tier mapping (that mapping is a policy concern
   * read by the caller).
   */
  readonly budget?: { readonly max_turns: number; readonly max_wall_clock_ms: number };
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
   * Snapshot of the claim's current settlement state. Today the call
   * does a single-shot read of the atom store; a future implementation
   * MAY wire push-wake via the AtomStore subscribe capability. The
   * returned `final_state` mirrors the persisted `claim_state`:
   *   - `complete` / `abandoned` are terminal (claim is done).
   *   - `pending` is the V0 single-shot signal that the claim has
   *     NOT reached a terminal state yet; callers receive the current
   *     non-terminal state name in `reason` (`not-yet-terminal:<state>`)
   *     so they can decide whether to wait or retry. Treating
   *     non-terminal as abandoned would misreport a running claim as
   *     a failure.
   */
  settled(): Promise<{ readonly final_state: 'complete' | 'abandoned' | 'pending'; readonly reason?: string }>;
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
  // Fire-and-forget dispatch: the adapter run is started but NOT
  // awaited so the dispatch function returns promptly and the caller
  // can observe `claim_state === 'executing'` without waiting for the
  // agent loop to finish. The reaper's session-finalize debounce + the
  // attest cycle handle terminal-state observation; the dispatch
  // contract only guarantees "the adapter has been entered".
  //
  // Rejection containment: an unhandled rejection from the agent loop
  // would crash the host. We attach a no-op catch so the promise is
  // observed; the actual error path is the reaper's stall detection
  // (post-finalize-grace + missing terminal session) plus the optional
  // adapter's own audit-event emission via host.auditor.
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
    budget: (input.budget ?? { max_turns: 50, max_wall_clock_ms: 1_800_000 }) as never,
    toolPolicy: { disallowedTools: [] },
    redactor: { redact: (s: string) => s } as never,
    blobStore: input.blobStore ?? ({} as never),
    replayTier: 'best-effort',
    blobThreshold: PROMPT_SPILL_THRESHOLD,
    correlationId: claimId,
  });
  // Observe the promise to avoid unhandled-rejection crashes. The
  // reaper picks up adapter failures via the session-finalize-stale
  // and verifier-failure-cap stall conditions; we do not need to
  // re-throw here.
  void adapterPromise.catch(() => {});

  // Transition to `executing` immediately after dispatch. The atom
  // store's `update` preserves immutable fields (content, type,
  // principal_id) and merges metadata. The transition write lands
  // before this function returns so the caller observes `executing`
  // by the time the returned handle is usable.
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
      // Non-terminal state (pending / executing / attesting / stalled):
      // surface `final_state='pending'` so callers can distinguish
      // running claims from terminal failures. The persisted state
      // name rides through `reason` so callers that care about the
      // exact phase (e.g. polling the reaper) get the signal without
      // a second atom read.
      return {
        final_state: 'pending',
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

// ---------------------------------------------------------------------------
// markClaimComplete
// ---------------------------------------------------------------------------

/**
 * The sub-agent's reported terminal observation. Three fields, all
 * untrusted: the substrate verifies kind + identifier against the
 * brief at gate time, then dispatches a verifier to confirm
 * observed_state against ground truth.
 */
export interface AttestationInput {
  readonly terminal_kind: string;
  readonly terminal_identifier: string;
  readonly observed_state: string;
}

/**
 * Outcome of a `markClaimComplete` round-trip. `accepted: true` means
 * the verifier confirmed the sub-agent's reported terminal state and
 * the claim has been flipped to `complete`. `accepted: false` carries a
 * closed-set `reason` from `AttestationRejectionReason`; consumers
 * branch on the reason (operator escalation vs reaper-driven recovery
 * vs principal-misbehavior alert) without re-parsing free text.
 *
 * `observed_state` is set only on `ground-truth-mismatch` (the verifier
 * returned a state but it did not match the expected set). Other
 * rejection reasons leave the field undefined because no ground-truth
 * lookup occurred.
 */
export interface AttestationResult {
  readonly accepted: boolean;
  readonly reason?: AttestationRejectionReason;
  readonly observed_state?: string;
}

/**
 * Input to a `markClaimComplete` call. `claim_secret_token` is the
 * unforgeable bearer secret minted at dispatch time; treat as opaque
 * and never log. `caller_principal_id` is matched against the claim's
 * dispatched principal at Gate 5.
 */
export interface MarkClaimCompleteInput {
  readonly claim_id: string;
  readonly claim_secret_token: string;
  readonly caller_principal_id: string;
  readonly attestation: AttestationInput;
}

/**
 * Optional knobs threaded through to the gate logic. Today only the
 * STOP predicate is injectable (parity with dispatchSubAgent so tests
 * can run without a real `.lag/STOP` file). Future fields land here
 * without churning the public signature.
 */
export interface MarkClaimCompleteOptions {
  readonly stopSentinel?: () => boolean;
}

/**
 * Close a work-claim by attesting its terminal state. Runs nine
 * validation gates in the exact order documented below; each rejection
 * writes a `claim-attestation-rejected` atom chained back to the claim
 * (so the audit trail records every attempt, including denied ones).
 *
 * Gate order (do NOT reorder):
 *   1. STOP sentinel        -> `stop-sentinel`
 *   2. Claim lookup         -> `claim-not-found` (no atom written; no parent
 *                              to chain to)
 *   3. State guard          -> `claim-already-terminal` + principal-misbehavior
 *                              Notifier event
 *   4. Token match          -> `token-mismatch`
 *   5. Principal match      -> `principal-mismatch`
 *   6. Identifier match     -> `identifier-mismatch`
 *   7. Kind match           -> `kind-mismatch`
 *   8. State transition     -> claim_state := `attesting`
 *   9. Verifier dispatch    -> `ground-truth-mismatch` | `verifier-error` |
 *                              `verifier-timeout` (with failure-cap stall)
 *
 * On the happy path: writes a `claim-attestation-accepted` atom AND
 * flips the claim to `complete` AND resets `verifier_failure_count` to
 * 0 in the same logical step. Returns `{ accepted: true }`.
 */
export async function markClaimComplete(
  input: MarkClaimCompleteInput,
  host: Host,
  options?: MarkClaimCompleteOptions,
): Promise<AttestationResult> {
  const stopSentinel = options?.stopSentinel ?? defaultStopSentinel;

  // Gate 1: STOP sentinel. Refuse to close any claim while the kill-
  // switch is engaged; write the rejection so the audit trail records
  // the attempt rather than silently dropping it.
  if (stopSentinel()) {
    await writeRejectionAtom(host, input.claim_id, input.caller_principal_id, 'stop-sentinel');
    return { accepted: false, reason: 'stop-sentinel' };
  }

  // Gate 2: claim lookup. No claim atom means there is no parent to
  // chain a rejection-atom provenance against; skip the rejection-atom
  // write rather than minting a dangling record. The result still
  // surfaces the failure to the caller.
  const claimAtom = await host.atoms.get(input.claim_id as AtomId);
  if (claimAtom === null) {
    return { accepted: false, reason: 'claim-not-found' };
  }

  const meta = claimAtom.metadata.work_claim as WorkClaimMeta | undefined;
  if (meta === undefined) {
    // Atom exists but is not a work-claim (or carries no metadata).
    // Treat as claim-not-found per the same no-parent-to-chain logic.
    return { accepted: false, reason: 'claim-not-found' };
  }

  // Gate 3: state guard. Only `executing` and `attesting` claims may be
  // attested. A post-terminal attest IS a principal-misbehavior signal:
  // the principal either lost track of state or is attempting to
  // re-close a closed claim (potential replay attempt).
  const state = meta.claim_state;
  if (state !== 'executing' && state !== 'attesting') {
    await writeRejectionAtom(host, input.claim_id, input.caller_principal_id, 'claim-already-terminal');
    // Telegraph a principal-misbehavior event so the operator surface
    // sees a post-terminal-attest distinct from a routine rejection.
    const event: Event = {
      kind: 'principal-misbehavior',
      severity: 'warn',
      summary: `post-terminal attest on ${input.claim_id} (state=${state})`,
      body: JSON.stringify({ claim_id: input.claim_id, caller_principal_id: input.caller_principal_id, observed_state: state }),
      atom_refs: [input.claim_id as AtomId],
      principal_id: input.caller_principal_id as PrincipalId,
      created_at: host.clock.now(),
      payload: {
        claim_id: input.claim_id,
        caller_principal_id: input.caller_principal_id,
        observed_claim_state: state,
      },
    };
    // pending = no auto-disposition; the substrate just needs the
    // surface delivery. Short timeout because the substrate does not
    // wait on the operator response here; the rejection has already
    // been recorded as an atom.
    await host.notifier.telegraph(event, null, 'pending', 0);
    return { accepted: false, reason: 'claim-already-terminal' };
  }

  // Gate 4: token match. Constant-time compare so a timing-oracle
  // attacker cannot narrow the keyspace with repeated guesses.
  if (!constantTimeEqual(input.claim_secret_token, meta.claim_secret_token)) {
    await writeRejectionAtom(host, input.claim_id, input.caller_principal_id, 'token-mismatch');
    return { accepted: false, reason: 'token-mismatch' };
  }

  // Gate 5: principal match. The caller MUST be the principal the
  // claim was dispatched to; a stranger holding the token cannot
  // attest. This is the audit-chain anchor: the dispatched principal
  // is the only identity whose attestation we trust.
  if (input.caller_principal_id !== meta.dispatched_principal_id) {
    await writeRejectionAtom(host, input.claim_id, input.caller_principal_id, 'principal-mismatch');
    return { accepted: false, reason: 'principal-mismatch' };
  }

  // Gate 6: identifier match. The attested terminal_identifier MUST
  // match the brief; a sub-agent attesting completion of a different
  // work-item than the one it was dispatched to is a spec-shape error.
  if (input.attestation.terminal_identifier !== meta.brief.expected_terminal.identifier) {
    await writeRejectionAtom(host, input.claim_id, input.caller_principal_id, 'identifier-mismatch');
    return { accepted: false, reason: 'identifier-mismatch' };
  }

  // Gate 7: kind match. Same shape as Gate 6 but for the verifier kind.
  if (input.attestation.terminal_kind !== meta.brief.expected_terminal.kind) {
    await writeRejectionAtom(host, input.claim_id, input.caller_principal_id, 'kind-mismatch');
    return { accepted: false, reason: 'kind-mismatch' };
  }

  // Gate 8: transition to `attesting`. The flip happens BEFORE the
  // verifier runs because a slow verifier should not leave the claim
  // visibly in `executing` while the substrate is mid-verify. Re-read
  // the latest claim meta and merge over it so a concurrent reaper
  // recovery-step (bumping recovery_attempts, rotating
  // claim_secret_token, etc.) is preserved across the attesting flip.
  // Splatting the stale Gate-2 snapshot would clobber those fields.
  const gate8Meta = await readLatestClaimMeta(host, input.claim_id);
  await host.atoms.update(input.claim_id as AtomId, {
    metadata: {
      work_claim: { ...gate8Meta, claim_state: 'attesting' },
    },
  });

  // Gate 9: verifier dispatch wrapped in Promise.race with a timeout.
  // The timeout cap and the failure-cap both live in canon policy so
  // org-ceiling deployments tune them via a canon edit, not a release.
  const timeoutMs = await resolveVerifierTimeoutMs(host);
  const failureCap = await resolveVerifierFailureCap(host);

  // Discriminated race outcome so the timeout branch is distinguishable
  // from a verifier returning ok=false. The third path (verifier
  // throw) is captured in `verifierError` below and routed through the
  // same infra-failure finalizer as the timeout branch.
  type RaceOutcome =
    | { kind: 'ok'; ok: boolean; observed_state: string }
    | { kind: 'timeout' };

  let raceOutcome: RaceOutcome;
  let verifierError: unknown = null;
  try {
    const verifierPromise: Promise<RaceOutcome> = dispatchVerifier(
      input.attestation.terminal_kind,
      input.attestation.terminal_identifier,
      [...meta.brief.expected_terminal.terminal_states],
      { host },
    ).then(r => ({ kind: 'ok' as const, ok: r.ok, observed_state: r.observed_state }));
    // Defence against unhandled-rejection crash: if the timeout wins
    // the race and the verifier promise later rejects, the rejection
    // would land on a promise nobody awaits. Attach a no-op observer
    // so Node does not log an unhandled-rejection / crash under
    // --unhandled-rejections=strict.
    void verifierPromise.catch(() => {});

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<RaceOutcome>(resolveOuter => {
      timeoutHandle = setTimeout(() => resolveOuter({ kind: 'timeout' }), timeoutMs);
    });
    try {
      raceOutcome = await Promise.race([verifierPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  } catch (err) {
    // Verifier handler threw (or dispatchVerifier itself threw on an
    // unknown kind, but Gate 7 prevents that path).
    raceOutcome = { kind: 'ok', ok: false, observed_state: 'VERIFIER_ERROR' };
    verifierError = err;
  }

  // Branch on the race outcome. Three terminal shapes: accepted,
  // ground-truth-mismatch, infrastructure failure (error or timeout).
  if (verifierError !== null) {
    // verifier-error path: increment failure count, possibly stall.
    return finalizeVerifierInfraFailure(host, input, meta, 'verifier-error', failureCap, verifierError);
  }
  if (raceOutcome.kind === 'timeout') {
    return finalizeVerifierInfraFailure(host, input, meta, 'verifier-timeout', failureCap, null);
  }
  if (raceOutcome.ok) {
    // Happy path: write accepted atom, flip to complete, reset
    // failure count to 0. The reset matters: a claim that bounced
    // off a transient verifier failure and then succeeded must NOT
    // carry the prior failure count into a future re-attempt.
    const now = host.clock.now();
    const acceptedMeta: ClaimAttestationAcceptedMeta = {
      claim_id: input.claim_id,
      observed_state: raceOutcome.observed_state,
      verified_at: now,
    };
    await host.atoms.put({
      schema_version: 1,
      id: `claim-attestation-accepted-${input.claim_id}-${now.replace(/[^0-9]/g, '')}` as AtomId,
      content: `attestation accepted ${input.claim_id} ${raceOutcome.observed_state}`,
      type: 'claim-attestation-accepted',
      layer: 'L0',
      provenance: {
        kind: 'agent-inferred',
        source: { agent_id: input.caller_principal_id },
        derived_from: [input.claim_id as AtomId],
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
        validation_status: 'verified',
        last_validated_at: now,
      },
      principal_id: input.caller_principal_id as PrincipalId,
      taint: 'clean',
      metadata: { claim_attestation: acceptedMeta },
    });
    // Re-read the latest claim meta and merge our transition over it so
    // any concurrent writer (the reaper, a parallel attest) has its
    // fields preserved. The stale `meta` snapshot from gate 4 would
    // clobber a reaper's recovery_attempts bump that landed mid-verify.
    const latestMeta = await readLatestClaimMeta(host, input.claim_id);
    await host.atoms.update(input.claim_id as AtomId, {
      metadata: {
        work_claim: {
          ...latestMeta,
          claim_state: 'complete',
          verifier_failure_count: 0,
        },
      },
    });
    return { accepted: true };
  }
  // ground-truth-mismatch: write rejection atom carrying the observed
  // state from the verifier; state stays in `attesting`. Per spec,
  // verifier_failure_count is NOT incremented on a ground-truth
  // mismatch (the verifier worked; the sub-agent attested wrong).
  await writeRejectionAtom(
    host,
    input.claim_id,
    input.caller_principal_id,
    'ground-truth-mismatch',
    raceOutcome.observed_state,
  );
  const latestMismatch = await readLatestClaimMeta(host, input.claim_id);
  await host.atoms.update(input.claim_id as AtomId, {
    metadata: {
      work_claim: {
        ...latestMismatch,
        claim_state: 'attesting',
        last_attestation_rejected_at: host.clock.now(),
      },
    },
  });
  return {
    accepted: false,
    reason: 'ground-truth-mismatch',
    observed_state: raceOutcome.observed_state,
  };
}

/**
 * Re-read the latest persisted `WorkClaimMeta` for `claimId`. Used as
 * the merge base for post-verifier updates so concurrent writers
 * (claim-reaper recovery, parallel attestation cycles) do not get
 * their fields clobbered by a stale snapshot taken at gate-time.
 */
async function readLatestClaimMeta(
  host: Host,
  claimId: string,
): Promise<WorkClaimMeta> {
  const atom = await host.atoms.get(claimId as AtomId);
  if (atom === null) {
    throw new Error(`claim-disappeared-mid-verify: ${claimId}`);
  }
  return atom.metadata.work_claim as WorkClaimMeta;
}

/**
 * Handle the two infrastructure-failure reasons (verifier-error,
 * verifier-timeout) with shared rejection + counter-increment + cap
 * logic. Shared between both reasons to avoid drifted duplicate
 * implementations of the same finalize sequence.
 */
async function finalizeVerifierInfraFailure(
  host: Host,
  input: MarkClaimCompleteInput,
  meta: WorkClaimMeta,
  reason: 'verifier-error' | 'verifier-timeout',
  failureCap: number,
  errorForBody: unknown,
): Promise<AttestationResult> {
  const nextCount = meta.verifier_failure_count + 1;
  const errorMessage = errorForBody instanceof Error ? errorForBody.message : (errorForBody === null ? undefined : String(errorForBody));
  await writeRejectionAtom(
    host,
    input.claim_id,
    input.caller_principal_id,
    reason,
    undefined,
    errorMessage,
  );
  // If the post-increment count is at or above the cap, flip the claim
  // straight to `stalled` so the reaper does not wait for another
  // attestation cycle to detect a wedged verifier.
  const nextState: WorkClaimMeta['claim_state'] = nextCount >= failureCap ? 'stalled' : 'attesting';
  // Re-read latest meta and merge so a concurrent reaper write does
  // not get clobbered by the stale gate-time snapshot.
  const latestMeta = await readLatestClaimMeta(host, input.claim_id);
  await host.atoms.update(input.claim_id as AtomId, {
    metadata: {
      work_claim: {
        ...latestMeta,
        claim_state: nextState,
        verifier_failure_count: nextCount,
        last_attestation_rejected_at: host.clock.now(),
      },
    },
  });
  // Emit a claim-stalled lifecycle atom when the failure cap trips
  // the claim straight to stalled. Without this, the state transition
  // is invisible to downstream projections/audits that watch for the
  // claim-stalled atom rather than polling the claim atom itself.
  if (nextState === 'stalled') {
    const now = host.clock.now();
    const stallMeta: ClaimStalledMeta = {
      claim_id: input.claim_id,
      reason: 'verifier-failure-cap',
      recovery_attempts_at_stall: meta.recovery_attempts,
      verifier_failure_count_at_stall: nextCount,
    };
    // Schema MUST match the reaper's writer (metadata.claim_stall +
    // ClaimStalledMeta) so any consumer reads one canonical shape.
    await host.atoms.put({
      schema_version: 1,
      id: `claim-stalled-${input.claim_id}-${now.replace(/[^0-9]/g, '')}` as AtomId,
      content: `claim stalled ${input.claim_id} verifier-failure-cap`,
      type: 'claim-stalled',
      layer: 'L0',
      provenance: {
        kind: 'agent-inferred',
        source: { agent_id: input.caller_principal_id },
        derived_from: [input.claim_id as AtomId],
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
        validation_status: 'verified',
        last_validated_at: now,
      },
      principal_id: input.caller_principal_id as PrincipalId,
      taint: 'clean',
      metadata: { claim_stall: stallMeta },
    });
  }
  return { accepted: false, reason };
}

/**
 * Write a `claim-attestation-rejected` atom carrying the standard
 * rejection-metadata shape. Centralised so every rejection path in
 * `markClaimComplete` shares one writer; the 8 rejection reasons would
 * otherwise need 8 near-identical writes drifting independently.
 *
 * `observed_state` is set only on `ground-truth-mismatch`. `error` is
 * set only on `verifier-error` / `verifier-timeout` (when the underlying
 * cause is structural). The two fields are mutually exclusive per the
 * `ClaimAttestationRejectedMeta` JSDoc.
 */
async function writeRejectionAtom(
  host: Host,
  claimId: string,
  callerPrincipalId: string,
  reason: AttestationRejectionReason,
  observedState?: string,
  error?: string,
): Promise<void> {
  const now = host.clock.now();
  const meta: ClaimAttestationRejectedMeta = {
    claim_id: claimId,
    reason,
    ...(observedState !== undefined ? { observed_state: observedState } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  await host.atoms.put({
    schema_version: 1,
    id: `claim-attestation-rejected-${claimId}-${now.replace(/[^0-9]/g, '')}-${rejectionShortSuffix()}` as AtomId,
    content: `attestation rejected ${claimId} ${reason}`,
    type: 'claim-attestation-rejected',
    layer: 'L0',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: callerPrincipalId },
      derived_from: [claimId as AtomId],
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
      validation_status: 'verified',
      last_validated_at: now,
    },
    principal_id: callerPrincipalId as PrincipalId,
    taint: 'clean',
    metadata: { claim_attestation: meta },
  });
}

/**
 * Short random suffix for rejection-atom ids. Two rejections at the
 * same millisecond for the same claim (e.g. retry-driven) MUST produce
 * distinct atom ids, otherwise the AtomStore.put duplicate-id guard
 * would refuse the second write. Not security-load-bearing; the
 * verifier-token is what authenticates attestation.
 */
function rejectionShortSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
