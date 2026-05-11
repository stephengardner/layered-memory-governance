/**
 * Claim reaper: two-phase scan that detects stalled work-claims and
 * drains the stalled queue via a bounded recovery ladder.
 *
 * Why this exists
 * ---------------
 * `dispatchSubAgent` mints a work-claim atom and hands the sub-agent the
 * unforgeable contract surface. From there, three things may happen:
 *
 *   1. The sub-agent reaches its expected terminal state and calls
 *      `markClaimComplete`. The contract module flips the claim to
 *      `complete` and we are done.
 *   2. The sub-agent runs out of budget, the adapter crashes, the host
 *      reboots, the prompt becomes stale, or the verifier ping-pongs.
 *      Nothing closes the claim.
 *   3. The sub-agent is still working but slow.
 *
 * Without a reaper, cases 2 and 3 are indistinguishable from each other
 * AND from a perfectly healthy long-running claim. The reaper is the
 * substrate's "is this thing alive" pass; it flips clearly-dead claims
 * to `stalled` (Phase A) and then drives stalled claims through a
 * bounded recovery ladder (Phase B) until either they recover or the
 * cap escalates them to the operator.
 *
 * Two-phase shape
 * ---------------
 * Phase A is read-mostly: it queries open claims (state in
 * `{pending, executing, attesting}`), evaluates the five stall
 * predicates in spec Section 7, and writes a `claim-stalled` audit atom
 * plus an atomic state transition for each. No adapter dispatch. The
 * phase holds no locks across an external call -- every stall
 * transition is a single AtomStore put-then-update.
 *
 * Phase B drains the stalled queue: it queries `state='stalled'` claims,
 * checks the recovery cap, and either escalates (write
 * `claim-escalated` + telegraph `claim-stuck` Event + flip to
 * `abandoned`) or applies the atomic recovery-step (increment
 * `recovery_attempts`, bump `budget_tier` per the ladder, rotate
 * `claim_secret_token`, extend `deadline_ts`, reset
 * `verifier_failure_count` to 0, flip to `executing`). The adapter
 * dispatch happens AFTER the put so we never hold a claim-lock across
 * an external call.
 *
 * Substrate posture
 * -----------------
 * The reaper is mechanism-only. The five stall predicates read canon-
 * policy atoms (cadence + grace windows + verifier-failure cap) via
 * the `resolveX` readers in `claim-reaper-config`; the recovery cap +
 * deadline extension flow through the same readers. The budget tier
 * ladder is a hardcoded mapping `default -> raised -> max -> max`,
 * mirroring spec Section 9; an org-ceiling deployment that seeds a
 * `pol-claim-budget-tier-emergency` atom can extend the tier set
 * without touching this file (the new tier is registered via canon;
 * the ladder reads existing tier names off the claim and bumps within
 * the substrate-known sequence).
 *
 * Concurrency model
 * -----------------
 * The memory atom-store does not enforce optimistic version checks
 * out-of-the-box, so the reaper protects against concurrent ticks by
 * re-reading the claim immediately before each state-changing put and
 * skipping when the claim has already moved out of the state we
 * intended to transition from. The reaper invariant is: at most one
 * reaper instance per claim per state transition. A second reaper
 * sees the post-transition state on its re-read and skips cleanly.
 *
 * Threat model
 * ------------
 * - STOP at the tick entry: the orchestrator refuses to scan when the
 *   STOP predicate fires. In-flight recovery dispatches finish their
 *   atom writes; no NEW dispatches occur while STOP is engaged.
 * - Token rotation on recovery: the recovery-step put rotates the
 *   `claim_secret_token`. A zombie sub-agent from the prior attempt
 *   holds the pre-rotation token and fails its attest with
 *   `token-mismatch`. The fresh sub-agent receives the new token via
 *   the recovery brief preamble.
 * - Deadline extension: the recovery-step put extends `deadline_ts` so
 *   the next Phase A sweep does not immediately re-stall the freshly
 *   recovered claim on the "now > deadline" predicate.
 */

import type { Host } from '../../substrate/interface.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../substrate/agent-loop.js';
import { rotateClaimToken } from '../../substrate/claim-token.js';
import {
  resolveAttestingGraceMs,
  resolvePendingGraceMs,
  resolveRecoveryDeadlineExtensionMs,
  resolveRecoveryMaxAttempts,
  resolveSessionPostFinalizeGraceMs,
  resolveVerifierFailureCap,
} from '../../substrate/policy/claim-reaper-config.js';
import type {
  Atom,
  AtomId,
  ClaimEscalatedMeta,
  ClaimStalledMeta,
  Event,
  PrincipalId,
  Time,
  WorkClaimMeta,
} from '../../substrate/types.js';

// Page size for the reaper's claim queries. Mirrors the existing plan-
// reaper page size; the reaper is a sweep so we want full coverage.
const PAGE_SIZE = 500;

// Hard cap on pagination iterations to defend against an unbounded atom
// store. A truncated sweep is preferable to a hung tick; the next tick
// continues from the start.
const PAGE_LIMIT = 200;

// Recovery brief inline size cap (16 KiB). When the composed brief
// exceeds this we truncate the diff section; spilling to BlobStore is
// reserved for the resume-strategy seam (PR6) and is out of scope here.
const RECOVERY_BRIEF_INLINE_CAP = 16_384;

// Path for the default STOP sentinel file. Tests inject a predicate
// rather than depending on a real `.lag/STOP`; same convention as
// `dispatchSubAgent` in the contract module.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const DEFAULT_STOP_PATH = resolve('.lag', 'STOP');

function defaultStopSentinel(): boolean {
  try {
    return existsSync(DEFAULT_STOP_PATH);
  } catch {
    return false;
  }
}

/**
 * Build the recovery brief that the substrate prepends to the sub-
 * agent's next prompt. The brief carries the NEW token via a
 * `RECOVERY UPDATE` preamble so a resumed sub-agent discards the prior
 * token from its replayed context before attesting.
 *
 * `recoveryAttempts` is the post-increment value (i.e. 1 on the first
 * recovery).
 */
function buildRecoveryBrief(
  meta: WorkClaimMeta,
  newToken: string,
  newDeadline: Time,
  recoveryAttempts: number,
  maxAttempts: number,
): string {
  const lines: string[] = [
    'RECOVERY UPDATE (substrate-enforced, do not paraphrase)',
    `claim_id: ${meta.claim_id}`,
    `recovery_attempts: ${recoveryAttempts} of ${maxAttempts}`,
    `NEW claim_secret_token: ${newToken}`,
    `NEW deadline: ${newDeadline}`,
    `NEW budget_tier: ${meta.budget_tier}`,
    'DISCARD the token from your prior context; use the NEW token in your',
    'next markClaimComplete call.',
    '',
    'ORIGINAL BRIEF:',
    meta.brief.prompt,
  ];
  let out = lines.join('\n');
  if (out.length > RECOVERY_BRIEF_INLINE_CAP) {
    out = out.slice(0, RECOVERY_BRIEF_INLINE_CAP - 64)
      + `\n[truncated; original brief continues for ${out.length - RECOVERY_BRIEF_INLINE_CAP} bytes]`;
  }
  return out;
}

/**
 * Optional injection points for the reaper's tick. Tests inject
 * predicates + adapter builders to drive deterministic recovery paths;
 * production callers (LoopRunner in PR2) inject the real STOP sentinel,
 * the principal-specific adapter factory, and the resume adapter.
 */
export interface RunClaimReaperTickOptions {
  /** Predicate consulted at tick entry. Default checks `.lag/STOP`. */
  readonly stopSentinel?: () => boolean;
  /**
   * Factory invoked to obtain a fresh-spawn agent-loop adapter. The
   * reaper invokes this once per recovery dispatch; if omitted, no
   * fresh-spawn adapter is available and the recovery becomes a state-
   * mutation-only step (atomic put without an adapter call). Tests
   * use this seam to inject a recording stub.
   */
  readonly buildAdapter?: () => AgentLoopAdapter;
  /**
   * Optional resume-aware adapter (PR6 `ResumeAuthorAgentLoopAdapter`)
   * consulted on first-recovery paths when the claim has a prior
   * session atom. Reaper takes the resume path only when this is
   * supplied AND `recovery_attempts === 1` (post-increment) AND
   * `session_atom_ids.length > 0`.
   */
  readonly resumeAdapter?: AgentLoopAdapter;
}

export interface RunClaimReaperTickResult {
  /** True when the tick exited at the STOP gate. */
  readonly halted?: boolean;
  /** Human-readable reason set when `halted === true`. */
  readonly reason?: string;
  /** Number of claims transitioned to `stalled` in Phase A. */
  readonly detected: number;
  /** Number of claims transitioned to `executing` in Phase B. */
  readonly recovered: number;
  /** Number of claims transitioned to `abandoned` in Phase B. */
  readonly escalated: number;
}

/**
 * Orchestrator. STOP-gated; both phases run on every non-halted tick.
 *
 * - Phase A flips clearly-dead claims to `stalled` and writes audit
 *   atoms.
 * - Phase B drains the stalled queue: cap-exceeded claims escalate +
 *   abandon; under-cap claims recover via the atomic recovery-step +
 *   dispatch.
 */
export async function runClaimReaperTick(
  host: Host,
  options?: RunClaimReaperTickOptions,
): Promise<RunClaimReaperTickResult> {
  const stop = options?.stopSentinel ?? defaultStopSentinel;
  if (stop()) {
    return {
      halted: true,
      reason: 'stop-sentinel-active',
      detected: 0,
      recovered: 0,
      escalated: 0,
    };
  }
  const detected = await detectStalledClaims(host);
  const drain = await drainStalledQueue(host, options);
  return {
    detected: detected.length,
    recovered: drain.recovered,
    escalated: drain.escalated,
  };
}

// ---------------------------------------------------------------------------
// Phase A: detection
// ---------------------------------------------------------------------------

/**
 * Walk all open work-claim atoms (state in `pending | executing |
 * attesting`), evaluate the five stall predicates from spec Section 7,
 * and atomically flip each stalled claim to `stalled` while writing a
 * `claim-stalled` audit atom carrying the snapshot of recovery_attempts
 * + verifier_failure_count.
 *
 * Returns the list of claim atoms that were transitioned in this pass.
 * Idempotent: a claim already in a terminal state (or already stalled)
 * is skipped.
 *
 * Stall predicates (any one fires):
 *   1. `now > parseISO(claim.brief.deadline_ts)` for any open state.
 *   2. `claim_state === 'pending'` AND
 *      `(now - claim.created_at) > pol-claim-pending-grace-ms`.
 *   3. `claim_state === 'executing'` AND every session in
 *      `claim.session_atom_ids` is finalized AND
 *      `(now - claim.latest_session_finalized_at) >
 *       pol-claim-session-post-finalize-grace-ms`. Debounce: if
 *      `latest_session_finalized_at` is null, NOT stalled.
 *   4. `claim_state === 'attesting'` AND
 *      `last_attestation_rejected_at !== null` AND
 *      `(now - last_attestation_rejected_at) > pol-claim-attesting-grace-ms`.
 *   5. `claim_state === 'attesting'` AND
 *      `verifier_failure_count >= pol-claim-verifier-failure-cap`.
 */
export async function detectStalledClaims(host: Host): Promise<ReadonlyArray<Atom>> {
  const nowIso = host.clock.now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    // Host clock returned a non-parseable value; surface loudly rather
    // than silently treating every claim as fresh. Mirrors the existing
    // plan-reaper guard.
    throw new Error(`claim-reaper: host.clock.now() returned non-parseable value: ${nowIso}`);
  }

  // Read all five grace policies up front. Each reader throws
  // `missing-canon-policy` when the policy atom is absent; we want that
  // to surface (the deployment is misconfigured) rather than silently
  // default.
  const [pendingGrace, sessionGrace, attestingGrace, verifierCap] = await Promise.all([
    resolvePendingGraceMs(host),
    resolveSessionPostFinalizeGraceMs(host),
    resolveAttestingGraceMs(host),
    resolveVerifierFailureCap(host),
  ]);

  const openClaims: Atom[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    const page = await host.atoms.query({ type: ['work-claim'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      const meta = atom.metadata.work_claim as WorkClaimMeta | undefined;
      if (meta === undefined) continue;
      const state = meta.claim_state;
      if (state !== 'pending' && state !== 'executing' && state !== 'attesting') continue;
      openClaims.push(atom);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  const stalled: Atom[] = [];
  for (const atom of openClaims) {
    const meta = atom.metadata.work_claim as WorkClaimMeta;
    let reason = evaluateStallPredicates(atom, meta, nowMs, {
      pendingGrace,
      sessionGrace,
      attestingGrace,
      verifierCap,
    });
    // Predicate #3 (executing-session-finalized-stale) needs to verify
    // that EVERY tracked session in `claim.session_atom_ids` has actually
    // finalized -- not just that the latest one did. If any tracked
    // session is still in-flight, we cannot stall the claim yet;
    // demote the reason to null and skip.
    if (reason === 'executing-session-finalized-stale') {
      const allFinalized = await areAllTrackedSessionsTerminal(host, meta);
      if (!allFinalized) {
        reason = null;
      }
    }
    if (reason === null) continue;
    // Re-read at flip time to avoid a race with the contract module
    // (e.g. a markClaimComplete that landed between the scan and the
    // flip). If the state moved on, skip.
    const fresh = await host.atoms.get(atom.id);
    if (fresh === null) continue;
    const freshMeta = fresh.metadata.work_claim as WorkClaimMeta | undefined;
    if (freshMeta === undefined) continue;
    if (
      freshMeta.claim_state !== 'pending'
      && freshMeta.claim_state !== 'executing'
      && freshMeta.claim_state !== 'attesting'
    ) {
      continue;
    }
    await writeStalledAtom(host, freshMeta, reason);
    await host.atoms.update(atom.id, {
      metadata: {
        work_claim: { ...freshMeta, claim_state: 'stalled' },
      },
    });
    stalled.push(fresh);
  }
  return stalled;
}

/**
 * Return true iff every session atom listed in `meta.session_atom_ids`
 * carries a non-null `terminal_state` (i.e. the session has finalized).
 * Used to guard predicate #3 so a claim with an in-flight session is
 * never stalled even when `latest_session_finalized_at` is past the
 * grace window (that field reflects ONE session's finalization, not
 * the whole set's).
 *
 * Missing-atom defensiveness: when a session_atom_id resolves to no
 * atom, we treat it as terminal (the atom was reaped or never written;
 * either way the substrate cannot wait on a session it cannot observe).
 * Atoms without an `agent_session` metadata block fall through the
 * same path.
 */
async function areAllTrackedSessionsTerminal(
  host: Host,
  meta: WorkClaimMeta,
): Promise<boolean> {
  if (meta.session_atom_ids.length === 0) return true;
  for (const sessionId of meta.session_atom_ids) {
    const atom = await host.atoms.get(sessionId as AtomId);
    if (atom === null) continue; // missing atom -> treat as terminal
    const sessionMeta = atom.metadata.agent_session as
      | { terminal_state?: string | null }
      | undefined;
    if (sessionMeta === undefined) continue;
    // Spec contract: `terminal_state` is set iff the session finalized.
    // An absent / null value means in-flight.
    if (sessionMeta.terminal_state === undefined || sessionMeta.terminal_state === null) {
      return false;
    }
  }
  return true;
}

interface StallPolicies {
  readonly pendingGrace: number;
  readonly sessionGrace: number;
  readonly attestingGrace: number;
  readonly verifierCap: number;
}

/**
 * Evaluate the five predicates against a claim's metadata. Returns the
 * first triggered reason, or null when the claim is healthy. The order
 * mirrors spec Section 7; deadline-passed is checked first because it
 * is the cheapest predicate and fires across all open states.
 */
function evaluateStallPredicates(
  atom: Atom,
  meta: WorkClaimMeta,
  nowMs: number,
  policies: StallPolicies,
): string | null {
  // 1. Deadline passed.
  const deadlineMs = Date.parse(meta.brief.deadline_ts);
  if (Number.isFinite(deadlineMs) && nowMs > deadlineMs) {
    return 'deadline-passed';
  }
  // 2. Pending grace.
  if (meta.claim_state === 'pending') {
    const createdMs = Date.parse(atom.created_at);
    if (Number.isFinite(createdMs) && nowMs - createdMs > policies.pendingGrace) {
      return 'pending-grace-exceeded';
    }
  }
  // 3. Executing session-finalized debounce.
  if (meta.claim_state === 'executing' && meta.latest_session_finalized_at !== null) {
    const finalizedMs = Date.parse(meta.latest_session_finalized_at);
    if (Number.isFinite(finalizedMs) && nowMs - finalizedMs > policies.sessionGrace) {
      return 'executing-session-finalized-stale';
    }
  }
  // 4. Attesting grace clock.
  if (meta.claim_state === 'attesting' && meta.last_attestation_rejected_at !== null) {
    const rejectedMs = Date.parse(meta.last_attestation_rejected_at);
    if (Number.isFinite(rejectedMs) && nowMs - rejectedMs > policies.attestingGrace) {
      return 'attesting-grace-exceeded';
    }
  }
  // 5. Verifier failure cap.
  if (meta.claim_state === 'attesting' && meta.verifier_failure_count >= policies.verifierCap) {
    return 'verifier-failure-cap-exceeded';
  }
  return null;
}

/**
 * Write a `claim-stalled` atom snapshotting the recovery counters at
 * the moment of stall. Provenance chains back to the work-claim atom
 * so the audit feed shows the lifecycle as a connected chain.
 */
async function writeStalledAtom(
  host: Host,
  meta: WorkClaimMeta,
  reason: string,
): Promise<void> {
  const now = host.clock.now();
  const stallMeta: ClaimStalledMeta = {
    claim_id: meta.claim_id,
    reason,
    recovery_attempts_at_stall: meta.recovery_attempts,
    verifier_failure_count_at_stall: meta.verifier_failure_count,
  };
  await host.atoms.put({
    schema_version: 1,
    id: `claim-stalled-${meta.claim_id}-${now.replace(/[^0-9]/g, '')}-${randomShortSuffix()}` as AtomId,
    content: `stalled ${meta.claim_id} ${reason}`,
    type: 'claim-stalled',
    layer: 'L0',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'claim-reaper' },
      derived_from: [meta.claim_id as AtomId],
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
    principal_id: meta.dispatched_principal_id,
    taint: 'clean',
    metadata: { claim_stall: stallMeta },
  });
}

// ---------------------------------------------------------------------------
// Phase B: recovery / escalation
// ---------------------------------------------------------------------------

export interface DrainStalledQueueResult {
  readonly recovered: number;
  readonly escalated: number;
}

/**
 * Phase B: scan the stalled queue and recover-or-escalate each claim.
 * Decoupled from Phase A so an adapter dispatch on a slow recovery does
 * not block Phase A's full scan on other claims.
 *
 * Returns the counts so the orchestrator can aggregate per-tick stats.
 */
export async function drainStalledQueue(
  host: Host,
  options?: RunClaimReaperTickOptions,
): Promise<DrainStalledQueueResult> {
  const stopped: ReadonlyArray<Atom> = await loadStalledClaims(host);
  let recovered = 0;
  let escalated = 0;
  for (const atom of stopped) {
    const outcome = await recoverStalledClaim(atom, host, options);
    if (outcome === 'recovered') recovered++;
    else if (outcome === 'escalated') escalated++;
    // 'skipped' counts as neither; another reaper handled it OR the
    // state moved on between scan and act.
  }
  return { recovered, escalated };
}

async function loadStalledClaims(host: Host): Promise<ReadonlyArray<Atom>> {
  const collected: Atom[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    const page = await host.atoms.query({ type: ['work-claim'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      const meta = atom.metadata.work_claim as WorkClaimMeta | undefined;
      if (meta === undefined) continue;
      if (meta.claim_state !== 'stalled') continue;
      collected.push(atom);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return collected;
}

/**
 * Drive one stalled claim through the recovery decision tree:
 *
 *   1. Cap check: `recovery_attempts >= pol-claim-recovery-max-attempts`?
 *      Escalate: write `claim-escalated` atom, telegraph `claim-stuck`
 *      Event, flip to `abandoned`. Return `'escalated'`.
 *
 *   2. Atomic recovery-step: increment `recovery_attempts`, bump
 *      `budget_tier`, rotate token, extend deadline, reset
 *      `verifier_failure_count`, flip to `executing`. ALL in one
 *      logical step (memory store has no version field; we re-read the
 *      state before the put and skip if another reaper already moved
 *      the claim).
 *
 *   3. Dispatch (AFTER the put):
 *      - No session ids: fresh respawn via `buildAdapter`.
 *      - First recovery (recovery_attempts === 1 post-increment) AND
 *        session exists AND resumeAdapter supplied: resume path.
 *      - Otherwise: fresh respawn.
 *      In all cases the recovery brief carries the NEW token in a
 *      RECOVERY UPDATE preamble.
 *
 *   4. Session append: when the dispatch returns a new sessionAtomId,
 *      append it to `claim.session_atom_ids` via another atomic update.
 *
 * Returns the outcome so `drainStalledQueue` can aggregate counts.
 */
export async function recoverStalledClaim(
  atom: Atom,
  host: Host,
  options?: RunClaimReaperTickOptions,
): Promise<'recovered' | 'escalated' | 'skipped'> {
  const meta0 = atom.metadata.work_claim as WorkClaimMeta | undefined;
  if (meta0 === undefined) return 'skipped';
  if (meta0.claim_state !== 'stalled') return 'skipped';

  const maxAttempts = await resolveRecoveryMaxAttempts(host);
  const deadlineExtMs = await resolveRecoveryDeadlineExtensionMs(host);

  // -- Cap check -----------------------------------------------------------
  if (meta0.recovery_attempts >= maxAttempts) {
    return escalateStalledClaim(atom, host, meta0);
  }

  // -- Atomic recovery-step ------------------------------------------------
  // Re-read immediately before the put so a concurrent reaper does not
  // produce two recovery-step transitions on the same claim. The memory
  // adapter does not enforce optimistic version checks; this read-then-
  // put pattern is the substrate's stand-in until the host gains one.
  const fresh = await host.atoms.get(atom.id);
  if (fresh === null) return 'skipped';
  const meta = fresh.metadata.work_claim as WorkClaimMeta | undefined;
  if (meta === undefined) return 'skipped';
  if (meta.claim_state !== 'stalled') return 'skipped';

  const newAttempts = meta.recovery_attempts + 1;
  const newToken = rotateClaimToken();
  const newDeadline = computeExtendedDeadline(host.clock.now(), meta.brief.deadline_ts, deadlineExtMs);
  const newTier = bumpBudgetTier(meta.budget_tier);

  const recovered: WorkClaimMeta = {
    ...meta,
    claim_state: 'executing',
    claim_secret_token: newToken,
    recovery_attempts: newAttempts,
    budget_tier: newTier,
    verifier_failure_count: 0,
    last_attestation_rejected_at: null,
    brief: {
      ...meta.brief,
      deadline_ts: newDeadline,
    },
  };
  await host.atoms.update(atom.id, {
    metadata: { work_claim: recovered },
  });

  // Compare-and-swap verification. The memory atom store does not
  // enforce optimistic version checks; it merges metadata blindly. To
  // simulate the spec's "if the put fails version check, skip" rule we
  // re-read the atom and confirm OUR token is the one persisted. If a
  // concurrent reaper also wrote a recovery-step in the same tick, the
  // last writer's token wins and the earlier reaper sees its token
  // overwritten -- it then knows it lost the race and bails out before
  // dispatching the adapter (which would otherwise double-dispatch).
  // The CAS check uses the rotated token because it is the only value
  // guaranteed unique per reaper invocation; `recovery_attempts` could
  // match by coincidence across reapers.
  const reread = await host.atoms.get(atom.id);
  const rereadMeta = reread === null
    ? null
    : (reread.metadata.work_claim as WorkClaimMeta | undefined) ?? null;
  if (rereadMeta === null || rereadMeta.claim_secret_token !== newToken) {
    // Lost the race; another reaper's recovery-step landed after ours
    // and wrote a different token. Skip dispatch.
    return 'skipped';
  }

  // -- Dispatch AFTER the put ----------------------------------------------
  // Fire-and-forget dispatch; adapter errors are caught so they do not
  // surface to drainStalledQueue's loop. The recovery transition is
  // already durably written; an adapter throw leaves the claim in
  // 'executing' until the next Phase A sweep evaluates it again.
  //
  // STOP recheck: the recovery-step write may have landed before the
  // STOP sentinel tripped, but the adapter dispatch is a fresh
  // side-effect we should not introduce after the kill-switch fires.
  // The claim is durably in 'executing' with the new token; the next
  // tick (post-STOP-clear) will re-evaluate it via Phase A and
  // dispatch the recovery adapter if still needed. Skip dispatch
  // here and return 'recovered' so the orchestrator's tick stats
  // reflect that the transition landed even though no adapter ran.
  const stopCheck = options?.stopSentinel ?? defaultStopSentinel;
  if (stopCheck()) {
    return 'recovered';
  }
  let newSessionId: AtomId | null = null;
  try {
    newSessionId = await dispatchRecovery({
      host,
      meta: recovered,
      newToken,
      newDeadline,
      maxAttempts,
      buildAdapter: options?.buildAdapter,
      resumeAdapter: options?.resumeAdapter,
    });
  } catch {
    // Adapter throw is non-fatal. The claim is in 'executing' state and
    // will be evaluated again on the next Phase A tick. A persistent
    // adapter failure path drives the claim back to 'stalled' via the
    // session-finalize debounce or attesting grace, NOT via this loop.
  }

  // -- Session append -------------------------------------------------------
  if (newSessionId !== null) {
    const after = await host.atoms.get(atom.id);
    if (after !== null) {
      const afterMeta = after.metadata.work_claim as WorkClaimMeta | undefined;
      if (afterMeta !== undefined) {
        const sessionIds = [...afterMeta.session_atom_ids, newSessionId];
        await host.atoms.update(atom.id, {
          metadata: {
            work_claim: { ...afterMeta, session_atom_ids: sessionIds },
          },
        });
      }
    }
  }

  return 'recovered';
}

/**
 * Compute the extended deadline. Per spec, the new deadline is
 * `max(claim.brief.deadline_ts, now + extension_ms)`. This guarantees
 * the recovered claim has at least `extension_ms` of headroom from
 * "now", regardless of whether the original deadline was in the past.
 */
function computeExtendedDeadline(now: Time, currentDeadline: Time, extensionMs: number): Time {
  const nowMs = Date.parse(now);
  const currentMs = Date.parse(currentDeadline);
  const nowExtMs = nowMs + extensionMs;
  const chosen = Number.isFinite(currentMs) && currentMs > nowExtMs ? currentMs : nowExtMs;
  return new Date(chosen).toISOString() as Time;
}

/**
 * Bump the budget tier per the substrate ladder. Reads the current
 * tier off the claim and returns the next tier in the canonical
 * sequence. The ladder saturates at `max` so an org-ceiling deployment
 * that wants a different ceiling adds a new tier (e.g. `emergency`)
 * via canon and adjusts the ladder mapping; in this PR the indie-floor
 * sequence is the canonical one.
 *
 * Unknown tiers (custom canon-added tiers) saturate at `max` too --
 * the reaper does not invent new tier names.
 */
function bumpBudgetTier(current: string): string {
  if (current === 'default') return 'raised';
  if (current === 'raised') return 'max';
  // max + any custom tier saturates at max.
  return 'max';
}

/**
 * Escalation path: cap exceeded. Writes the audit + escalation atoms,
 * telegraphs a `claim-stuck` Event, and flips the claim to `abandoned`.
 */
async function escalateStalledClaim(
  atom: Atom,
  host: Host,
  meta: WorkClaimMeta,
): Promise<'escalated' | 'skipped'> {
  // Re-read to guard against a concurrent reaper that already moved
  // this claim to `abandoned`.
  const fresh = await host.atoms.get(atom.id);
  if (fresh === null) return 'skipped';
  const freshMeta = fresh.metadata.work_claim as WorkClaimMeta | undefined;
  if (freshMeta === undefined) return 'skipped';
  if (freshMeta.claim_state !== 'stalled') return 'skipped';

  const now = host.clock.now();
  const escalation: ClaimEscalatedMeta = {
    claim_id: freshMeta.claim_id,
    failure_reasons: ['recovery-attempts-exceeded-cap'],
    session_atom_ids: freshMeta.session_atom_ids,
  };
  await host.atoms.put({
    schema_version: 1,
    id: `claim-escalated-${freshMeta.claim_id}-${now.replace(/[^0-9]/g, '')}-${randomShortSuffix()}` as AtomId,
    content: `escalated ${freshMeta.claim_id} cap-exceeded`,
    type: 'claim-escalated',
    layer: 'L0',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'claim-reaper' },
      derived_from: [freshMeta.claim_id as AtomId],
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
    principal_id: freshMeta.dispatched_principal_id,
    taint: 'clean',
    metadata: { claim_escalation: escalation },
  });

  const event: Event = {
    kind: 'claim-stuck',
    severity: 'warn',
    summary: `claim ${freshMeta.claim_id} exhausted recovery attempts`,
    body: JSON.stringify({
      claim_id: freshMeta.claim_id,
      recovery_attempts: freshMeta.recovery_attempts,
    }),
    atom_refs: [freshMeta.claim_id as AtomId],
    principal_id: freshMeta.dispatched_principal_id,
    created_at: now,
    payload: {
      claim_id: freshMeta.claim_id,
      recovery_attempts: freshMeta.recovery_attempts,
    },
  };
  // pending = no auto-disposition; the substrate just needs the surface
  // delivery. Short timeout because the reaper does not wait on operator
  // response here; the escalation atom is already written.
  await host.notifier.telegraph(event, null, 'pending', 0);

  await host.atoms.update(atom.id, {
    metadata: {
      work_claim: { ...freshMeta, claim_state: 'abandoned' },
    },
  });
  return 'escalated';
}

interface DispatchRecoveryInput {
  readonly host: Host;
  readonly meta: WorkClaimMeta;
  readonly newToken: string;
  readonly newDeadline: Time;
  readonly maxAttempts: number;
  readonly buildAdapter: (() => AgentLoopAdapter) | undefined;
  readonly resumeAdapter: AgentLoopAdapter | undefined;
}

/**
 * Choose the dispatch path based on the recovery-attempt index and the
 * presence of prior sessions, then invoke the adapter with the recovery
 * brief carrying the NEW token via the RECOVERY UPDATE preamble.
 *
 * Returns the new session atom id surfaced by the adapter result so
 * the caller can append it to `claim.session_atom_ids`. Returns null
 * when no dispatch happened (no adapter supplied, or all dispatch
 * paths declined).
 */
async function dispatchRecovery(input: DispatchRecoveryInput): Promise<AtomId | null> {
  const recoveryBrief = buildRecoveryBrief(
    input.meta,
    input.newToken,
    input.newDeadline,
    input.meta.recovery_attempts,
    input.maxAttempts,
  );
  const baseInput = buildAdapterInput(input.host, input.meta, recoveryBrief);

  const hasSession = input.meta.session_atom_ids.length > 0;
  const firstRecovery = input.meta.recovery_attempts === 1;

  // Resume path: first recovery AND a prior session exists AND a resume
  // adapter was supplied. The RECOVERY UPDATE preamble in the brief
  // delivers the new token to the resumed agent's next turn.
  if (firstRecovery && hasSession && input.resumeAdapter !== undefined) {
    const result = await input.resumeAdapter.run(baseInput);
    return resultToSessionId(result);
  }

  // Fresh respawn path (pending-state stall, second-or-later recovery,
  // or first recovery without a resume adapter).
  if (input.buildAdapter !== undefined) {
    const adapter = input.buildAdapter();
    const result = await adapter.run(baseInput);
    return resultToSessionId(result);
  }

  return null;
}

function resultToSessionId(result: AgentLoopResult): AtomId | null {
  return result.sessionAtomId ?? null;
}

/**
 * Build the `AgentLoopInput` we pass to the recovery dispatch. The
 * substrate is mechanism-only here -- we do not synthesize a real
 * workspace, redactor, blob store, or budget cap; the caller (PR2's
 * LoopRunner wiring + the per-principal recovery driver in PR3+)
 * composes those properly. For PR1 the inputs that matter are the
 * principal + the prompt; everything else is a stub kept structurally
 * valid so the test adapters can record what was seen.
 */
function buildAdapterInput(host: Host, meta: WorkClaimMeta, prompt: string): AgentLoopInput {
  return {
    host,
    principal: meta.dispatched_principal_id,
    workspace: { id: 'claim-reaper-recovery' } as never,
    task: {
      planAtomId: meta.claim_id as AtomId,
      questionPrompt: prompt,
    },
    budget: { max_turns: 1, max_wall_clock_ms: 60_000 } as never,
    toolPolicy: { disallowedTools: [] },
    redactor: { redact: (s: string) => s } as never,
    blobStore: ({} as never),
    replayTier: 'best-effort',
    blobThreshold: RECOVERY_BRIEF_INLINE_CAP,
    correlationId: meta.claim_id,
  };
}

/**
 * Short random suffix for atom ids so concurrent writes within the
 * same millisecond produce distinct ids. Not security-load-bearing.
 * Mirrors the pattern used by `claim-contract`.
 */
function randomShortSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
