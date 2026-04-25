/**
 * Budget + threshold helpers for the agentic actor loop.
 *
 * Threshold clamp + default budget are used by the per-actor blob-
 * threshold policy parser and by the agentic executor. Centralized
 * here so the bounds are a single source of truth and so a future
 * change to the clamp range is one edit, not many.
 *
 * Threat model
 * ------------
 * `clampBlobThreshold` MUST clamp at the documented bounds. Failing
 * to clamp opens two practical attacks against the blob store:
 *
 *  - threshold = 0    -> every byte goes to the blob store; tiny
 *                        per-blob filesystem overhead dominates
 *                        (DoS via inflation).
 *  - threshold = inf  -> every payload inlines; atom files balloon
 *                        to MBs, defeating dedup + projection-
 *                        scan latency.
 *
 * The clamp also catches NaN (floors to the minimum) so a malformed
 * policy atom cannot silently disable thresholding.
 */

/** Minimum blob threshold (bytes); below this is DoS-prone (per-blob filesystem cost). */
export const BLOB_THRESHOLD_MIN = 256;

/** Maximum blob threshold (bytes); above this defeats blob storage's purpose. */
export const BLOB_THRESHOLD_MAX = 1_048_576;

/** Default blob threshold: 4 KB. Covers most LLM IO inline; large reads/dumps externalize. */
export const BLOB_THRESHOLD_DEFAULT = 4096;

/**
 * Clamp a blob threshold to `[BLOB_THRESHOLD_MIN, BLOB_THRESHOLD_MAX]`.
 * NaN and non-numbers clamp to the minimum (defensive: a malformed
 * policy atom cannot silently widen the surface). Fractional inputs
 * floor to an integer because byte-counts are not fractional.
 */
export function clampBlobThreshold(input: number): number {
  if (typeof input !== 'number' || Number.isNaN(input)) {
    return BLOB_THRESHOLD_MIN;
  }
  const floored = Math.floor(input);
  if (floored < BLOB_THRESHOLD_MIN) return BLOB_THRESHOLD_MIN;
  if (floored > BLOB_THRESHOLD_MAX) return BLOB_THRESHOLD_MAX;
  return floored;
}

/**
 * Budget cap supplied to an agent-loop adapter's `run()` call.
 * `max_turns` and `max_wall_clock_ms` are the runaway-safety floor
 * every adapter MUST honor. `max_usd` is opportunistic; adapters
 * whose `capabilities.tracks_cost === false` ignore it.
 */
export interface BudgetCap {
  readonly max_turns: number;
  readonly max_wall_clock_ms: number;
  /** Optional. Honored only when the adapter declares `tracks_cost`. */
  readonly max_usd?: number;
}

/**
 * Sensible defaults: 30 turns, 10 minutes wall-clock, no USD cap.
 * Callers in production override per-actor via executor configuration.
 * The defaults exist so a solo-developer setup runs without needing
 * to author a budget policy from day one.
 */
export function defaultBudgetCap(): BudgetCap {
  return { max_turns: 30, max_wall_clock_ms: 10 * 60 * 1000 };
}
