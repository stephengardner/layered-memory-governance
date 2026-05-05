/**
 * Wire-shape definitions for the pipeline post-dispatch lifecycle.
 *
 * The /api/pipelines.lifecycle surface stitches the chain of atoms
 * downstream of dispatch-stage so the operator sees the full
 * intent-to-merge picture without re-grepping the atom store. This
 * file holds ONLY the types so the frontend service can import them
 * verbatim without dragging the projection logic into the bundle:
 * sibling to pipelines-types.ts.
 *
 * Read-only contract.
 */

/**
 * Narrow atom shape the projection consumes. Mirrors the in-server
 * Atom interface but elides fields the lifecycle helpers do not
 * touch (confidence, signals, scope, layer, expires_at). Same
 * pattern PipelineSourceAtom uses for the pipelines projection so
 * the two helpers can share the downcast in handler code.
 */
export interface PipelineLifecycleSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
}

/**
 * Per-state check-run counts parsed from a pr-observation atom's
 * content text. The substrate emits per-check states only inside
 * the human-readable content today; once a structured field is
 * added, the parser falls back to it transparently.
 *
 * Buckets:
 *   - green   : success, neutral, skipped
 *   - red     : failure, timed_out, cancelled, action_required
 *   - pending : queued, in_progress, anything unrecognized
 *
 * `total` matches the atom metadata.counts.check_runs when both are
 * available; we still expose it on this object so the UI doesn't
 * have to read two fields.
 */
export interface PipelineLifecycleCheckCounts {
  readonly total: number;
  readonly green: number;
  readonly red: number;
  readonly pending: number;
}

/**
 * Outcome of the dispatch-stage as recorded by the planning-pipeline
 * substrate. `failed > 0` indicates the dispatcher attempted to invoke
 * the sub-actor but the executor halted upstream of opening a PR; the
 * `error_message` field is filled from the plan's metadata.dispatch_result
 * when present so the operator sees the cause inline.
 */
export interface PipelineLifecycleDispatchRecord {
  readonly atom_id: string;
  readonly pipeline_id: string;
  readonly dispatch_status: string | null;
  readonly scanned: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly cost_usd: number;
  /** Pulled from plan.metadata.dispatch_result.message when failed > 0. */
  readonly error_message: string | null;
  readonly at: string;
}

/**
 * Code-author-invoked observation. The executor writes one per
 * dispatch with `kind: 'dispatched'` (PR opened) or `kind: 'error'`
 * (silent-skip with reason + stage). The UI distinguishes the two
 * states without re-fetching the atom.
 */
export interface PipelineLifecycleCodeAuthorInvocation {
  readonly atom_id: string;
  readonly plan_id: string;
  readonly correlation_id: string | null;
  readonly kind: 'dispatched' | 'error' | null;
  readonly pr_number: number | null;
  readonly pr_html_url: string | null;
  readonly branch_name: string | null;
  readonly commit_sha: string | null;
  /** Set only on `kind === 'error'`. */
  readonly reason: string | null;
  /** Set only on `kind === 'error'`. */
  readonly stage: string | null;
  readonly at: string;
}

/**
 * Latest pr-observation snapshot. Captures CI + CR + merge-state in
 * one shape. The CR verdict (approved / has-findings / pending /
 * missing) is NOT a metadata field on the atom; the UI derives it
 * from the counts here. Rationale lives in PipelineLifecycle.tsx.
 */
export interface PipelineLifecycleObservation {
  readonly atom_id: string;
  readonly plan_id: string;
  readonly pr_number: number | null;
  /** OPEN | CLOSED | MERGED -- mirrors the GitHub PR state machine. */
  readonly pr_state: string | null;
  readonly pr_title: string | null;
  readonly head_sha: string | null;
  readonly mergeable: boolean | null;
  /** BEHIND | DIRTY | BLOCKED | UNSTABLE | CLEAN | UNKNOWN. */
  readonly merge_state_status: string | null;
  readonly observed_at: string;
  readonly submitted_reviews: number;
  readonly line_comments: number;
  readonly body_nits: number;
  /** Total legacy-status entries reported by the substrate. */
  readonly legacy_statuses: number;
  /**
   * Count of legacy statuses in a red conclusion (failure / error /
   * cancelled). The legacy `CodeRabbit` status posts here; if it
   * fails, this is the load-bearing signal that the merge gate is
   * blocked. Parsed from the pr-observation content text the same
   * way check-runs are parsed.
   */
  readonly legacy_statuses_red: number;
  readonly check_counts: PipelineLifecycleCheckCounts;
}

/**
 * Merge record. Sourced from plan-merge-settled when present, else
 * synthesized from a pr-observation reporting pr_state=MERGED.
 * `merge_commit_sha` is the head_sha at the time of merge (the
 * settled atom does not currently carry the commit independently).
 */
export interface PipelineLifecycleMerge {
  /** Null when the row was synthesized from a pr-observation rather than a settled atom. */
  readonly atom_id: string | null;
  readonly plan_id: string;
  /** Always 'MERGED' when this block exists. */
  readonly pr_state: string | null;
  /** 'succeeded' / 'failed' / null. */
  readonly target_plan_state: string | null;
  readonly merge_commit_sha: string | null;
  readonly settled_at: string;
  /** Null when synthesized from a pr-observation (no signing principal). */
  readonly merger_principal_id: string | null;
}

/**
 * /api/pipelines.lifecycle response envelope.
 *
 * Every block is independently nullable so the UI renders progressively:
 * the dispatch outcome lands first, then the code-author invocation,
 * then the PR observation, then the merge row. A pipeline that hasn't
 * crossed dispatch yet returns dispatch_record=null and every
 * downstream field=null.
 */
export interface PipelineLifecycle {
  readonly pipeline_id: string;
  readonly plan_id: string | null;
  readonly dispatch_record: PipelineLifecycleDispatchRecord | null;
  readonly code_author_invoked: PipelineLifecycleCodeAuthorInvocation | null;
  readonly observation: PipelineLifecycleObservation | null;
  readonly merge: PipelineLifecycleMerge | null;
}
