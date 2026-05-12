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
  /**
   * Atom ids the stage cited as inputs (provenance.derived_from chain
   * minus the seed). Optional on the wire today: the server projection
   * does not yet populate this field; the UI renders an Inputs accordion
   * defensively when present so a future projection that wires it up
   * lights up the surface without a coordinated client release.
   */
  readonly input_atom_ids?: ReadonlyArray<string>;
}

/**
 * Dispatch counters surfaced from the dispatch-record atom that
 * matches a pipeline (one record per pipeline, scoped via
 * metadata.pipeline_id). Surfaced on the pipeline summary so the
 * grid card can paint a TRUE-outcome state pill: a pipeline_state
 * of `completed` with `dispatched === 0` reads as a noop, not as a
 * green ship. Null when no dispatch-record exists for the pipeline
 * yet (the pipeline hasn't crossed dispatch-stage).
 */
export interface PipelineDispatchSummary {
  readonly scanned: number;
  readonly dispatched: number;
  readonly failed: number;
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
  /**
   * Counters from the matching dispatch-record atom (when one exists).
   * The card uses `dispatched > 0` to gate the green succeeded pill;
   * `dispatched === 0` on a completed pipeline is the noop signal.
   */
  readonly dispatch_summary: PipelineDispatchSummary | null;
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
  /** Same TRUE-outcome carrier as PipelineSummary; null until dispatch. */
  readonly dispatch_summary: PipelineDispatchSummary | null;
}

export interface PipelineLiveOpsResult {
  readonly computed_at: string;
  readonly pipelines: ReadonlyArray<PipelineLiveOpsRow>;
}

/**
 * One stage-event row in the detail view. Mirrors the
 * `pipeline-stage-event` atom directly so the timeline UI can render
 * without re-deriving anything.
 *
 * Retry transitions ('retry-after-findings', 'validator-retry-after-failure')
 * are emitted by the substrate retry loops (auditor-feedback +
 * plan-stage validator-retry); the UI surfaces them on the timeline so
 * the operator sees "stage X succeeded on attempt 2/2" rather than
 * just "stage X succeeded". Each retry event carries attempt_index +
 * (findings_summary OR validator_error_message) on metadata.
 */
export interface PipelineStageEvent {
  readonly atom_id: string;
  readonly stage_name: string;
  readonly transition:
    | 'enter'
    | 'exit-success'
    | 'exit-failure'
    | 'hil-pause'
    | 'hil-resume'
    | 'retry-after-findings'
    | 'validator-retry-after-failure';
  readonly at: string;
  readonly duration_ms: number;
  readonly cost_usd: number;
  readonly output_atom_id: string | null;
  readonly principal_id: string;
  /**
   * 1-based attempt index emitted by retry transitions. Absent on
   * non-retry transitions (enter, exit-*, hil-*). The runner enforces
   * attempt_index >= 2 at mint time: attempt 1 produces the first
   * audit/validation failure, attempt 2 is the first retry.
   */
  readonly attempt_index?: number;
  /**
   * Severity-bucketed count of findings on a 'retry-after-findings'
   * event. The runner builds this from the audit findings list at
   * emit time. Absent on other transitions.
   */
  readonly findings_summary?: {
    readonly critical: number;
    readonly major: number;
    readonly minor: number;
  };
  /**
   * Validator (zod) error message on a 'validator-retry-after-failure'
   * event. Truncated server-side at MAX_VALIDATOR_ERROR_MESSAGE_LEN.
   * Absent on other transitions.
   */
  readonly validator_error_message?: string;
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
 * One agent-turn row surfaced on the detail view's "Live progress"
 * section. Projected from `pipeline-stage-event` atoms with
 * `transition === 'agent-turn'` cross-walked into the matching
 * `agent-turn` atom for telemetry.
 *
 * Shape constraints:
 *   - `agent_turn_atom_id` is null when the index event lacks the
 *     pointer (defensive: a malformed substrate write should NOT crash
 *     the projection).
 *   - `latency_ms` / `tool_calls_count` come from the cross-walked
 *     `agent-turn` atom; absent or unreachable atom yields null.
 *   - `llm_input_preview` is the first 200 chars of the inline
 *     `llm_input` payload; blob-ref payloads skip preview (returns
 *     null) because the projection does not resolve blobs at read
 *     time.
 *   - `created_at` is the ISO timestamp of the index event atom (the
 *     pipeline-stage-event), not the agent-turn atom. The two SHOULD
 *     match within milliseconds but the index event is the canonical
 *     ordering signal.
 */
export interface AgentTurnRow {
  readonly stage_name: string;
  readonly turn_index: number;
  readonly agent_turn_atom_id: string | null;
  readonly created_at: string;
  readonly latency_ms: number | null;
  readonly llm_input_preview: string | null;
  readonly tool_calls_count: number | null;
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
  /**
   * Per-turn telemetry surfaced from `pipeline-stage-event` atoms with
   * `transition='agent-turn'`. Newest-first across ALL stages (so the
   * actively-running stage's latest turn lands at the top), capped at
   * `PIPELINE_DETAIL_MAX_TURNS`. Empty when the pipeline has no
   * agent-turn events yet (single-shot stages, or substrate-deep stages
   * that have not yet emitted their first turn).
   */
  readonly agent_turns: ReadonlyArray<AgentTurnRow>;
  readonly total_cost_usd: number;
  readonly total_duration_ms: number;
  readonly current_stage_name: string | null;
  readonly current_stage_index: number;
  readonly total_stages: number;
  readonly last_event_at: string;
  /**
   * Same TRUE-outcome carrier as PipelineSummary; surfaces here so the
   * detail header can paint the noop pill when a completed pipeline
   * shipped no PR, without re-fetching the lifecycle envelope.
   */
  readonly dispatch_summary: PipelineDispatchSummary | null;
}
