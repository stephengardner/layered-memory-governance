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
}

export async function getControlStatus(signal?: AbortSignal): Promise<ControlStatus> {
  return transport.call<ControlStatus>(
    'control.status',
    undefined,
    signal ? { signal } : undefined,
  );
}
