/**
 * Approval-cycle tick-interval canon reader.
 *
 * Reads the sleep interval (in milliseconds) for the deployment-side
 * daemon driver of the approval-cycle ticks. The value is canon-tunable
 * so a deployment that wants a tighter cadence (60s) or a relaxed one
 * (15min) flips it via a higher-priority policy atom without a code
 * change. Default 5 minutes matches the freshness threshold for the
 * pr-observation refresh tick so the substrate stays self-consistent:
 * a stale OPEN observation is refreshed within one freshness-window
 * worth of cadence, and the reconciler picks up the terminal state
 * on the next pass.
 *
 * Substrate purity: this reader is mechanism-only. It scans canon
 * directive atoms for `metadata.policy.subject ===
 * 'approval-cycle-tick-interval-ms'`, matching the read shape of
 * `readPrObservationFreshnessMs` so future maintainers see one
 * pattern, not two.
 */

import type { Host } from '../../interface.js';

/** Default tick interval: 5 minutes. */
export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Read the configured tick interval from canon. Falls back to
 * DEFAULT_TICK_INTERVAL_MS when no policy atom exists or the value is
 * malformed (non-numeric, non-finite, zero, negative). Tainted or
 * superseded canon atoms are ignored.
 *
 * Mirrors the read shape of `readPrObservationFreshnessMs` so the
 * pair of tunable dials uses one consistent atom-policy pattern.
 */
export async function readApprovalCycleTickIntervalMs(host: Host): Promise<number> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== 'approval-cycle-tick-interval-ms') continue;
      // Named field follows the convention of pol-actor-message-rate +
      // pol-inbox-poll-cadence + pol-pr-observation-freshness-threshold-ms.
      // Back-compat read on `value` keeps an older bootstrap shape readable
      // while the named-field shape is canonical going forward.
      const interval = policy['interval_ms'] ?? policy['value'];
      if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) continue;
      return interval;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_TICK_INTERVAL_MS;
}
