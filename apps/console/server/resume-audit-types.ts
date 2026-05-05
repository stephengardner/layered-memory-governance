/**
 * Wire-shape definitions for the resume-audit surface.
 *
 * Mirrored separately from the helper module so the frontend service
 * can import these types verbatim (sibling to `pipelines-types.ts` and
 * `live-ops-types.ts`) without dragging the server-side helper code
 * into the browser bundle. The server handler imports both; the
 * frontend service imports only this file's types.
 *
 * Contract: every endpoint returns derived projections over the
 * `agent-session` and `resume-reset` atom chains. The atoms themselves
 * stay on disk per `arch-atomstore-source-of-truth`; this surface is
 * read-only. The substrate fields the projection consumes were shipped
 * by Phases 1-3 (resume-by-default extension); Phase 4 only adds the
 * dashboard surface that projects across all actors.
 */

/**
 * Narrow atom shape the helpers consume. Mirrors the in-server Atom
 * interface and the `PipelineSourceAtom` shape so the resume-audit
 * helpers stay decoupled from server/index.ts (no cyclic import risk).
 */
export interface ResumeAuditSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
}

/**
 * The substrate-defined `resume_attempt` field on
 * `metadata.agent_session.extra`. Captured here so the wire shape and
 * the per-principal stat projections agree on the universe of values.
 *
 * - `resumed`                       : a strategy resolved AND resume returned `completed`
 * - `fresh-spawn-no-strategy`       : no strategy resolved
 * - `fresh-spawn-fallback`          : strategy resolved but resume returned non-`completed`
 * - `fresh-spawn-reset`             : operator-reset atom found at invocation
 * - `fresh-spawn-policy-disabled`   : policy short-circuit at construction
 *
 * `unknown` is a renderer-only sentinel for sessions whose `extra`
 * object is missing the field entirely (which is most sessions today
 * because phases 1-3 are merged but actors haven't started writing
 * the field yet; the dashboard treats absence as "not in scope for
 * this principal" per spec section 7.2 last paragraph).
 */
export type ResumeAttemptKind =
  | 'resumed'
  | 'fresh-spawn-no-strategy'
  | 'fresh-spawn-fallback'
  | 'fresh-spawn-reset'
  | 'fresh-spawn-policy-disabled'
  | 'unknown';

/**
 * Per-principal aggregate computed over a time window. The window
 * default is 24h; the API surfaces an explicit `window_hours` knob so
 * an operator can scope to a tighter range when investigating a recent
 * incident. The `ratio` field is the resume-vs-fresh-spawn ratio
 * (resumed / (resumed + fresh-spawn-attempts)); 0 when no resume
 * attempts in the window so the value is always finite. `null` is
 * reserved for "no relevant sessions" so the UI can render "no
 * activity" instead of "0%".
 */
export interface ResumeAuditPrincipalStats {
  readonly principal_id: string;
  readonly total_sessions: number;
  /** Sessions that wrote any `resume_attempt` value. */
  readonly resume_attempts: number;
  readonly resumed_count: number;
  readonly fresh_spawn_count: number;
  /**
   * Resume ratio = `resumed_count / resume_attempts`; null when the
   * principal had zero `resume_attempt` writes in the window (so the
   * UI can render an explicit "no resume telemetry yet" state instead
   * of a 0% bar).
   */
  readonly ratio: number | null;
  /** Most recent `agent-session.created_at` for this principal in the window. */
  readonly last_session_at: string | null;
}

export interface ResumeAuditSummary {
  readonly window_hours: number;
  /** Server-side cutoff: all stats include sessions with created_at >= this. */
  readonly window_start_at: string;
  readonly generated_at: string;
  readonly principals: ReadonlyArray<ResumeAuditPrincipalStats>;
  readonly total_sessions: number;
  readonly total_resume_attempts: number;
  readonly total_resumed: number;
}

/**
 * One row in the "recent resumed sessions" list. Ordered by
 * `created_at` DESC; the prior session atom id is forwarded straight
 * from `extra.resumed_from_atom_id` so the click-through can drill in
 * via the existing atom-detail viewer.
 */
export interface ResumeAuditRecentSession {
  readonly session_atom_id: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly resume_attempt: ResumeAttemptKind;
  readonly resume_strategy_used: string | null;
  readonly resumed_from_atom_id: string | null;
  readonly model_id: string | null;
  readonly adapter_id: string | null;
  readonly workspace_id: string | null;
}

export interface ResumeAuditRecentResponse {
  readonly sessions: ReadonlyArray<ResumeAuditRecentSession>;
  readonly generated_at: string;
}

/**
 * One row in the "recent resume-reset atoms" list. The dashboard
 * surfaces these so an operator can see when an operator-reset escape
 * hatch was exercised. Per spec section 6.4, these atoms have `type:
 * 'resume-reset'` and their `metadata.reset` carries the principal +
 * work-item key + reason.
 */
export interface ResumeAuditResetRecord {
  readonly atom_id: string;
  readonly created_at: string;
  readonly principal_id: string;
  readonly reset_principal_id: string;
  readonly work_item_kind: string | null;
  readonly work_item_summary: string | null;
  readonly reason: string | null;
  /**
   * Whether this reset has been consumed (a `resume-reset-consumed`
   * atom referencing this id has been written). Read-only display: the
   * UI shows a chip ("Pending" / "Consumed").
   */
  readonly consumed: boolean;
}

export interface ResumeAuditResetsResponse {
  readonly resets: ReadonlyArray<ResumeAuditResetRecord>;
  readonly generated_at: string;
}

/**
 * Hard cap on rows returned per recent-list endpoint. Defends against
 * a misconfigured client polling for the entire atom-store every 5s
 * and matches the bound used by `actor-activity` (`ACTOR_ACTIVITY_MAX_LIMIT`).
 */
export const RESUME_AUDIT_MAX_LIST_ITEMS = 200;
export const RESUME_AUDIT_DEFAULT_LIMIT = 50;

/**
 * Time-window default. Operators can override via the `window_hours`
 * request parameter; the server clamps to a sane range (1h..720h /
 * 30 days) so a 1-year window does not produce a payload spike.
 */
export const RESUME_AUDIT_DEFAULT_WINDOW_HOURS = 24;
export const RESUME_AUDIT_MIN_WINDOW_HOURS = 1;
export const RESUME_AUDIT_MAX_WINDOW_HOURS = 720;
