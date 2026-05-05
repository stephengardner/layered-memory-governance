import { computeLiveOpsStatus } from './freshness';
import styles from './LiveOpsStatusBadge.module.css';

export interface LiveOpsStatusBadgeProps {
  mostRecentAgentTurnAt: string | null;
  /** Injected for testability; defaults to wall-clock now per render. */
  now?: number;
}

/**
 * Display-only freshness badge: Running (green pulsing dot) when the
 * most recent agent-turn is within AGENT_TURN_FRESHNESS_THRESHOLD_MS,
 * Idle (muted dot, static) otherwise. Re-renders through the parent's
 * 2s snapshot refetch -- no internal timer.
 *
 * Styling lives in the co-located CSS module so the component honors
 * the apps/console token discipline (no hardcoded px/hex/rgba in TSX).
 * The pulse keyframe respects `prefers-reduced-motion`.
 */
export function LiveOpsStatusBadge({
  mostRecentAgentTurnAt,
  now = Date.now(),
}: LiveOpsStatusBadgeProps) {
  const state = computeLiveOpsStatus(mostRecentAgentTurnAt, now);
  return (
    <span
      className={styles.badge}
      data-testid="live-ops-status-badge"
      data-state={state}
    >
      <span className={styles.dot} aria-hidden="true" />
      {state === 'running' ? 'Running' : 'Idle'}
    </span>
  );
}
