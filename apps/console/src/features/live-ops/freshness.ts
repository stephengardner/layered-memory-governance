/**
 * Freshness threshold powering the Live Ops Running/Idle badge. A
 * single named constant so the comparison is documented at the
 * read-site rather than buried in a magic number.
 *
 * Strictly `<` against the threshold; equal-to-threshold counts as
 * idle so a turn that lands precisely on the boundary does not
 * flicker.
 */
export const AGENT_TURN_FRESHNESS_THRESHOLD_MS = 60_000;

export type LiveOpsStatus = 'running' | 'idle';

/**
 * Pure helper. `now` is injected so unit tests can pin a clock
 * without mocking `Date.now()`. Null/undefined input degrades to
 * 'idle' rather than throwing -- the badge never crashes a header.
 */
export function computeLiveOpsStatus(
  mostRecent: string | null | undefined,
  now: number,
): LiveOpsStatus {
  if (mostRecent == null) return 'idle';
  const ts = Date.parse(mostRecent);
  if (!Number.isFinite(ts)) return 'idle';
  return now - ts < AGENT_TURN_FRESHNESS_THRESHOLD_MS ? 'running' : 'idle';
}
