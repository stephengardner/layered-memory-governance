/**
 * Wire-shape definitions for the operator-actions audit-trail surface.
 *
 * Mirrored separately from the projection helper so the frontend
 * service can import the types verbatim (sibling to `pipelines-types.ts`,
 * `resume-audit-types.ts`, `live-ops-types.ts`) without dragging the
 * server-side helper code into the browser bundle.
 *
 * Contract: every endpoint returns derived projections over the
 * `operator-action` atom prefix (id prefix `op-action-`). The atoms
 * themselves stay on disk per `arch-atomstore-source-of-truth`; this
 * surface is read-only and write-side substrate work (gh-as.mjs,
 * git-as.mjs, cr-trigger.mjs, resolve-outdated-threads.mjs) is what
 * mints the source atoms.
 */

/**
 * Narrow atom shape the helpers consume. Mirrors the in-server Atom
 * interface and the `PipelineSourceAtom` / `ResumeAuditSourceAtom`
 * shapes so the operator-actions helpers stay decoupled from
 * server/index.ts (no cyclic import risk).
 */
export interface OperatorActionSourceAtom {
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
 * Coarse-grained action types the dashboard surfaces as filter chips.
 * Derived from `metadata.operator_action.args` by inspecting the gh
 * subcommand shape and (for `gh api` calls) the path slug.
 *
 * The classifier (see `operator-actions.ts:classifyOperatorAction`)
 * maps every recorded operator-action atom to one of these values;
 * unrecognized shapes collapse to `'other'` so a future gh subcommand
 * lands as filterable rather than crashing the projection.
 */
export type OperatorActionKind =
  | 'pr-create'
  | 'pr-merge'
  | 'pr-comment'
  | 'pr-edit'
  | 'pr-close'
  | 'pr-ready'
  | 'pr-review'
  | 'issue-create'
  | 'issue-comment'
  | 'issue-edit'
  | 'issue-close'
  | 'review-thread-resolve'
  | 'label'
  | 'release'
  | 'workflow'
  | 'repo-mutation'
  | 'api-write'
  | 'other';

/**
 * One row in the operator-actions list. Mirrors the
 * `metadata.operator_action` payload that `gh-as.mjs` writes plus the
 * derived `action_type` classifier output.
 *
 * `target` is a derived human-friendly target string (e.g. `PR #384`,
 * `issue #335`, `branch feat/x`). Falls back to the raw subcommand
 * shape when the classifier cannot extract a numeric or named target,
 * so the row always carries SOME context to anchor the operator's eye.
 */
export interface OperatorActionRow {
  readonly atom_id: string;
  readonly created_at: string;
  readonly actor: string;
  readonly action_type: OperatorActionKind;
  readonly subcommand: string;
  readonly target: string | null;
  readonly args_preview: string;
  readonly session_id: string | null;
}

/**
 * Wire-shape returned by `/api/operator-actions.list`. The `filtered`
 * count is the row count after applying optional `actor` /
 * `action_type` filters; `total` is the unfiltered count over the
 * same window so the UI can show "showing 50 of 1396" deterministically.
 *
 * `actor_facets` and `action_type_facets` are pre-computed bucket
 * counts over the unfiltered window so the filter-chip labels can
 * carry their own counts ("lag-ceo (1396)") without a second request
 * per chip.
 */
export interface OperatorActionsListResponse {
  readonly rows: ReadonlyArray<OperatorActionRow>;
  readonly total: number;
  readonly filtered: number;
  readonly actor_facets: ReadonlyArray<{ readonly actor: string; readonly count: number }>;
  readonly action_type_facets: ReadonlyArray<{ readonly action_type: OperatorActionKind; readonly count: number }>;
  readonly generated_at: string;
}

/**
 * Hard cap on rows returned per list endpoint. Defends against a
 * misconfigured client polling for the entire 1400-atom op-action set
 * every 5s; matches the bound used by `actor-activity` and
 * `resume-audit` (`*_MAX_LIST_ITEMS`).
 */
export const OPERATOR_ACTIONS_MAX_LIST_ITEMS = 500;
export const OPERATOR_ACTIONS_DEFAULT_LIMIT = 100;
