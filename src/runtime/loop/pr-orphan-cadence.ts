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
 * Substrate purity: this reader is a one-liner over the shared
 * `readNumericCanonPolicy` helper. The shared helper carries the
 * paging loop, taint/superseded filter, and value/back-compat handling
 * so the four readers in this folder share one implementation rather
 * than three.
 */

import type { Host } from '../../interface.js';
import { readNumericCanonPolicy } from './canon-policy-cadence.js';

/** Default tick interval: 5 minutes. */
export const DEFAULT_PR_ORPHAN_CADENCE_MS = 5 * 60 * 1_000;

/**
 * Read the configured cadence from canon. Falls back to
 * DEFAULT_PR_ORPHAN_CADENCE_MS when no policy atom exists or the
 * value is malformed (non-numeric, non-finite, zero, negative).
 * Tainted or superseded canon atoms are ignored.
 */
export async function readPrOrphanReconcileCadenceMs(host: Host): Promise<number> {
  return readNumericCanonPolicy(host, {
    subject: 'pr-orphan-reconcile-cadence-ms',
    fieldName: 'interval_ms',
    fallback: DEFAULT_PR_ORPHAN_CADENCE_MS,
  });
}
