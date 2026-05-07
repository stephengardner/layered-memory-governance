/**
 * PR-driver ledger primitives.
 *
 * A `pr-driver-claim` atom records one principal claiming
 * responsibility for driving a specific PR to merged state (or to an
 * operator-explicit close). Claims are pure-data atoms in the
 * AtomStore; the orphan-reconciler tick reads them to decide whether
 * an open PR has an active driver, and writes a release-claim when a
 * sub-agent reports terminal success/failure cleanly. The mechanism
 * does NOT depend on perfectly-cooperating sub-agents: even if a sub-
 * agent terminates without an explicit release, the reconciler
 * detects orphan-by-timeout via the claim's `expires_at` and the
 * latest agent-turn signal for the claimant.
 *
 * Substrate purity: this module is mechanism-only. It owns the atom
 * shape, the deterministic id, the in-code guards, and the read-side
 * lookup. It NEVER imports a GitHub adapter, NEVER spawns a process,
 * and NEVER parses a PR number from a string. The dispatch site
 * (e.g. `scripts/invokers/autonomous-dispatch.mjs`) calls into this
 * module to write claims; the reconciler tick (in
 * `pr-orphan-reconcile.ts`) calls in to read.
 *
 * Atom shape (carried in `metadata`):
 *   - principal_id: string  the claimant principal (e.g. 'cto-actor',
 *                            'code-author', a sub-agent id)
 *   - pr.owner / pr.repo / pr.number: structured PR ref
 *   - claimed_at: ISO timestamp of the claim
 *   - expires_at: ISO timestamp upper bound; an unreleased claim
 *                 past this time counts as orphaned even if the
 *                 claimant is technically still alive
 *   - status: 'claimed' | 'released'
 *   - driver_role: free string ('primary' | 'fix' | 'rebase' | ...)
 *                  for future extension; reconciler treats all roles
 *                  as equivalent for orphan detection
 *
 * Lifecycle:
 *   1. Dispatching agent calls `buildPrDriverClaim` and writes the
 *      atom BEFORE spawning the sub-agent.
 *   2. Sub-agent runs; on terminal success or failure the dispatcher
 *      writes a release claim via `buildReleasePrDriverClaim`,
 *      supersedes-chained back to the original.
 *   3. If the sub-agent terminates without an explicit release, the
 *      orphan-reconciler tick observes:
 *       - claim status='claimed' AND expires_at <= now -> orphan
 *       - claim status='claimed' AND no agent-turn for the claimant
 *         in the activity window -> orphan
 *
 * Idempotence:
 *   Claim ids are deterministic
 *   (`sha256(owner|repo|number|claimed_at_bucket)`) so two dispatchers
 *   racing on the same PR produce a duplicate-id error from
 *   `host.atoms.put`; the second dispatcher reads the existing claim
 *   and either accepts the prior claim or fails-loud per its own
 *   policy. The release-claim id is deterministic on the priorClaimId
 *   so a second release is a no-op.
 */

import { createHash } from 'node:crypto';

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';

/**
 * Default lifetime for a freshly-written driver-claim. Chosen to
 * cover the realistic span of a CR cycle (open + 1-3 review rounds +
 * merge) without pinning a PR forever when a sub-agent dies silently.
 * The orphan reconciler treats expired claims as orphaned; raising
 * this bound is safe but wastes one extra cadence before recovery
 * fires.
 */
export const DEFAULT_DRIVER_CLAIM_LIFETIME_MS = 12 * 60 * 60 * 1_000; // 12h

/**
 * Bucket size for collapsing concurrent `claimed_at` timestamps onto
 * the same deterministic claim id. Two dispatchers racing on the
 * same PR with timestamps milliseconds apart MUST land on the same
 * id so the duplicate-id guard in `host.atoms.put` fires and the
 * second writer short-circuits. Without bucketing, the hash inputs
 * differ by one millisecond and the writers each create a separate
 * claim atom for the same PR -- a substrate-level data corruption
 * the reconciler then has to resolve.
 *
 * 1 minute is wide enough to absorb realistic clock skew between
 * two parallel dispatchers (typically <1s) plus the time-bucket-
 * crossing edge case. Narrower buckets (1s) would still race when a
 * dispatch crosses the second boundary; wider buckets (1h) would
 * unhelpfully alias an explicit second-round claim with a stale
 * release-and-reclaim flow on the same PR. 1 minute strikes the
 * right balance.
 */
export const CLAIM_ID_BUCKET_MS = 60 * 1_000; // 1 minute

/**
 * Structured PR reference. Mirrors the shape used by
 * `pr-observation-refresh` so claim atoms and observation atoms
 * agree on the canonical PR identity (owner, repo, number) and
 * downstream consumers do not have to branch on shape.
 */
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export type PrDriverClaimStatus = 'claimed' | 'released';

/**
 * Inputs to `buildPrDriverClaim`. The dispatch site supplies the
 * structured PR ref and the claimant; the module deterministically
 * generates the atom id and computes the expiry timestamp. Optional
 * `derived_from` lets the caller chain the claim back to the
 * authorizing intent / plan atom for taint propagation; absent, the
 * claim is treated as standalone.
 */
export interface BuildPrDriverClaimArgs {
  readonly pr: PrRef;
  readonly principal_id: string;
  readonly claimed_at: Time;
  /** Override the default 12h lifetime. */
  readonly lifetime_ms?: number;
  /** Free-string driver role; reconciler treats all roles as equivalent. */
  readonly driver_role?: string;
  /** Parent atoms (intent, plan, dispatch record) for provenance chain. */
  readonly derived_from?: ReadonlyArray<AtomId>;
  /** Atom scope; defaults to 'project' to match dispatch atoms. */
  readonly scope?: 'session' | 'project' | 'user' | 'global';
}

/**
 * Build a `pr-driver-claim` atom. Caller passes to `host.atoms.put`.
 * The id is deterministic so a second dispatcher racing on the same
 * (owner, repo, number, claimed_at_bucket) produces a duplicate-id
 * conflict and the caller can short-circuit instead of writing a
 * second claim that confuses the reconciler.
 */
export function buildPrDriverClaim(args: BuildPrDriverClaimArgs): Atom {
  const claimedAtMs = Date.parse(args.claimed_at);
  if (!Number.isFinite(claimedAtMs)) {
    throw new Error(
      `buildPrDriverClaim: claimed_at must be a valid ISO timestamp; got ${args.claimed_at}`,
    );
  }
  const lifetimeMs = args.lifetime_ms ?? DEFAULT_DRIVER_CLAIM_LIFETIME_MS;
  if (!Number.isFinite(lifetimeMs) || !Number.isInteger(lifetimeMs) || lifetimeMs <= 0) {
    throw new Error(
      `buildPrDriverClaim: lifetime_ms must be a positive integer; got ${String(lifetimeMs)}`,
    );
  }
  const expiresAtIso = new Date(claimedAtMs + lifetimeMs).toISOString() as Time;
  const id = makeClaimId(args.pr, args.claimed_at) as AtomId;
  return {
    schema_version: 1,
    id,
    content: `pr-driver-claim: ${args.principal_id} -> ${args.pr.owner}/${args.pr.repo}#${args.pr.number}`,
    type: 'pr-driver-claim',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: args.principal_id, tool: 'pr-driver-ledger' },
      derived_from: args.derived_from ?? [],
    },
    confidence: 1.0,
    created_at: args.claimed_at,
    last_reinforced_at: args.claimed_at,
    expires_at: expiresAtIso,
    supersedes: [],
    superseded_by: [],
    scope: args.scope ?? 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: args.principal_id as PrincipalId,
    taint: 'clean',
    metadata: {
      principal_id: args.principal_id,
      pr: { owner: args.pr.owner, repo: args.pr.repo, number: args.pr.number },
      claimed_at: args.claimed_at,
      expires_at: expiresAtIso,
      status: 'claimed' satisfies PrDriverClaimStatus,
      ...(args.driver_role !== undefined ? { driver_role: args.driver_role } : {}),
    },
  };
}

/**
 * Inputs to `buildReleasePrDriverClaim`. The dispatch site supplies
 * the prior claim id and the release context; the module produces a
 * successor claim atom whose `supersedes` chains back to the prior.
 * The release atom carries `status='released'` so the reconciler
 * sees the prior claim as resolved.
 */
export interface BuildReleasePrDriverClaimArgs {
  readonly priorClaim: Atom;
  readonly released_at: Time;
  /**
   * Optional reason string carried on metadata for audit. The
   * reconciler does not branch on it; it is for human / forensic
   * consumers.
   */
  readonly reason?: string;
}

/**
 * Build a release atom for an existing `pr-driver-claim`. The
 * returned atom's id is deterministic on the prior claim id so a
 * second release call is a no-op (duplicate-id from `host.atoms.put`).
 * Caller MUST also write `host.atoms.update(priorClaim.id, {
 * superseded_by: [releaseAtom.id] })` so the reconciler sees the
 * prior claim as superseded; `buildReleasePrDriverClaim` returns the
 * release atom only and leaves the supersession update to the caller
 * (matching the supersedes / superseded_by symmetry the AtomStore
 * already enforces elsewhere).
 */
export function buildReleasePrDriverClaim(args: BuildReleasePrDriverClaimArgs): Atom {
  const prior = args.priorClaim;
  if (prior.type !== 'pr-driver-claim') {
    throw new Error(
      `buildReleasePrDriverClaim: prior atom must be type 'pr-driver-claim'; got '${prior.type}'`,
    );
  }
  // Symmetric with buildPrDriverClaim's claimed_at validation: a
  // malformed released_at would otherwise be persisted into
  // created_at / last_reinforced_at and propagate through the audit
  // chain as a bad atom rather than a fail-fast at the builder.
  const releasedAtMs = Date.parse(args.released_at);
  if (!Number.isFinite(releasedAtMs)) {
    throw new Error(
      `buildReleasePrDriverClaim: released_at must be a valid ISO timestamp; got ${args.released_at}`,
    );
  }
  const meta = prior.metadata as Record<string, unknown>;
  const priorPr = meta['pr'] as Record<string, unknown> | undefined;
  if (priorPr === undefined) {
    throw new Error(
      `buildReleasePrDriverClaim: prior claim ${String(prior.id)} is missing metadata.pr`,
    );
  }
  const id = makeReleaseClaimId(prior.id) as AtomId;
  return {
    schema_version: 1,
    id,
    content: `pr-driver-claim: released ${String(prior.id)}`,
    type: 'pr-driver-claim',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: String(prior.principal_id), tool: 'pr-driver-ledger' },
      derived_from: [prior.id],
    },
    confidence: 1.0,
    created_at: args.released_at,
    last_reinforced_at: args.released_at,
    expires_at: null,
    supersedes: [prior.id],
    superseded_by: [],
    scope: prior.scope,
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: prior.principal_id,
    taint: 'clean',
    metadata: {
      principal_id: meta['principal_id'],
      pr: priorPr,
      claimed_at: meta['claimed_at'],
      released_at: args.released_at,
      status: 'released' satisfies PrDriverClaimStatus,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      prior_claim_id: String(prior.id),
    },
  };
}

/**
 * In-memory shape returned by `findActiveDriverClaim`: the claim
 * atom plus a parsed view of the metadata fields the reconciler
 * needs without re-walking the metadata twice.
 */
export interface ActiveDriverClaim {
  readonly atom: Atom;
  readonly principal_id: string;
  readonly claimed_at_ms: number;
  readonly expires_at_ms: number;
}

/**
 * Find the currently-active driver claim for a PR. Walks the atom
 * store for `pr-driver-claim` atoms matching the (owner, repo,
 * number) tuple, filters out superseded / tainted / released atoms,
 * and returns the most-recent claim (by `claimed_at`) if any. Returns
 * null when no active claim exists.
 *
 * The walk is bounded by `maxScan` (default 5000) so a long-running
 * deployment with thousands of historical claims still terminates in
 * one tick. When the cap is hit and no match was found, the function
 * returns null with a `truncated: true` flag so the caller can
 * decide whether to widen the cap or accept the orphan-detection
 * cost. The return type carries `truncated` so the caller can log
 * the cap-hit without a side-channel.
 */
export interface FindActiveDriverClaimResult {
  readonly claim: ActiveDriverClaim | null;
  readonly truncated: boolean;
}

export interface FindActiveDriverClaimOptions {
  readonly maxScan?: number;
}

export async function findActiveDriverClaim(
  host: Host,
  pr: PrRef,
  options: FindActiveDriverClaimOptions = {},
): Promise<FindActiveDriverClaimResult> {
  const MAX_SCAN = options.maxScan ?? 5_000;
  const PAGE_SIZE = 500;
  let scanned = 0;
  let cursor: string | undefined;
  let best: ActiveDriverClaim | null = null;
  let truncated = false;
  do {
    const remaining = MAX_SCAN - scanned;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const page = await host.atoms.query(
      { type: ['pr-driver-claim'] },
      Math.min(PAGE_SIZE, remaining),
    cursor,
    );
    for (const atom of page.atoms) {
      scanned += 1;
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      if (meta['status'] !== 'claimed') continue;
      const candidatePr = meta['pr'] as Record<string, unknown> | undefined;
      if (candidatePr === undefined) continue;
      if (candidatePr['owner'] !== pr.owner) continue;
      if (candidatePr['repo'] !== pr.repo) continue;
      if (candidatePr['number'] !== pr.number) continue;
      const claimedAtRaw = meta['claimed_at'];
      const expiresAtRaw = meta['expires_at'];
      if (typeof claimedAtRaw !== 'string') continue;
      if (typeof expiresAtRaw !== 'string') continue;
      const claimedAtMs = Date.parse(claimedAtRaw);
      const expiresAtMs = Date.parse(expiresAtRaw);
      if (!Number.isFinite(claimedAtMs)) continue;
      if (!Number.isFinite(expiresAtMs)) continue;
      const principalRaw = meta['principal_id'];
      if (typeof principalRaw !== 'string') continue;
      // Most-recent-wins selection. Two simultaneous claimed claims
      // (deterministic id should prevent this; the guard exists
      // because nothing prevents an external writer from inserting
      // a malformed atom) resolve to the larger claimed_at_ms. Ties
      // resolve to the lex-smaller atom id for determinism.
      const candidate: ActiveDriverClaim = {
        atom,
        principal_id: principalRaw,
        claimed_at_ms: claimedAtMs,
        expires_at_ms: expiresAtMs,
      };
      if (best === null) {
        best = candidate;
      } else if (candidate.claimed_at_ms > best.claimed_at_ms) {
        best = candidate;
      } else if (
        candidate.claimed_at_ms === best.claimed_at_ms
        && String(candidate.atom.id) < String(best.atom.id)
      ) {
        best = candidate;
      }
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return { claim: best, truncated };
}

/**
 * Deterministic id for a `pr-driver-claim` atom. The `claimed_at`
 * timestamp is normalized to `CLAIM_ID_BUCKET_MS` granularity before
 * hashing so two dispatchers racing on the same PR with timestamps
 * milliseconds apart land on the same id and trip the duplicate-id
 * guard in `host.atoms.put`. After a fresh bucket boundary (default
 * 1 minute later) a second-round claim produces a different id, so
 * legitimate post-release re-claims still land cleanly. Truncated to
 * 16 hex chars to stay readable in audit output; collision
 * probability across a realistic atom store at that width is
 * negligible.
 */
export function makeClaimId(pr: PrRef, claimedAt: Time): string {
  const claimedMs = Date.parse(claimedAt);
  // Defensive: Date.parse returns NaN on malformed strings. The
  // public buildPrDriverClaim path already validates the format
  // upstream; preserving the original string under that NaN is
  // belt-and-braces for direct callers who skipped the builder.
  const bucketKey = Number.isFinite(claimedMs)
    ? String(Math.floor(claimedMs / CLAIM_ID_BUCKET_MS) * CLAIM_ID_BUCKET_MS)
    : claimedAt;
  const digest = createHash('sha256')
    .update(pr.owner)
    .update('|')
    .update(pr.repo)
    .update('|')
    .update(String(pr.number))
    .update('|')
    .update(bucketKey)
    .digest('hex')
    .slice(0, 16);
  return `pr-driver-claim-${digest}`;
}

/**
 * Deterministic id for a release-claim atom. Hashes the prior claim
 * id so a second release call on the same prior is a no-op
 * (host.atoms.put rejects the duplicate id).
 */
export function makeReleaseClaimId(priorClaimId: AtomId): string {
  const digest = createHash('sha256')
    .update('release|')
    .update(String(priorClaimId))
    .digest('hex')
    .slice(0, 16);
  return `pr-driver-claim-released-${digest}`;
}
