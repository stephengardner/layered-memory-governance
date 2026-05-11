/**
 * Wire-shape definitions for the pipeline error-state UX surface.
 *
 * The `/api/pipeline.error-state` endpoint categorizes a pipeline's
 * terminal failure (or kill-switch halt, or operator abandonment) into
 * a typed shape the Console can render with a category-specific
 * recovery suggestion + quick-action buttons. Sibling to
 * `pipelines-types.ts` and `intent-outcome-types.ts` so the frontend
 * service imports these shapes verbatim without dragging the helper
 * code into the browser bundle.
 *
 * Read-only contract: every field is derived from atoms already on
 * disk (pipeline atom + pipeline-failed atom + audit findings). No
 * mutation, no resume-trigger -- those flow through existing CLIs per
 * apps/console/CLAUDE.md.
 *
 * Why a typed category rather than free-text:
 *   - Operators need to act, not read. A category drives the recovery
 *     suggestion + the quick-action set; "see atom for raw failure" is
 *     the fall-through, not the headline.
 *   - The substrate's `cause` field is a free-form string that the
 *     runner builds at fail time. Categorization is the projection's
 *     job: parse the string for known prefixes and map to a stable
 *     category enum the UI can switch on.
 */

import type { PipelineSourceAtom } from './pipelines-types.js';

/**
 * Source atom shape consumed by the error-state helper. Identical to
 * `PipelineSourceAtom` so the synthesizer can reuse the same atom-set
 * the pipelines projection already walks; aliased here as a named
 * export so a future divergence (e.g. additional fields the
 * synthesizer needs but the list projection doesn't) lands cleanly.
 */
export type PipelineErrorStateSourceAtom = PipelineSourceAtom;

/**
 * Severity bucket for the error-state card. Drives the surface tone
 * (danger / warning / info) the UI applies to the category badge.
 *
 *   - 'critical' : pipeline cannot proceed without operator action
 *     (budget cap exceeded, critical audit finding, schema mismatch)
 *   - 'warning'  : pipeline halted by an external signal that the
 *     operator can typically clear with a focused action (kill switch,
 *     abandonment)
 *   - 'info'     : surface exists but no action is required from the
 *     operator (e.g. an uncategorized stage-thrown error rendered as a
 *     raw cause so the operator can still inspect)
 */
export type PipelineErrorSeverity = 'critical' | 'warning' | 'info';

/**
 * Categorized failure modes. Each value maps to a recovery suggestion
 * the UI renders inline below the category badge. New categories are
 * additive: a downstream stage that introduces a new known failure
 * shape lands here + adds a `categorizeStageFailure` branch, and the
 * UI inherits the new bucket without coordinated client work because
 * the suggested-action string is server-rendered.
 *
 * Ordering of the union is preserved as the canonical priority for
 * the categorizer when more than one signal applies (e.g. a critical
 * audit finding lands before a generic stage-threw because the
 * finding is the more actionable diagnosis).
 */
export type PipelineErrorCategory =
  | 'budget-exceeded'
  | 'pipeline-cost-overflow'
  | 'schema-mismatch'
  | 'critical-audit-finding'
  | 'plan-author-confabulation'
  | 'unknown-stage'
  | 'kill-switch-halted'
  | 'operator-abandoned'
  | 'stage-output-persist-failed'
  | 'stage-threw'
  | 'uncategorized';

/**
 * Quick-action descriptor surfaced as a button beneath the recovery
 * suggestion. The `kind` drives the button's render + click behavior;
 * the `label` is the localized human string the operator sees.
 *
 *   - 'view-atom'     : opens the AtomRef drawer for `atom_id`. The
 *     atom_id is the pipeline-failed atom by default, or a category-
 *     specific atom (the cited finding for critical-audit-finding,
 *     the policy atom for budget-exceeded, etc).
 *   - 'view-canon'    : navigates to the canon viewer scoped to the
 *     directive cited by the category, with `canon_id` carrying the
 *     directive id.
 *   - 'view-policy'   : navigates to the AtomRef viewer for a policy
 *     atom (e.g. pol-pipeline-stage-cost-cap when the cap was the
 *     trigger). `atom_id` carries the policy atom id.
 *   - 'view-output'   : opens the failed stage's output atom (when
 *     persisted) so the operator can read the exact payload the
 *     substrate rejected. `atom_id` carries the stage-output atom id.
 *   - 'abandon'       : surfaces the abandon-pipeline modal so the
 *     operator can mark the pipeline non-recoverable with a written
 *     reason. Always available regardless of category.
 *
 * Note: 'resume-from-stage' is NOT in the v1 quick-action set. The
 * Resume affordance lives on the individual paused stage card today;
 * a pipeline-wide resume-from-failure flow is a separate substrate
 * surface (lands once `runResumeFromStage` exposes its trigger). The
 * action enum is forward-compatible: a future v2 adds it without a
 * wire break.
 */
export type PipelineErrorActionKind =
  | 'view-atom'
  | 'view-canon'
  | 'view-policy'
  | 'view-output'
  | 'abandon';

export interface PipelineErrorAction {
  readonly kind: PipelineErrorActionKind;
  readonly label: string;
  /** Atom id the action navigates to, when applicable. Null for abandon. */
  readonly atom_id: string | null;
  /** Canon directive id the action navigates to (view-canon only). Null otherwise. */
  readonly canon_id: string | null;
}

/**
 * `/api/pipeline.error-state` payload. Returned when a pipeline is in
 * one of the "needs operator attention" terminal/halt states. For a
 * still-running or cleanly-succeeded pipeline the server returns
 * `state: 'ok'` with `category: null` so the client can render the
 * absence of an error block uniformly (rather than 404'ing on the
 * happy path).
 *
 * Field ordering preserved as documentation of consumption flow: the
 * client reads `state` first to decide whether to render the block,
 * then the category badge + suggested action + action buttons.
 */
export interface PipelineErrorState {
  /** Pipeline id this error-state was synthesized for. Echoed back. */
  readonly pipeline_id: string;
  /**
   * Top-level state pill the block renders. 'ok' means no error block
   * is shown; any other value renders the block expanded by default.
   */
  readonly state:
    | 'ok'
    | 'failed'
    | 'halted'
    | 'abandoned';
  /** Severity bucket driving the badge tone. Null when state='ok'. */
  readonly severity: PipelineErrorSeverity | null;
  /** Categorized failure mode. Null when state='ok'. */
  readonly category: PipelineErrorCategory | null;
  /** Human-readable title for the category badge. e.g. "Budget exceeded". */
  readonly category_label: string | null;
  /**
   * One- to two-sentence suggested-action string the operator reads
   * inline. Server-rendered so future categories land without
   * coordinated client work. Null when state='ok'.
   */
  readonly suggested_action: string | null;
  /**
   * Verbatim `cause` string from the pipeline-failed atom (or
   * substrate-level halt reason). Surfaced under a "Raw cause"
   * disclosure so the operator can always reach the substrate
   * string even when the categorizer doesn't recognize it. Null when
   * no failure atom exists yet (e.g. halted before failPipeline ran).
   */
  readonly raw_cause: string | null;
  /** Name of the stage that failed/halted; null when not stage-scoped. */
  readonly failed_stage_name: string | null;
  /** Ordinal index of the failed stage; null when not stage-scoped. */
  readonly failed_stage_index: number | null;
  /** Atom id chain from pipeline-failed.chain, capped at 32 by the substrate. */
  readonly cited_atom_ids: ReadonlyArray<string>;
  /** Action buttons the UI renders below the suggested-action. */
  readonly actions: ReadonlyArray<PipelineErrorAction>;
  /** ISO timestamp the synthesis ran at. */
  readonly computed_at: string;
}
