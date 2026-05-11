/**
 * Reaper-config policy readers: 8 numeric canon policies that tune the
 * claim-contract reaper sweep (cadence, recovery cap + deadline extension,
 * pre-finalize grace windows, verifier timeout + failure cap, and the
 * post-finalize session grace).
 *
 * Each reader looks up its policy by `metadata.policy.kind` (NOT by atom id)
 * so org-ceiling deployments can register a higher-priority policy atom with
 * the same kind to override the indie-floor default. Binding to a fixed atom-
 * id pattern would foreclose that path and break the
 * dev-substrate-not-prescription contract.
 *
 * Fail-closed discipline
 * ----------------------
 * Mirrors pol-blob-threshold, pol-replay-tier, and pol-claim-budget-tier:
 *
 *   1. Missing policy        -> throw `missing-canon-policy`. A silent
 *                               default would let a misconfigured or
 *                               un-seeded deployment quietly diverge
 *                               from its declared reaper behaviour.
 *   2. Tainted atom          -> skipped (never participates in the
 *                               match set). A compromised policy must
 *                               not silently widen a grace window or
 *                               cadence.
 *   3. Superseded atom       -> skipped. Same reasoning.
 *   4. Malformed value       -> throw `invalid-canon-policy`. The value
 *                               must be a finite positive number; zero,
 *                               negative, NaN, +/-Infinity, and non-
 *                               number values are canon authoring bugs
 *                               that must fail loud.
 *
 * The readers are pure: no atom writes, no side effects beyond AtomStore
 * reads.
 *
 * Resolution under multiple matches
 * ---------------------------------
 * When more than one clean unsuperseded atom carries the same `kind`, the
 * most recently created one wins (created_at desc). This matches the
 * priority-then-recency tie-break used by checkToolPolicy and claim-budget-
 * tier, keeping substrate semantics consistent across policy readers.
 */

import type { Host } from '../interface.js';
import type { Atom, AtomId } from '../types.js';

export class ClaimReaperConfigPolicyError extends Error {
  constructor(message: string, public readonly atomId?: AtomId) {
    super(`pol-claim-reaper-config: ${message}`);
    this.name = 'ClaimReaperConfigPolicyError';
  }
}

// Defence against unbounded atom stores: cap the pagination walk at a
// large-but-finite number of L3 atoms. Matches the implicit cap used by
// checkToolPolicy and resolveBudgetTier; same pageSize loop + nextCursor
// stop semantics.
const PAGE_SIZE = 200;

/**
 * Resolve a numeric reaper-config policy by its policy kind.
 *
 * Walks all L3 atoms, finds clean unsuperseded entries whose
 * `metadata.policy.kind` matches `kind`, takes the most recently created
 * winner, and validates its `metadata.policy.value` is a finite positive
 * number.
 *
 * Exported (not just file-local) because the 8 named readers below
 * delegate to it and a follow-up reaper-config family could add a 9th
 * reader without re-implementing the resolution + validation contract.
 * Per canon `dev-code-duplication-extract-at-n-2`, the shared shape
 * lives here once.
 *
 * @param host - the LAG Host bundle. Only `host.atoms` is consulted.
 * @param kind - the policy kind string (e.g. 'claim-reaper-cadence-ms').
 * @returns the policy value as a finite positive number.
 * @throws ClaimReaperConfigPolicyError carrying `missing-canon-policy`
 *         when no matching clean unsuperseded policy atom is found.
 * @throws ClaimReaperConfigPolicyError carrying `invalid-canon-policy`
 *         when the matched policy atom carries a malformed value.
 */
export async function readNumericClaimPolicyByKind(host: Host, kind: string): Promise<number> {
  // Paginate through ALL L3 atoms. Partial pagination would mean a
  // higher-priority override sitting beyond the first page could be
  // silently missed, producing the indie-floor default when the
  // operator believed they had overridden it.
  let cursor: string | undefined = undefined;
  let best: { atom: Atom; createdAt: string } | null = null;
  while (true) {
    const page = await host.atoms.query({ layer: ['L3'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      // In-code taint + superseded guards: a compromised or superseded
      // policy atom must not participate in the match set. Do not rely
      // on AtomFilter predicates; enforcement varies across adapters.
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const policy = (atom.metadata as Record<string, unknown>)['policy'];
      if (!policy || typeof policy !== 'object') continue;
      const p = policy as Record<string, unknown>;
      if (p['kind'] !== kind) continue;
      // Most-recent-wins tie-break (mirrors checkToolPolicy + claim-budget-tier).
      if (best === null || atom.created_at > best.createdAt) {
        best = { atom, createdAt: atom.created_at };
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  if (best === null) {
    throw new ClaimReaperConfigPolicyError(`missing-canon-policy: ${kind}`);
  }
  const policy = (best.atom.metadata as Record<string, unknown>)['policy'] as Record<string, unknown>;
  const value = policy['value'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ClaimReaperConfigPolicyError(
      `invalid-canon-policy: ${kind} value must be a finite positive number, got ${String(value)}`,
      best.atom.id,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Named readers (the 8 numeric reaper-config policies).
//
// Each reader is a thin delegating wrapper around readNumericClaimPolicyByKind
// so the resolution + validation contract lives in exactly one place. Renaming
// or extending the contract therefore lands in one edit, not eight.
// ---------------------------------------------------------------------------

/** Reaper-loop sweep cadence in milliseconds. */
export async function resolveReaperCadenceMs(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-reaper-cadence-ms');
}

/** Max recovery attempts before a claim is finalized as `failed`. */
export async function resolveRecoveryMaxAttempts(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-recovery-max-attempts');
}

/** Deadline extension (ms) granted per recovery attempt. */
export async function resolveRecoveryDeadlineExtensionMs(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-recovery-deadline-extension-ms');
}

/** Grace window (ms) before reaping a claim stuck in `attesting`. */
export async function resolveAttestingGraceMs(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-attesting-grace-ms');
}

/** Grace window (ms) before reaping a claim stuck in `pending`. */
export async function resolvePendingGraceMs(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-pending-grace-ms');
}

/** Per-call timeout (ms) for a verifier handler invocation. */
export async function resolveVerifierTimeoutMs(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-verifier-timeout-ms');
}

/** Max consecutive verifier failures before the substrate trips the breaker. */
export async function resolveVerifierFailureCap(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-verifier-failure-cap');
}

/** Debounce grace (ms) before finalizing a session after its last claim closes. */
export async function resolveSessionPostFinalizeGraceMs(host: Host): Promise<number> {
  return readNumericClaimPolicyByKind(host, 'claim-session-post-finalize-grace-ms');
}
