/**
 * Wire-shape definitions for the intent-outcome surface.
 *
 * The `/api/pipeline.intent-outcome` endpoint synthesizes the entire
 * pipeline + post-dispatch chain into one aggregated "intent state"
 * the operator can read at a glance without scrolling. The card sits
 * above the stage strip on /pipelines/<id>; this types module is a
 * sibling to `pipelines-types.ts` + `pipeline-lifecycle-types.ts` so
 * the frontend service can import these shapes verbatim without
 * dragging the synthesis logic into the browser bundle.
 *
 * Read-only contract: every field is derived from atoms on disk.
 */

/**
 * Narrow atom shape the synthesizer consumes. Mirrors
 * `PipelineLifecycleSourceAtom` and `PipelineSourceAtom` so the
 * synthesizer can re-use both projection helpers without an extra
 * downcast layer.
 */
export interface IntentOutcomeSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly layer?: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly expires_at?: string | null;
  readonly pipeline_state?: string;
}

/**
 * Aggregated intent state. The TRUE-outcome semantics are baked into
 * the synthesizer: `intent-fulfilled` requires a real merged PR (NOT
 * plan_state alone); `intent-dispatch-failed` covers both dispatched=0
 * AND all PRs closed without merge.
 *
 *   - intent-fulfilled                    -- merged PR for this intent
 *   - intent-dispatched-pending-review    -- PR open, awaiting CR / merge
 *                                              (observation is fresh)
 *   - intent-dispatched-observation-stale -- PR observation older than
 *                                              the staleness threshold;
 *                                              the synthesizer refuses to
 *                                              authoritatively claim
 *                                              'pending review' because
 *                                              the observation may have
 *                                              fallen out of date with
 *                                              GitHub (e.g. the PR merged
 *                                              before the refresh tick
 *                                              caught up). Pulse counts
 *                                              this as a separate bucket
 *                                              (NOT 'awaiting merge') so
 *                                              the tile doesn't inflate
 *                                              on a stale store.
 *   - intent-dispatch-failed              -- dispatched=0 OR all PRs closed unmerged
 *   - intent-paused                       -- HIL pause at any stage
 *   - intent-running                      -- pipeline mid-execution
 *   - intent-abandoned                    -- operator-set or expired
 *   - intent-unknown                      -- no signal yet (early start)
 */
export type IntentOutcomeState =
  | 'intent-fulfilled'
  | 'intent-dispatched-pending-review'
  | 'intent-dispatched-observation-stale'
  | 'intent-dispatch-failed'
  | 'intent-paused'
  | 'intent-running'
  | 'intent-abandoned'
  | 'intent-unknown';

/**
 * Skip-reason a dispatcher reports when dispatched=0. Surfaced in the
 * card so the operator sees the cause inline (envelope mismatch, plan
 * confidence too low, etc) instead of having to grep dispatch-record.
 */
export interface IntentOutcomeSkipReason {
  readonly reason: string;
  readonly source: 'dispatch-record' | 'plan-dispatch-result' | 'code-author';
}

/**
 * `/api/pipeline.intent-outcome` payload.
 *
 * Every optional field is null when the corresponding atom is not yet
 * in the chain. The card renders progressively: state always present,
 * pr_url + pr_merged_at land once the PR is resolved, skip_reasons
 * land when dispatch=0.
 */
export interface IntentOutcome {
  /**
   * Pipeline id this outcome was synthesized for. Echoed back so the
   * client can defend against a stale request landing after the user
   * has navigated to a different pipeline.
   */
  readonly pipeline_id: string;
  readonly state: IntentOutcomeState;
  /**
   * One-line plain-text summary safe to render directly in the card.
   * Examples:
   *   "Pipeline ran 8m, 5 stages, dispatched 1 PR, merged at 14:52Z"
   *   "Dispatched 0 PRs - envelope mismatch (blast_radius)"
   *   "Pipeline mid-execution at plan-stage"
   */
  readonly summary: string;
  /** Operator-intent atom id when resolvable; null when only dispatch-record exists. */
  readonly operator_intent_atom_id: string | null;
  /** Pipeline atom id when present; null when only the dispatch-record was found. */
  readonly pipeline_atom_id: string | null;
  /** Mode the pipeline ran in (single-pass / substrate-deep / etc), null when unknown. */
  readonly mode: string | null;
  /** Pipeline title (carries through from pipelines.detail), null when unknown. */
  readonly title: string | null;
  /** Number of pipeline stages observed; 0 when no stage events recorded. */
  readonly stage_count: number;
  /** Number of stages that reached `succeeded` or `failed`. */
  readonly stage_completed_count: number;
  /** Total pipeline run-time in ms (sum of stage durations). 0 when no events. */
  readonly total_duration_ms: number;
  /** Time elapsed since the operator-intent atom landed, in ms. 0 when intent unknown. */
  readonly time_elapsed_ms: number;
  /** Number of PRs the dispatcher reports it actually opened. */
  readonly dispatched_count: number;
  /** PR number if a code-author invocation produced one. */
  readonly pr_number: number | null;
  /** PR HTML URL for the GitHub link. */
  readonly pr_url: string | null;
  /** PR title from the latest pr-observation. */
  readonly pr_title: string | null;
  /** PR merge commit SHA. */
  readonly merge_commit_sha: string | null;
  /** When the merge was observed/settled. */
  readonly pr_merged_at: string | null;
  /** Skip reasons surfaced when dispatch_count==0. Empty array when irrelevant. */
  readonly skip_reasons: ReadonlyArray<IntentOutcomeSkipReason>;
  /** ISO timestamp the synthesis ran at. */
  readonly computed_at: string;
}
