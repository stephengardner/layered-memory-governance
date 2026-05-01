/**
 * PR-observation refresh tick.
 *
 * Closes the substrate gap where plans stuck in plan_state='executing'
 * after their PR merges or closes because the only pr-observation atom
 * for the PR was written ONCE at PR-creation time and carries
 * pr_state='OPEN'. This module's tick scans pr-observation atoms still
 * showing non-terminal pr_state, filters to those whose linked Plan is
 * still 'executing', and asks a pluggable refresher to write a fresh
 * observation atom. The existing pr-merge-reconcile tick then picks up
 * the terminal-state observation on the next pass and transitions the
 * plan.
 *
 * Substrate purity: this module never imports a GitHub adapter, never
 * shells out, never parses a PR number from a string. The pluggable
 * `PrObservationRefresher` seam takes structured `{owner, repo,
 * number}` data read from the observation atom's `metadata.pr` field;
 * the deployment-side adapter does the actual GitHub query.
 *
 * Per-tick fairness: maxRefreshes bounds the per-tick refresh-call
 * budget; observations beyond the cap are counted as 'rate-limited' and
 * picked up next tick. maxScan bounds total atoms inspected per tick to
 * keep the scan O(maxScan) regardless of store size.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId, Time } from '../../types.js';

/** Default freshness threshold: 5 minutes. */
export const DEFAULT_FRESHNESS_MS = 5 * 60 * 1_000;

/**
 * Terminal PR-lifecycle states. An observation already showing one of
 * these is left to the existing pr-merge-reconcile tick, which is the
 * canonical state-transition path (per arch-pr-state-observation-via-
 * actor-only). The refresh tick never tries to short-circuit it.
 */
const TERMINAL_PR_STATES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED']);

/**
 * Structured PR reference read directly from `observation.metadata.pr`.
 * This is the canonical source of truth for (owner, repo, number); the
 * tick never derives these by parsing strings.
 */
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Pluggable seam for the deployment-side adapter that actually fetches
 * fresh PR state and writes the new observation atom. Errors thrown by
 * `refresh` are caught by the tick and counted as
 * `skipped['refresh-failed']` so a single transport failure does not
 * halt the whole pass.
 */
export interface PrObservationRefresher {
  refresh(args: { readonly pr: PrRef; readonly plan_id: string }): Promise<void>;
}

export interface PlanObservationRefreshOptions {
  /** Time provider; defaults to wall-clock. Test injection point. */
  readonly now?: () => string | Time | number;
  /** Upper bound on observation atoms scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
  /** Upper bound on refresher.refresh calls per tick; defaults to 50. */
  readonly maxRefreshes?: number;
  /**
   * Override the freshness threshold. When omitted, the threshold is
   * read from the canon policy atom `pol-pr-observation-freshness-
   * threshold-ms` and falls back to DEFAULT_FRESHNESS_MS.
   */
  readonly freshnessMsOverride?: number;
}

export interface PlanObservationRefreshResult {
  readonly scanned: number;
  readonly refreshed: number;
  readonly skipped: Record<string, number>;
}

/**
 * Read the configured freshness threshold from canon. Falls back to
 * DEFAULT_FRESHNESS_MS when no policy atom exists or the value is
 * malformed (non-numeric, non-finite, zero, negative). Substrate stays
 * mechanism-only; the threshold is data, not code.
 */
export async function readPrObservationFreshnessMs(host: Host): Promise<number> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== 'pr-observation-freshness-threshold-ms') continue;
      // Named field follows the convention of pol-actor-message-rate +
      // pol-inbox-poll-cadence. Back-compat read on `value` keeps an
      // older bootstrap shape readable while the named-field shape is
      // canonical going forward.
      const fresh = policy['freshness_ms'] ?? policy['value'];
      // Explicit disable sentinel: a deployment that observes via a
      // webhook (or never wants polling) sets the policy value to
      // 'Infinity' (string, since JSON cannot encode the literal).
      // Returning POSITIVE_INFINITY makes the freshness-window check
      // (now - observed_at < freshness) ALWAYS true, so every
      // observation is counted as 'fresh' and the tick effectively
      // becomes a no-op for that deployment without a code path
      // change.
      if (fresh === 'Infinity') return Number.POSITIVE_INFINITY;
      if (typeof fresh !== 'number' || !Number.isFinite(fresh) || fresh <= 0) continue;
      return fresh;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_FRESHNESS_MS;
}

function isPrRef(value: unknown): value is PrRef {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  // PR numbers are integer GitHub IDs. Number.isInteger is safer than
  // Number.isFinite alone: a fractional `number` (e.g. 1.5 from a
  // malformed payload) would otherwise pass the finite check and reach
  // the refresher, where the spawn would either silently round or
  // return a 404 from the GitHub API.
  return (
    typeof v['owner'] === 'string'
    && (v['owner'] as string).length > 0
    && typeof v['repo'] === 'string'
    && (v['repo'] as string).length > 0
    && typeof v['number'] === 'number'
    && Number.isInteger(v['number'] as number)
    && (v['number'] as number) > 0
  );
}

function toMs(value: string | Time | number): number {
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * The refresh tick. Mechanism-only: no GitHub I/O, no string parsing.
 * Reads observation atoms, filters to candidates needing refresh,
 * delegates the actual refresh to the injected adapter.
 */
export async function runPlanObservationRefreshTick(
  host: Host,
  refresher: PrObservationRefresher,
  options: PlanObservationRefreshOptions = {},
): Promise<PlanObservationRefreshResult> {
  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowMs = toMs(nowFn());
  const MAX_SCAN = options.maxScan ?? 5_000;
  const MAX_REFRESHES = options.maxRefreshes ?? 50;
  const freshnessMs
    = options.freshnessMsOverride ?? (await readPrObservationFreshnessMs(host));

  const PAGE_SIZE = 500;
  let scanned = 0;
  let refreshed = 0;
  const skipped: Record<string, number> = {};
  const bump = (k: string): void => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };

  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - scanned;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['observation'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const obs of page.atoms) {
      scanned += 1;
      // In-code guards mirror the predicate AtomFilter language but
      // are advisory; see pr-merge-reconcile for the same pattern.
      if (obs.taint !== 'clean') continue;
      if (obs.superseded_by.length > 0) continue;
      const meta = obs.metadata as Record<string, unknown>;
      if (meta['kind'] !== 'pr-observation') continue;
      const prState = meta['pr_state'];
      if (typeof prState === 'string' && TERMINAL_PR_STATES.has(prState)) {
        bump('already-terminal');
        continue;
      }
      const planIdRaw = meta['plan_id'];
      if (typeof planIdRaw !== 'string' || planIdRaw.length === 0) {
        bump('no-plan-id');
        continue;
      }
      const observedAtRaw = meta['observed_at'];
      if (typeof observedAtRaw !== 'string' && typeof observedAtRaw !== 'number') {
        bump('observed-at-malformed');
        continue;
      }
      const observedAtMs = toMs(observedAtRaw as string | number);
      if (!Number.isFinite(observedAtMs)) {
        bump('observed-at-malformed');
        continue;
      }
      if (nowMs - observedAtMs < freshnessMs) {
        bump('fresh');
        continue;
      }
      const plan = await host.atoms.get(planIdRaw as AtomId);
      if (plan === null) {
        bump('plan-missing');
        continue;
      }
      if (plan.type !== 'plan') {
        bump('plan-missing');
        continue;
      }
      if (plan.taint !== 'clean') {
        bump('plan-tainted');
        continue;
      }
      if (plan.superseded_by.length > 0) {
        bump('plan-superseded');
        continue;
      }
      if (plan.plan_state !== 'executing') {
        bump('plan-not-executing');
        continue;
      }
      const pr = meta['pr'];
      if (!isPrRef(pr)) {
        bump('pr-malformed');
        continue;
      }
      if (refreshed >= MAX_REFRESHES) {
        bump('rate-limited');
        continue;
      }
      try {
        await refresher.refresh({ pr, plan_id: planIdRaw });
        refreshed += 1;
      } catch {
        bump('refresh-failed');
      }
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  return { scanned, refreshed, skipped };
}

// Re-export Atom for downstream typing convenience without forcing a
// secondary import.
export type { Atom } from '../../types.js';
