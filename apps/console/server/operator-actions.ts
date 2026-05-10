/**
 * Pure helpers for the operator-actions audit-trail dashboard.
 *
 * Reads `operator-action` atoms (id prefix `op-action-`) from a flat
 * atom array and projects them into the wire shape the dashboard
 * consumes.
 *
 * The source atoms are written by `gh-as.mjs` (and future
 * `git-as.mjs`, `cr-trigger.mjs`, `resolve-outdated-threads.mjs`
 * counterparts) whenever a bot-identity-mediated GitHub action runs.
 * Each atom carries `metadata.operator_action.args` which is the
 * exact argv passed to `gh`; this projection classifies that argv
 * into a coarse `action_type` so the dashboard can filter without
 * the operator having to parse argv shapes mentally.
 *
 * Design constraints baked into this module (mirrors `live-ops.ts`,
 * `pipelines.ts`, `resume-audit.ts`):
 *   - Pure functions, no I/O. The handler in server/index.ts feeds
 *     this module the full atom array.
 *   - Read-only by construction.
 *   - Bounded payload caps (DoS defense).
 *   - UTC ISO timestamps assumed.
 *   - Deterministic against a pinned `now` so window-boundary
 *     assertions stay stable across machines.
 */

import type {
  OperatorActionKind,
  OperatorActionRow,
  OperatorActionsListResponse,
  OperatorActionSourceAtom,
} from './operator-actions-types.js';
import {
  OPERATOR_ACTIONS_DEFAULT_LIMIT,
  OPERATOR_ACTIONS_MAX_LIST_ITEMS,
} from './operator-actions-types.js';

function parseIsoTs(value: string | undefined | null): number {
  if (typeof value !== 'string' || value.length === 0) return NaN;
  return Date.parse(value);
}

function isCleanLive(atom: OperatorActionSourceAtom): boolean {
  // Mirrors `pipelines.ts:isCleanLive` and `resume-audit.ts:isCleanLive`.
  // Well-formed atoms carry `taint: 'clean'` (truthy); only non-clean
  // taint or a present superseded_by chain should drop the row.
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

function readActionMeta(
  atom: OperatorActionSourceAtom,
): Readonly<Record<string, unknown>> | null {
  const meta = atom.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const inner = (meta as Record<string, unknown>)['operator_action'];
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  return inner as Readonly<Record<string, unknown>>;
}

function readArgs(actionMeta: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
  const raw = actionMeta['args'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === 'string');
}

function readSessionId(actionMeta: Readonly<Record<string, unknown>>): string | null {
  const raw = actionMeta['session_id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Classify a gh argv into a coarse `OperatorActionKind`. Pure: same
 * input -> same output. Unknown shapes collapse to `'other'` so the
 * UI surfaces them in a discoverable bucket rather than crashing.
 *
 * The mapping mirrors `gh-classify-write.mjs` MUTATING_SUBCOMMANDS +
 * NAMESPACES_WITH_MUTATIONS sets but a step coarser: rather than
 * binary write-vs-read (the classifier's job at write-gating time),
 * the dashboard wants categories like "pr-create" / "pr-merge" so an
 * operator can scan recent merges at a glance.
 */
export function classifyOperatorAction(args: ReadonlyArray<string>): OperatorActionKind {
  if (args.length === 0) return 'other';
  const verb = args[0];
  const sub = args[1] ?? '';

  if (verb === 'pr') {
    switch (sub) {
      case 'create': return 'pr-create';
      case 'merge': return 'pr-merge';
      case 'comment': return 'pr-comment';
      case 'edit': return 'pr-edit';
      case 'close': return 'pr-close';
      case 'reopen': return 'pr-edit';
      case 'ready': return 'pr-ready';
      case 'review': return 'pr-review';
      default: return 'other';
    }
  }

  if (verb === 'issue') {
    switch (sub) {
      case 'create': return 'issue-create';
      case 'comment': return 'issue-comment';
      case 'edit': return 'issue-edit';
      case 'close': return 'issue-close';
      case 'reopen': return 'issue-edit';
      default: return 'other';
    }
  }

  if (verb === 'label') return 'label';
  if (verb === 'release') return 'release';
  if (verb === 'workflow') return 'workflow';
  if (verb === 'repo') return 'repo-mutation';

  if (verb === 'api') {
    // `gh api` is the catch-all; the dashboard surfaces a few specific
    // shapes the substrate writes:
    //   - graphql with resolveReviewThread mutation -> review-thread-resolve
    //   - graphql with addPullRequestReview, addComment, mergePullRequest etc -> pr-* equivalents
    //   - REST endpoints touching issues/<n>/labels -> label
    //   - everything else (POST/PATCH/DELETE that reached this projection
    //     by the write classifier) -> api-write
    if (sub === 'graphql') {
      const queryText = args.join(' ').toLowerCase();
      if (queryText.includes('resolvereviewthread')) return 'review-thread-resolve';
      if (queryText.includes('addpullrequestreview')) return 'pr-review';
      if (queryText.includes('addcomment')) return 'pr-comment';
      if (queryText.includes('mergepullrequest')) return 'pr-merge';
    }
    // REST shape with /issues/<n>/labels suffix.
    if (typeof sub === 'string' && /\/issues\/\d+\/labels/.test(sub)) return 'label';
    return 'api-write';
  }

  return 'other';
}

/**
 * Derive a human-friendly target string from gh argv. Examples:
 *   ['pr', 'merge', '384', '--squash']        -> 'PR #384'
 *   ['pr', 'create', '--title', 'feat: ...']  -> null (title's the target context, not a number)
 *   ['issue', 'comment', '335']               -> 'issue #335'
 *   ['api', 'repos/o/r/issues/335/labels']    -> 'issue #335 labels'
 *   ['label', 'create', 'autonomous-intent']  -> 'label autonomous-intent'
 *
 * Returns null when no useful target can be extracted; the row still
 * carries the subcommand + args_preview so the operator has SOMETHING
 * to anchor on.
 */
export function deriveTarget(args: ReadonlyArray<string>): string | null {
  if (args.length === 0) return null;
  const verb = args[0];
  const sub = args[1] ?? '';

  // pr <sub> <number>
  if (verb === 'pr' && (sub === 'merge' || sub === 'comment' || sub === 'edit' || sub === 'close' || sub === 'reopen' || sub === 'ready' || sub === 'review' || sub === 'view')) {
    const maybeNum = args[2];
    if (typeof maybeNum === 'string' && /^\d+$/.test(maybeNum)) return `PR #${maybeNum}`;
  }

  // pr create — surface the --title (operator sees what was opened)
  if (verb === 'pr' && sub === 'create') {
    const titleIdx = args.findIndex((a) => a === '--title' || a === '-t');
    if (titleIdx >= 0 && titleIdx + 1 < args.length) {
      const title = args[titleIdx + 1]!;
      // Trim to a reasonable length so the table doesn't wrap forever.
      return title.length > 60 ? title.slice(0, 57) + '...' : title;
    }
    return 'new PR';
  }

  // issue <sub> <number>
  if (verb === 'issue' && (sub === 'comment' || sub === 'edit' || sub === 'close' || sub === 'reopen' || sub === 'view')) {
    const maybeNum = args[2];
    if (typeof maybeNum === 'string' && /^\d+$/.test(maybeNum)) return `issue #${maybeNum}`;
  }

  // api graphql — extract the most-visible subject if possible.
  if (verb === 'api' && sub === 'graphql') {
    // Look for `pullRequest(number: N` in the query text.
    const queryText = args.join(' ');
    const prMatch = queryText.match(/pullRequest\s*\(\s*number\s*:\s*(\d+)/);
    if (prMatch) return `PR #${prMatch[1]}`;
    const issueMatch = queryText.match(/issue\s*\(\s*number\s*:\s*(\d+)/);
    if (issueMatch) return `issue #${issueMatch[1]}`;
    return 'graphql mutation';
  }

  // api repos/.../issues/N/...
  if (verb === 'api' && typeof sub === 'string') {
    const issuesMatch = sub.match(/\/issues\/(\d+)/);
    if (issuesMatch) return `issue #${issuesMatch[1]}`;
    const pullsMatch = sub.match(/\/pulls\/(\d+)/);
    if (pullsMatch) return `PR #${pullsMatch[1]}`;
  }

  // label create / delete / edit
  if (verb === 'label' && args.length >= 3) {
    return `label ${args[2]}`;
  }

  return null;
}

/**
 * Build a short, single-line preview of the argv for display. The full
 * argv is preserved on the source atom; this is for at-a-glance scan in
 * the table row.
 */
export function deriveArgsPreview(args: ReadonlyArray<string>): string {
  // Join the first few tokens with spaces; clip the rest.
  const joined = args.join(' ');
  return joined.length > 140 ? joined.slice(0, 137) + '...' : joined;
}

/**
 * Clamp the operator-supplied limit to the supported range. Default
 * is `OPERATOR_ACTIONS_DEFAULT_LIMIT`; values above
 * `OPERATOR_ACTIONS_MAX_LIST_ITEMS` are silently clamped to defend
 * against a misconfigured client polling for the whole store.
 */
export function clampLimit(requested: number | null | undefined): number {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) {
    return OPERATOR_ACTIONS_DEFAULT_LIMIT;
  }
  if (requested < 1) return 1;
  if (requested > OPERATOR_ACTIONS_MAX_LIST_ITEMS) return OPERATOR_ACTIONS_MAX_LIST_ITEMS;
  return Math.floor(requested);
}

/**
 * Project a single source atom into the dashboard row shape. Returns
 * null on atoms that don't carry the expected
 * `metadata.operator_action` envelope (defensive against partial
 * writes / forward-compat changes to the wrapper).
 */
function projectRow(atom: OperatorActionSourceAtom): OperatorActionRow | null {
  const meta = readActionMeta(atom);
  if (!meta) return null;
  const args = readArgs(meta);
  const subcommand = args[0] ? `${args[0]} ${args[1] ?? ''}`.trim() : '(empty)';
  const actor = atom.principal_id || 'unknown';
  return {
    atom_id: atom.id,
    created_at: atom.created_at,
    actor,
    action_type: classifyOperatorAction(args),
    subcommand,
    target: deriveTarget(args),
    args_preview: deriveArgsPreview(args),
    session_id: readSessionId(meta),
  };
}

/**
 * Build the list projection. Filters by optional `actor` and
 * `action_type`, returns rows in `created_at DESC` order, and folds
 * facet counts over the unfiltered window so the UI can render
 * chip-level counts without a second request.
 *
 * `total` is the count over all operator-action atoms (before any
 * filter); `filtered` is the count after `actor` + `action_type`.
 * Both are computed before the limit-slice so a paged view can show
 * "showing 100 of 472" even when the limit truncates the array.
 */
export function listOperatorActions(
  atoms: ReadonlyArray<OperatorActionSourceAtom>,
  now: number,
  options: {
    readonly limit?: number;
    readonly actor?: string | null;
    readonly actionType?: OperatorActionKind | null;
  } = {},
): OperatorActionsListResponse {
  const effectiveLimit = clampLimit(options.limit ?? OPERATOR_ACTIONS_DEFAULT_LIMIT);
  const actorFilter = options.actor && options.actor.length > 0 ? options.actor : null;
  const typeFilter = options.actionType && options.actionType.length > 0 ? options.actionType : null;

  // Single pass over the atom array: project, classify, facet, filter.
  const allRows: OperatorActionRow[] = [];
  const actorBuckets = new Map<string, number>();
  const typeBuckets = new Map<OperatorActionKind, number>();

  for (const atom of atoms) {
    if (atom.type !== 'observation' || !isCleanLive(atom)) continue;
    if (!atom.id.startsWith('op-action-')) continue;
    const row = projectRow(atom);
    if (!row) continue;
    allRows.push(row);
    actorBuckets.set(row.actor, (actorBuckets.get(row.actor) ?? 0) + 1);
    typeBuckets.set(row.action_type, (typeBuckets.get(row.action_type) ?? 0) + 1);
  }

  // Apply filters AFTER facet computation so the chip counts reflect
  // the full universe (operator sees "lag-ceo (1396)" even when the
  // current view is filtered down to a single chip).
  const filteredRows = allRows.filter((r) => {
    if (actorFilter !== null && r.actor !== actorFilter) return false;
    if (typeFilter !== null && r.action_type !== typeFilter) return false;
    return true;
  });

  filteredRows.sort((a, b) => {
    const tb = parseIsoTs(b.created_at);
    const ta = parseIsoTs(a.created_at);
    if (tb !== ta) return tb - ta;
    return a.atom_id.localeCompare(b.atom_id);
  });

  // Facet sort: count DESC, then key ASC for determinism.
  const actorFacets = Array.from(actorBuckets.entries())
    .map(([actor, count]) => ({ actor, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.actor.localeCompare(b.actor);
    });
  const actionTypeFacets = Array.from(typeBuckets.entries())
    .map(([action_type, count]) => ({ action_type, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.action_type.localeCompare(b.action_type);
    });

  return {
    rows: filteredRows.slice(0, effectiveLimit),
    total: allRows.length,
    filtered: filteredRows.length,
    actor_facets: actorFacets,
    action_type_facets: actionTypeFacets,
    generated_at: new Date(now).toISOString(),
  };
}
