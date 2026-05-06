/**
 * PR-orphan reconcile cadence canon reader.
 *
 * Reads the sleep interval (in milliseconds) for the daemon driver of
 * the orphan-reconcile tick. The value is canon-tunable so callers
 * can tighten or relax the cadence via a higher-priority policy atom
 * without a code change.
 *
 * Default 5 minutes matches the orphan-detection threshold and the
 * approval-cycle tick interval so a stable orphan PR produces
 * exactly one detection / dispatch per cycle and the dial-tuned
 * reconciler self-paces with the rest of the loop.
 *
 * Substrate purity: this reader is mechanism-only. It scans canon
 * directive atoms for `metadata.policy.subject ===
 * 'pr-orphan-reconcile-cadence-ms'`, matching the read shape of
 * `readApprovalCycleTickIntervalMs` and `readPrObservationFreshnessMs`
 * so future maintainers see one pattern, not three.
 */

import type { Host } from '../../interface.js';

/** Default tick interval: 5 minutes. */
export const DEFAULT_PR_ORPHAN_CADENCE_MS = 5 * 60 * 1_000;

/**
 * Read the configured cadence from canon. Falls back to
 * DEFAULT_PR_ORPHAN_CADENCE_MS when no policy atom exists or the
 * value is malformed (non-numeric, non-finite, zero, negative).
 * Tainted or superseded canon atoms are ignored.
 *
 * Mirrors the read shape of `readApprovalCycleTickIntervalMs` so
 * the pair of tunable cadence dials uses one consistent pattern.
 */
export async function readPrOrphanReconcileCadenceMs(host: Host): Promise<number> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== 'pr-orphan-reconcile-cadence-ms') continue;
      // Named field follows the convention of the sibling cadence
      // policies (pol-actor-message-rate, pol-inbox-poll-cadence,
      // pol-pr-observation-freshness-threshold-ms). Back-compat read on
      // `value` keeps an older bootstrap shape readable while the
      // named-field shape is canonical going forward.
      const interval = policy['interval_ms'] ?? policy['value'];
      if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) continue;
      return interval;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_PR_ORPHAN_CADENCE_MS;
}
