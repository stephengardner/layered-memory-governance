/**
 * Wire-shape definitions for /api/live-ops.snapshot.
 *
 * Kept separate from the helper module so the frontend service can
 * import these types verbatim without dragging the server pure-helper
 * code into the browser bundle. The server handler imports both;
 * the frontend service imports only this file's types.
 *
 * Read-only contract: every field describes computed, derived data.
 * No request mutates atoms via this surface.
 */

/**
 * Minimal atom shape the helpers consume. Mirrors the in-server Atom
 * interface (server/index.ts) so the helpers can be imported there
 * without a cyclic dependency. Fields not used by the helpers are
 * omitted; the helpers tolerate `metadata` being any shape and
 * narrow per-call.
 */
export interface LiveOpsAtom {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
}

export interface LiveOpsHeartbeat {
  readonly last_60s: number;
  readonly last_5m: number;
  readonly last_1h: number;
  /** Difference between last_60s and the prior 60s window. */
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
  /** ISO timestamp this snapshot was computed. Lets the UI label "as-of". */
  readonly computed_at: string;
  readonly heartbeat: LiveOpsHeartbeat;
  readonly active_sessions: ReadonlyArray<LiveOpsActiveSession>;
  readonly live_deliberations: ReadonlyArray<LiveOpsLiveDeliberation>;
  readonly in_flight_executions: ReadonlyArray<LiveOpsInFlightExecution>;
  readonly recent_transitions: ReadonlyArray<LiveOpsRecentTransition>;
  readonly daemon_posture: LiveOpsDaemonPosture;
  readonly pr_activity: ReadonlyArray<LiveOpsPrActivity>;
}
