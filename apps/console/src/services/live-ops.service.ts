/**
 * Live Ops service: wraps /api/live-ops.snapshot.
 *
 * Single-call digest of the current state of the autonomous org so
 * the dashboard hits ONE endpoint on each 2s refresh tick. Splitting
 * into seven per-section endpoints would multiply the network cost
 * and risk inconsistent reads (each section observing a different
 * atom-store snapshot mid-tick).
 *
 * Read-only contract: this service exposes a single fetcher; no
 * write surface is built on top of /api/live-ops.snapshot.
 */

import { transport } from './transport';

export interface LiveOpsHeartbeat {
  readonly last_60s: number;
  readonly last_5m: number;
  readonly last_1h: number;
  readonly delta: number;
}

export interface LiveOpsActiveSession {
  readonly session_id: string;
  readonly principal_id: string;
  readonly started_at: string;
  readonly last_turn_at: string | null;
}

export interface LiveOpsLiveDeliberation {
  readonly plan_id: string;
  readonly title: string;
  readonly principal_id: string;
  readonly age_seconds: number;
}

export interface LiveOpsInFlightExecution {
  readonly plan_id: string;
  readonly dispatched_at: string;
  readonly age_seconds: number;
  readonly dispatched_by: string;
}

export interface LiveOpsRecentTransition {
  readonly plan_id: string;
  readonly prev_state: string;
  readonly new_state: string;
  readonly at: string;
  readonly principal_id: string;
}

export interface LiveOpsActiveElevation {
  readonly atom_id: string;
  readonly started_at: string | null;
  readonly expires_at: string;
  readonly ms_until_expiry: number;
}

export interface LiveOpsDaemonPosture {
  readonly kill_switch_engaged: boolean;
  readonly kill_switch_tier: 'off' | 'soft' | 'medium' | 'hard';
  readonly autonomy_dial: number;
  readonly active_elevations: ReadonlyArray<LiveOpsActiveElevation>;
}

export interface LiveOpsPrActivity {
  readonly pr_number: number;
  readonly title: string | null;
  readonly state: string;
  readonly at: string;
}

export interface LiveOpsSnapshot {
  readonly computed_at: string;
  readonly heartbeat: LiveOpsHeartbeat;
  readonly active_sessions: ReadonlyArray<LiveOpsActiveSession>;
  readonly live_deliberations: ReadonlyArray<LiveOpsLiveDeliberation>;
  readonly in_flight_executions: ReadonlyArray<LiveOpsInFlightExecution>;
  readonly recent_transitions: ReadonlyArray<LiveOpsRecentTransition>;
  readonly daemon_posture: LiveOpsDaemonPosture;
  readonly pr_activity: ReadonlyArray<LiveOpsPrActivity>;
}

export async function getLiveOpsSnapshot(signal?: AbortSignal): Promise<LiveOpsSnapshot> {
  return transport.call<LiveOpsSnapshot>(
    'live-ops.snapshot',
    undefined,
    signal ? { signal } : undefined,
  );
}
