/**
 * PR-orphan reconcile tick.
 *
 * Closes the substrate gap where a sub-agent opens a PR and exits
 * without driving it to merged state, leaving the PR sitting idle
 * until an operator notices. The reconciler tick walks the set of
 * open PRs, joins each PR with the active `pr-driver-claim` atom (if
 * any), and detects orphans via three conditions:
 *
 *   1. NO active claim AND last bot/CR activity older than the
 *      threshold => orphan-by-no-claim. Catches PRs opened outside
 *      the dispatch chain (operator manual, dependabot) only when
 *      they have stalled; fresh-and-active no-claim PRs are left
 *      alone.
 *   2. Active claim WHOSE expires_at has passed => orphan-by-claim-
 *      expired. The claim itself signals the dispatcher's lifetime
 *      bound; once that bound elapses without a release, the PR is
 *      treated as orphaned regardless of claimant activity.
 *   3. Active claim WHOSE claimant has had no agent-turn atom
 *      written in the activity window AND last bot/CR activity is
 *      stale => orphan-by-claimer-inactive. Catches the canonical
 *      failure mode (sub-agent terminates mid-CR-cycle) when the
 *      dispatcher's claim is still nominally fresh.
 *
 * On orphan detection: emits a `pr-orphan-detected` atom (provenance
 * chain to the latest claim or the open-PR snapshot), then asks the
 * pluggable `dispatcher` to spawn a fresh driver sub-agent. The atom
 * id is deterministic on (owner, repo, number, cadence_bucket) so a
 * second tick within the same window observes a duplicate-id from
 * `host.atoms.put` and skips the dispatch: exactly one
 * dispatch-attempt per window per PR.
 *
 * Substrate purity: this module is mechanism-only. The open-PR
 * source and the dispatcher are pluggable seams; concrete GitHub /
 * sub-agent wiring lives in scripts/lib/. The tick takes structured
 * `OpenPrSnapshot` objects in and emits structured atoms / dispatch
 * calls out; it never parses a PR url, never spawns a process,
 * never imports a GitHub adapter.
 *
 * Per-tick fairness: `maxDispatchPerTick` bounds how many fresh
 * driver dispatches a single tick can fire so a sudden surge of
 * orphans (e.g. after a long reaper outage) does not stampede the
 * dispatcher. PRs detected past the cap are counted in the report
 * but the dispatcher is NOT called for them; they will be picked up
 * on the next cadence.
 */

import { createHash } from 'node:crypto';

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import { ConflictError } from '../../substrate/errors.js';
import { readNumericCanonPolicy } from '../loop/canon-policy-cadence.js';
import {
  findActiveDriverClaim,
  type ActiveDriverClaim,
  type PrRef,
} from './pr-driver-ledger.js';

/**
 * Default activity-window threshold for orphan detection. An open
 * PR with no active driver-claim and no driver activity inside this
 * window is treated as orphaned. The default is canon-tunable via
 * `pol-pr-orphan-reconcile-threshold-ms`; deployments at the org-
 * ceiling running 50+ concurrent sub-agents may want a tighter
 * threshold, indie deployments a relaxed one.
 */
export const DEFAULT_ORPHAN_THRESHOLD_MS = 5 * 60 * 1_000;

/**
 * Default cadence-bucket window. Atoms get a deterministic id
 * derived from (owner, repo, number, floor(now_ms / cadence_ms)) so
 * a second tick inside the same window collides on the duplicate-id
 * guard and skips. Default 5min matches the orphan threshold so a
 * stable orphan PR produces exactly one detection / dispatch per
 * cycle.
 */
export const DEFAULT_CADENCE_BUCKET_MS = 5 * 60 * 1_000;

/**
 * Default per-tick dispatch budget. An exceptional event that
 * generates many orphans (operator returns from vacation, reaper
 * restart, mass sub-agent crash) should not stampede the dispatcher.
 * 5 fits the realistic concurrent-CR-cycle ceiling for a single
 * deployment; the operator can raise via canon.
 */
export const DEFAULT_MAX_DISPATCH_PER_TICK = 5;

/**
 * Snapshot of one open PR, supplied by the deployment-side
 * `OpenPrSource` adapter. The reconciler reads the structured fields
 * directly; it never parses, never spawns, never reaches GitHub.
 */
export interface OpenPrSnapshot {
  readonly pr: PrRef;
  /**
   * ISO timestamp of the most recent driver-touch on this PR. The
   * adapter is responsible for computing the max across:
   *   - latest commit time
   *   - latest CR review submission
   *   - latest bot-authored issue/review comment
   *   - latest CI status update (advisory)
   * The reconciler treats this as the authoritative "did anyone
   * recently care about this PR" timestamp; it does NOT branch on
   * the source of the activity.
   */
  readonly last_activity_at: Time;
  /**
   * Optional snapshot of additional PR metadata for the orphan-
   * detected atom's audit trail. Adapter-defined; the reconciler
   * forwards it without reading.
   */
  readonly snapshot?: Readonly<Record<string, unknown>>;
}

/**
 * Pluggable seam: the deployment supplies the set of currently-open
 * PRs to consider. A typical implementation calls `gh pr list` (or
 * the GraphQL equivalent) authed via the deployment's bot identity.
 */
export interface OpenPrSource {
  list(): Promise<ReadonlyArray<OpenPrSnapshot>>;
}

/**
 * Pluggable seam: the deployment-side dispatcher that spawns a
 * fresh driver sub-agent for an orphaned PR. Errors from `dispatch`
 * are caught by the tick and counted as `failed_dispatches` so a
 * single transport failure does not halt the pass.
 */
export interface OrphanPrDispatcher {
  dispatch(args: {
    readonly pr: PrRef;
    readonly orphan_atom_id: AtomId;
    readonly orphan_reason: OrphanReason;
    readonly prior_claim: ActiveDriverClaim | null;
  }): Promise<void>;
}

export type OrphanReason
  = 'no-claim'
  | 'claim-expired'
  | 'claimer-inactive';

export interface PrOrphanReconcileTickOptions {
  readonly now?: () => string | Time | number;
  /**
   * Override the activity-window threshold. When omitted, the value
   * is read from canon `pol-pr-orphan-reconcile-threshold-ms` or
   * falls back to `DEFAULT_ORPHAN_THRESHOLD_MS`.
   */
  readonly thresholdMsOverride?: number;
  /**
   * Override the cadence-bucket size used to compute deterministic
   * orphan-detected atom ids. When omitted, falls back to
   * `DEFAULT_CADENCE_BUCKET_MS`. Set equal to the loop tick cadence
   * for one detection per tick per stable orphan.
   */
  readonly cadenceBucketMsOverride?: number;
  /**
   * Override per-tick dispatch budget.
   */
  readonly maxDispatchPerTickOverride?: number;
  /**
   * Principal id used to attribute orphan-detected atom writes.
   * Required; the tick does not silently default the principal so an
   * audit-time operator can always trace which principal observed
   * the orphan.
   */
  readonly principalId: string;
  /**
   * Override the activity scan for claimant agent-turn atoms.
   * Defaults to a host.atoms.query against `agent-turn` atoms
   * principal-filtered to the claimant. Tests inject this seam to
   * deterministically control the inactivity decision.
   */
  readonly claimantActivityScanner?: ClaimantActivityScanner;
}

/**
 * Pluggable inactivity scanner. Returns the latest activity
 * timestamp for the claimant principal, or null if no agent-turn
 * record was found within the lookback window. The default
 * implementation walks `agent-turn` atoms; tests override.
 */
export interface ClaimantActivityScanner {
  latestActivityAt(args: {
    readonly principal_id: string;
    readonly lookback_ms: number;
    readonly now_ms: number;
  }): Promise<number | null>;
}

export interface PrOrphanReconcileTickResult {
  /** Open PRs inspected this tick. */
  readonly scanned: number;
  /** PRs where an orphan was detected (regardless of dispatch). */
  readonly orphansDetected: number;
  /** Orphan-detected atom puts that conflicted with a prior tick's atom. */
  readonly idempotentSkips: number;
  /** Dispatch calls that succeeded this tick. */
  readonly dispatched: number;
  /** Dispatch calls that threw. */
  readonly failedDispatches: number;
  /** PRs detected as orphan but skipped because the dispatch budget was hit. */
  readonly rateLimited: number;
  /**
   * Histogram of skip reasons for non-orphan PRs (e.g. 'fresh',
   * 'claim-active', 'claim-active-and-fresh'). Useful for operator
   * dashboards distinguishing "tick saw 12 PRs and none were
   * orphans" from "tick saw 0 PRs".
   */
  readonly skipped: Record<string, number>;
}

/**
 * Read the configured orphan-detection threshold from canon. Falls
 * back to DEFAULT_ORPHAN_THRESHOLD_MS when no policy atom exists or
 * the value is malformed (non-numeric, non-finite, zero, negative).
 * Tainted or superseded canon atoms are ignored.
 *
 * Supports the `'Infinity'` sentinel for deployments that want to
 * disable orphan detection entirely (webhook-driven flows where the
 * orphan tick should never fire). Callers that pass the result
 * directly into the claimant-activity scanner MUST guard against the
 * Infinity case; see `runPrOrphanReconcileTick` for the canonical
 * clamp.
 */
export async function readPrOrphanThresholdMs(host: Host): Promise<number> {
  return readNumericCanonPolicy(host, {
    subject: 'pr-orphan-reconcile-threshold-ms',
    fieldName: 'threshold_ms',
    fallback: DEFAULT_ORPHAN_THRESHOLD_MS,
    acceptInfinitySentinel: true,
  });
}

/**
 * Default `ClaimantActivityScanner` implementation. Walks
 * `agent-turn` atoms filtered to the claimant principal and returns
 * the most recent atom's `created_at` (in ms since epoch) within the
 * lookback window, or null if none. Substrate-pure: reads from the
 * AtomStore only.
 */
export class AtomStoreClaimantActivityScanner implements ClaimantActivityScanner {
  constructor(private readonly host: Host) {}

  async latestActivityAt(args: {
    readonly principal_id: string;
    readonly lookback_ms: number;
    readonly now_ms: number;
  }): Promise<number | null> {
    const { principal_id, lookback_ms, now_ms } = args;
    const cutoffMs = now_ms - lookback_ms;
    const PAGE_SIZE = 200;
    const MAX_SCAN = 1_000;
    let scanned = 0;
    let cursor: string | undefined;
    let bestMs: number | null = null;
    do {
      const remaining = MAX_SCAN - scanned;
      if (remaining <= 0) break;
      const page = await this.host.atoms.query(
        {
          type: ['agent-turn'],
          principal_id: [principal_id as PrincipalId],
          created_after: new Date(cutoffMs).toISOString() as Time,
        },
        Math.min(PAGE_SIZE, remaining),
        cursor,
      );
      for (const atom of page.atoms) {
        scanned += 1;
        if (atom.taint !== 'clean') continue;
        if (atom.superseded_by.length > 0) continue;
        const tMs = Date.parse(atom.created_at);
        if (!Number.isFinite(tMs)) continue;
        if (bestMs === null || tMs > bestMs) bestMs = tMs;
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return bestMs;
  }
}

/**
 * Run one orphan-reconcile tick. Mechanism-only: takes structured
 * snapshots in and emits atoms / dispatch calls out. Driven by the
 * LoopRunner on every tick when the pass is enabled, OR by a CLI
 * driver for one-shot reconciliation runs.
 */
export async function runPrOrphanReconcileTick(
  host: Host,
  source: OpenPrSource,
  dispatcher: OrphanPrDispatcher,
  options: PrOrphanReconcileTickOptions,
): Promise<PrOrphanReconcileTickResult> {
  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowMs = toMs(nowFn());
  const thresholdMs
    = options.thresholdMsOverride ?? (await readPrOrphanThresholdMs(host));
  const cadenceBucketMs = options.cadenceBucketMsOverride ?? DEFAULT_CADENCE_BUCKET_MS;
  const maxDispatchPerTick
    = options.maxDispatchPerTickOverride ?? DEFAULT_MAX_DISPATCH_PER_TICK;
  const scanner: ClaimantActivityScanner
    = options.claimantActivityScanner ?? new AtomStoreClaimantActivityScanner(host);

  const openPrs = await source.list();
  let scanned = 0;
  let orphansDetected = 0;
  let idempotentSkips = 0;
  let dispatched = 0;
  let failedDispatches = 0;
  let rateLimited = 0;
  const skipped: Record<string, number> = {};
  const bump = (k: string): void => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };

  // Sentinel: a deployment that disables orphan detection (webhook-
  // driven, never-orphan) sets the canon threshold to 'Infinity'. The
  // claimant scanner cannot accept Infinity as a lookback (the default
  // `AtomStoreClaimantActivityScanner` builds `new Date(now_ms -
  // lookback_ms).toISOString()` which throws on Infinity). Short-
  // circuit here so the tick is a clean no-op rather than threading
  // the guard through every comparison: every PR is recorded as
  // 'orphan-detection-disabled' for operator visibility and the
  // dispatcher is never called.
  if (!Number.isFinite(thresholdMs)) {
    for (const _pr of openPrs) {
      scanned += 1;
      bump('orphan-detection-disabled');
    }
    return {
      scanned,
      orphansDetected,
      idempotentSkips,
      dispatched,
      failedDispatches,
      rateLimited,
      skipped,
    };
  }

  for (const pr of openPrs) {
    scanned += 1;
    const lastActivityMs = toMs(pr.last_activity_at);
    if (!Number.isFinite(lastActivityMs)) {
      bump('last-activity-malformed');
      continue;
    }
    const activityAgeMs = nowMs - lastActivityMs;

    const claimResult = await findActiveDriverClaim(host, pr.pr);
    // A truncated scan ({ claim: null, truncated: true }) means the
    // ledger could hold an active claim past the page cap; treat as
    // INCONCLUSIVE rather than no-claim so a long-tail store does
    // not get a duplicate driver dispatched while the existing
    // claim sits beyond the cursor. The next tick re-scans and can
    // resolve once the active set shrinks.
    if (claimResult.claim === null && claimResult.truncated) {
      bump('claim-scan-truncated');
      continue;
    }
    const claim = claimResult.claim;

    let reason: OrphanReason | null = null;
    if (claim === null) {
      // No active claim. Only treat as orphan when the PR has gone
      // quiet for longer than the threshold; otherwise the PR is
      // simply "newly opened, no driver registered yet".
      if (activityAgeMs >= thresholdMs) {
        reason = 'no-claim';
      } else {
        bump('no-claim-but-fresh');
        continue;
      }
    } else if (claim.expires_at_ms <= nowMs) {
      reason = 'claim-expired';
    } else {
      // Claim is nominally fresh; check if the claimant has had any
      // agent-turn atoms inside the activity window. If not, AND the
      // PR has been idle past threshold, treat as orphan-by-claimer-
      // inactive. This is the load-bearing detection for the
      // canonical failure mode (sub-agent died).
      const claimantLatestMs = await scanner.latestActivityAt({
        principal_id: claim.principal_id,
        lookback_ms: thresholdMs,
        now_ms: nowMs,
      });
      const claimantAgeMs
        = claimantLatestMs === null
          ? Number.POSITIVE_INFINITY
          : nowMs - claimantLatestMs;
      if (claimantAgeMs >= thresholdMs && activityAgeMs >= thresholdMs) {
        reason = 'claimer-inactive';
      } else {
        bump('claim-active');
        continue;
      }
    }

    // Compute deterministic id for this detection. The bucket gates
    // idempotence: a stable orphan PR produces exactly one detection
    // per cadence window.
    const cadenceBucket = Math.floor(nowMs / cadenceBucketMs);
    const orphanAtomId = makeOrphanDetectedId(pr.pr, cadenceBucket) as AtomId;
    const orphanAtom = buildOrphanDetectedAtom({
      id: orphanAtomId,
      pr: pr.pr,
      reason,
      now_iso: new Date(nowMs).toISOString() as Time,
      last_activity_at: pr.last_activity_at,
      cadence_bucket: cadenceBucket,
      prior_claim: claim,
      principal_id: options.principalId,
      snapshot: pr.snapshot,
    });
    let claimedThisTick = false;
    try {
      await host.atoms.put(orphanAtom);
      claimedThisTick = true;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      // A prior tick within the same cadence window already emitted
      // the orphan-detected atom for this PR. Skip the dispatch
      // attempt; the prior tick already fired one. Counted as
      // idempotent-skip, NOT as orphan, because we do not want to
      // double-count a single orphan event across two ticks.
      idempotentSkips += 1;
      bump('idempotent-skip');
      continue;
    }

    orphansDetected += 1;

    if (dispatched >= maxDispatchPerTick) {
      // Detected the orphan + emitted the atom, but skip the
      // dispatch budget for this tick. Next cadence window will
      // re-detect (a fresh cadence_bucket gives a fresh atom id) and
      // dispatch then. Counted as rate-limited so the operator's
      // dashboard sees the back-pressure.
      rateLimited += 1;
      bump('rate-limited');
      continue;
    }

    try {
      await dispatcher.dispatch({
        pr: pr.pr,
        orphan_atom_id: orphanAtomId,
        orphan_reason: reason,
        prior_claim: claim,
      });
      dispatched += 1;
      // Mark the orphan atom as "dispatch fired" for audit. Using
      // host.atoms.update because the atom was just successfully
      // put; metadata merge is the canonical patch shape.
      await host.atoms.update(orphanAtomId, {
        metadata: { dispatch_attempted: true, dispatched_at: new Date(nowMs).toISOString() },
      });
    } catch (err) {
      failedDispatches += 1;
      // Record the failure on the orphan atom so the next tick can
      // see "we tried last cadence and it threw" without a
      // side-channel log. Logged here too for operator visibility.
      const cause = err instanceof Error ? err.message : String(err);
      try {
        await host.atoms.update(orphanAtomId, {
          metadata: {
            dispatch_attempted: true,
            dispatch_failed: true,
            dispatch_failure_reason: cause,
          },
        });
      } catch {
        /* failure to record the failure is non-fatal */
      }
      // eslint-disable-next-line no-console
      console.error(
        `[pr-orphan-reconcile] dispatch failed for ${pr.pr.owner}/${pr.pr.repo}#${pr.pr.number}: ${cause}`,
      );
    }
    // Reference claimedThisTick so future audit branches can rely on
    // the value without an unused-var lint hit. Today the value is
    // always true at this point (we either continued on conflict or
    // are in the success path); kept assigned for symmetry with the
    // pr-merge-reconcile pattern where the same flag distinguishes
    // first-claim from recovery.
    void claimedThisTick;
  }

  return {
    scanned,
    orphansDetected,
    idempotentSkips,
    dispatched,
    failedDispatches,
    rateLimited,
    skipped,
  };
}

/**
 * Build the `pr-orphan-detected` atom. Pure builder; the caller
 * passes to `host.atoms.put`.
 */
function buildOrphanDetectedAtom(args: {
  readonly id: AtomId;
  readonly pr: PrRef;
  readonly reason: OrphanReason;
  readonly now_iso: Time;
  readonly last_activity_at: Time;
  readonly cadence_bucket: number;
  readonly prior_claim: ActiveDriverClaim | null;
  readonly principal_id: string;
  readonly snapshot: Readonly<Record<string, unknown>> | undefined;
}): Atom {
  const derived: AtomId[] = [];
  if (args.prior_claim !== null) {
    derived.push(args.prior_claim.atom.id);
  }
  return {
    schema_version: 1,
    id: args.id,
    content:
      `pr-orphan-detected: ${args.pr.owner}/${args.pr.repo}#${args.pr.number} `
      + `reason=${args.reason}`,
    type: 'pr-orphan-detected',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: args.principal_id, tool: 'pr-orphan-reconcile' },
      derived_from: derived,
    },
    confidence: 1.0,
    created_at: args.now_iso,
    last_reinforced_at: args.now_iso,
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
    principal_id: args.principal_id as PrincipalId,
    taint: 'clean',
    metadata: {
      pr: { owner: args.pr.owner, repo: args.pr.repo, number: args.pr.number },
      orphan_reason: args.reason,
      detected_at: args.now_iso,
      last_activity_at: args.last_activity_at,
      cadence_bucket: args.cadence_bucket,
      ...(args.prior_claim !== null
        ? {
            prior_claim_id: String(args.prior_claim.atom.id),
            prior_claim_principal_id: args.prior_claim.principal_id,
          }
        : {}),
      ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}),
      dispatch_attempted: false,
    },
  };
}

/**
 * Deterministic id for an orphan-detected atom. The cadence bucket
 * is part of the hash so a stable orphan PR produces exactly one
 * atom per window; the next window observes a fresh bucket and
 * therefore a fresh id, allowing repeated dispatch on persistent
 * orphans. Truncated to 16 hex chars.
 */
export function makeOrphanDetectedId(pr: PrRef, cadenceBucket: number): string {
  const digest = createHash('sha256')
    .update(pr.owner)
    .update('|')
    .update(pr.repo)
    .update('|')
    .update(String(pr.number))
    .update('|')
    .update(String(cadenceBucket))
    .digest('hex')
    .slice(0, 16);
  return `pr-orphan-detected-${digest}`;
}

function toMs(value: string | Time | number): number {
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}
