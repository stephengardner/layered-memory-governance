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
 * Substrate purity: this reader is a one-liner over the shared
 * `readNumericCanonPolicy` helper. The shared helper carries the
 * paging loop, taint/superseded filter, and value/back-compat handling
 * so the four readers in this folder share one implementation rather
 * than three.
 */

import type { Host } from '../../interface.js';
import { readNumericCanonPolicy } from './canon-policy-cadence.js';

/** Default tick interval: 5 minutes. */
export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Read the configured tick interval from canon. Falls back to
 * DEFAULT_TICK_INTERVAL_MS when no policy atom exists or the value is
 * malformed (non-numeric, non-finite, zero, negative). Tainted or
 * superseded canon atoms are ignored.
 */
export async function readApprovalCycleTickIntervalMs(host: Host): Promise<number> {
  return readNumericCanonPolicy(host, {
    subject: 'approval-cycle-tick-interval-ms',
    fieldName: 'interval_ms',
    fallback: DEFAULT_TICK_INTERVAL_MS,
  });
}
