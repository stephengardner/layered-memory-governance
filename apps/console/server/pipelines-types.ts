/**
 * Wire-shape definitions for the pipelines surface.
 *
 * Mirrored separately from the helper module so the frontend service
 * can import these types verbatim (sibling to `live-ops-types.ts`)
 * without dragging the server-side helper code into the browser
 * bundle. The server handler imports both; the frontend service
 * imports only this file's types.
 *
 * Contract: every endpoint returns derived projections over the
 * pipeline atom chain (1 pipeline + N stage events + M audit findings
 * + optional pipeline-failed + optional pipeline-resume). The atoms
 * themselves stay on disk per `arch-atomstore-source-of-truth`; this
 * surface is read-only.
 */

/**
 * Narrow atom shape the helpers consume. Mirrors the in-server Atom
 * interface and the `LiveOpsAtom` shape in `live-ops-types.ts` so the
 * pipeline helpers can stay decoupled from server/index.ts (no cyclic
 * import risk).
 */
export interface PipelineSourceAtom {
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
  /** Top-level field on a `pipeline` atom. Other types omit it. */
  readonly pipeline_state?: string;
}

/**
 * Severity of an audit finding. Surface ordering: critical > major > minor.
 */
export type PipelineAuditSeverity = 'critical' | 'major' | 'minor';

/**
 * Counts per severity for a pipeline's findings, plus a total. The
 * server pre-rolls these so the list cards don't have to bucket
 * client-side.
 */
export interface PipelineAuditCounts {
  readonly total: number;
  readonly critical: number;
  readonly major: number;
  readonly minor: number;
}

/**
 * Single stage's roll-up across enter/exit/hil-pause/hil-resume events.
 * `current_state` is one of:
 *   - 'pending'   : no events seen yet for this stage
 *   - 'running'   : enter without a matching exit
 *   - 'paused'    : last event was hil-pause (no resume yet)
 *   - 'succeeded' : last event was exit-success
 *   - 'failed'    : last event was exit-failure
 */
export type PipelineStageState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed';

export interface PipelineStageSummary {
  readonly stage_name: string;
  readonly state: PipelineStageState;
  /** Ordinal index in the run's stage order (0-based). */
  readonly index: number;
  /** Sum of duration_ms across this stage's events (typically just the exit event). */
  readonly duration_ms: number;
  /** Sum of cost_usd across this stage's events. */
  readonly cost_usd: number;
  /** Latest event timestamp on the stage; null if no events seen. */
  readonly last_event_at: string | null;
  /** Output atom id reported on the exit-success event, if any. */
  readonly output_atom_id: string | null;
}

/**
 * One row in `/api/pipelines.list`. Pre-rolled stats so the grid
 * renders without N round-trips.
 */
export interface PipelineSummary {
  readonly pipeline_id: string;
  readonly pipeline_state: string;
  readonly mode: string | null;
  readonly principal_id: string;
  readonly correlation_id: string | null;
  /** Plain-text title derived from a seed atom or the pipeline content. */
  readonly title: string;
  readonly seed_atom_ids: ReadonlyArray<string>;
  readonly created_at: string;
  /** Latest event/atom timestamp tied to this pipeline (for sort + display). */
  readonly last_event_at: string;
  readonly total_cost_usd: number;
  readonly total_duration_ms: number;
  readonly current_stage_name: string | null;
  readonly current_stage_index: number;
  readonly total_stages: number;
  readonly audit_counts: PipelineAuditCounts;
  readonly has_failed_atom: boolean;
  readonly has_resume_atom: boolean;
}

export interface PipelineListResult {
  readonly computed_at: string;
  readonly pipelines: ReadonlyArray<PipelineSummary>;
}

/**
 * `/api/pipelines.live-ops` payload — narrowed to the shape the Pulse
 * tile needs. Intentionally smaller than `PipelineSummary` so the
 * 2s refresh keeps a tight wire payload.
 */
export interface PipelineLiveOpsRow {
  readonly pipeline_id: string;
  readonly pipeline_state: string;
  readonly title: string;
  readonly current_stage_name: string | null;
  readonly current_stage_index: number;
  readonly total_stages: number;
  readonly last_event_at: string;
  readonly total_cost_usd: number;
}

export interface PipelineLiveOpsResult {
  readonly computed_at: string;
  readonly pipelines: ReadonlyArray<PipelineLiveOpsRow>;
}

/**
 * One stage-event row in the detail view. Mirrors the
 * `pipeline-stage-event` atom directly so the timeline UI can render
 * without re-deriving anything.
 */
export interface PipelineStageEvent {
  readonly atom_id: string;
  readonly stage_name: string;
  readonly transition: 'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume';
  readonly at: string;
  readonly duration_ms: number;
  readonly cost_usd: number;
  readonly output_atom_id: string | null;
  readonly principal_id: string;
}

export interface PipelineAuditFinding {
  readonly atom_id: string;
  readonly stage_name: string;
  readonly severity: PipelineAuditSeverity;
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<string>;
  readonly cited_paths: ReadonlyArray<string>;
  readonly created_at: string;
  readonly principal_id: string;
}

export interface PipelineFailureRecord {
  readonly atom_id: string;
  readonly failed_stage_name: string;
  readonly failed_stage_index: number;
  readonly cause: string;
  readonly recovery_hint: string;
  readonly chain: ReadonlyArray<string>;
  readonly at: string;
  /** True when the chain was clipped because the recovery_hint exceeded the bound. */
  readonly truncated: boolean;
}

export interface PipelineResumeRecord {
  readonly atom_id: string;
  readonly stage_name: string;
  readonly resumer_principal_id: string;
  readonly at: string;
}

/**
 * Detail payload for one pipeline. Stitches the root + every event +
 * findings + (optional) failure + (optional) resume + per-stage roll
 * up. The drill-in view consumes the structured response directly.
 */
export interface PipelineDetail {
  readonly pipeline: {
    readonly id: string;
    readonly pipeline_state: string;
    readonly mode: string | null;
    readonly principal_id: string;
    readonly correlation_id: string | null;
    readonly title: string;
    readonly content: string;
    readonly seed_atom_ids: ReadonlyArray<string>;
    readonly stage_policy_atom_id: string | null;
    readonly started_at: string;
    readonly completed_at: string | null;
  };
  readonly stages: ReadonlyArray<PipelineStageSummary>;
  readonly events: ReadonlyArray<PipelineStageEvent>;
  readonly findings: ReadonlyArray<PipelineAuditFinding>;
  readonly audit_counts: PipelineAuditCounts;
  readonly failure: PipelineFailureRecord | null;
  readonly resumes: ReadonlyArray<PipelineResumeRecord>;
  readonly total_cost_usd: number;
  readonly total_duration_ms: number;
  readonly current_stage_name: string | null;
  readonly current_stage_index: number;
  readonly total_stages: number;
  readonly last_event_at: string;
}
