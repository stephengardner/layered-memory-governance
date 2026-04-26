/**
 * Pure helpers for the metrics-rollup handler. Kept in their own
 * module so they can be unit-tested without standing up the HTTP
 * server (mirrors the security.ts + kill-switch-state.ts pattern).
 */

/**
 * Median of a numeric series. Returns null on an empty input; the
 * UI is responsible for rendering "n/a" rather than 0, since a true
 * 0 is meaningful (e.g. "median CR rounds = 0" implies a fast loop).
 */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Pull the short stage label out of an executor failure message.
 * The dispatch_result.message format is:
 *   "executor failed at stage=apply-branch/dirty-worktree: ..."
 * We extract `apply-branch/dirty-worktree` for the failure pill.
 * Falls back to `unknown` when the marker is missing so the pill
 * always has a label.
 */
export function extractFailureStage(message: string): string {
  const m = message.match(/stage=([\w/-]+)/);
  return m ? m[1]! : 'unknown';
}
