import { transport } from './transport';

/**
 * Operator control-panel projection. Mirrors the server's
 * ControlStatus contract (apps/console/server/control-status.ts).
 *
 * Read-only by contract: the console NEVER writes the STOP sentinel
 * from this service. The "Engage Kill Switch" button in the UI is a
 * confirmation prompt that surfaces the manual `touch .lag/STOP`
 * command; actually engaging the kill switch crosses the operator-
 * shell trust boundary and is intentionally out of scope for v1.
 *
 * Refresh cadence: callers compose this service with TanStack
 * Query's refetchInterval (3 seconds for the dashboard view) so the
 * kill-switch state shows the operator a near-live picture without
 * SSE plumbing for the v1 cut.
 */
export type AutonomyTier = 'soft' | 'medium' | 'hard';

export interface ControlKillSwitchSnapshot {
  readonly engaged: boolean;
  readonly sentinel_path: string;
  readonly engaged_at: string | null;
}

export interface ControlStatus {
  readonly kill_switch: ControlKillSwitchSnapshot;
  readonly autonomy_tier: AutonomyTier;
  readonly actors_governed: number;
  readonly policies_active: number;
  readonly last_canon_apply: string | null;
  readonly operator_principal_id: string;
  readonly recent_kill_switch_transitions: ReadonlyArray<KillSwitchTransitionSummary>;
  readonly active_elevations: ReadonlyArray<ActiveElevationSummary>;
  readonly recent_operator_actions: ReadonlyArray<OperatorActionSummary>;
  readonly recent_escalations: ReadonlyArray<EscalationSummary>;
}

/*
 * Frontend mirrors of the backend control-status summary types
 * (apps/console/server/control-status.ts). Kept in sync manually
 * because the project's transport contract is dotted-method JSON; a
 * future shared types package would erase the duplication but is out
 * of scope for this PR.
 */
export interface KillSwitchTransitionSummary {
  readonly tier: 'off' | 'soft' | 'medium' | 'hard';
  readonly at: string;
  readonly transitioned_by: string | null;
  readonly reason: string | null;
  /*
   * Source atom id when the row came from a kill-switch-transition-*
   * atom, null when it reflects the live state-file snapshot. Mirrors
   * the backend type. Used as the React key in the transitions list
   * so colliding (at, tier) tuples do not deduplicate DOM nodes.
   */
  readonly atom_id: string | null;
}

export interface ActiveElevationSummary {
  readonly atom_id: string;
  readonly policy_target: string | null;
  readonly principal: string | null;
  readonly started_at: string | null;
  readonly expires_at: string;
  readonly time_remaining_seconds: number;
}

export interface OperatorActionSummary {
  readonly atom_id: string;
  readonly principal_id: string;
  readonly kind: string;
  readonly at: string;
}

export interface EscalationSummary {
  readonly atom_id: string;
  readonly at: string;
  readonly headline: string;
}

export async function getControlStatus(signal?: AbortSignal): Promise<ControlStatus> {
  return transport.call<ControlStatus>(
    'control.status',
    undefined,
    signal ? { signal } : undefined,
  );
}
