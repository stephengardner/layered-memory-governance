import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import {
  setRoute,
  setRouteQuery,
  useRouteQuery,
  routeHref,
  type Route,
} from '@/state/router.store';
import { toErrorMessage } from '@/services/errors';
import {
  isOperatorActionKind,
  listOperatorActions,
  type OperatorActionKind,
  type OperatorActionRow,
  type OperatorActionsListResponse,
} from '@/services/operator-actions.service';
import { formatRelative } from '@/features/pipelines-viewer/PipelinesView';
import styles from './OperatorActionsView.module.css';

/**
 * Operator-actions audit-trail dashboard.
 *
 * Reverse-chronological projection of every `operator-action` atom
 * (id prefix `op-action-`) written by the substrate's bot-identity
 * wrappers: `gh-as.mjs` (PR open/merge/comment, label, release,
 * workflow, repo mutations), `cr-trigger.mjs` (machine-user CR
 * triggers; future), `resolve-outdated-threads.mjs` (review-thread
 * resolution), plus any future `git-as.mjs` wrapper that mints
 * operator-action atoms on signed commit/push.
 *
 * Operator value: instead of `grep .lag/atoms/op-action-*.json | jq`,
 * the operator sees who did what in the last hour at a glance, with
 * actor + action-type filter chips for narrowing.
 *
 * Mobile-first per canon `dev-web-mobile-first-required`: each row is
 * stacked-card shaped on narrow viewports, becomes tabular at >=60rem.
 * Touch targets meet the 44px floor (chip min-height, row min-height).
 *
 * URL-driven filters per canon `dev-web-routing-state-not-component-
 * state-for-filters`: `?actor=lag-ceo&action_type=pr-merge` survives
 * refresh and is shareable as a deep link.
 *
 * Read-only contract: every call is a query; the substrate writes the
 * source atoms, this UI observes.
 */

const ACTOR_QUERY_KEY = 'actor';
const ACTION_TYPE_QUERY_KEY = 'action_type';
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 100;

/**
 * Module-scoped relative-time formatter. Single instance reused across
 * the 1-second tick on the LastRefreshedIndicator so each tick pays
 * only the formatter call. Mirrors `ResumeAuditView`.
 */
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

function isPlainLeftClick(e: MouseEvent): boolean {
  if (e.defaultPrevented) return false;
  if (e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return true;
}

/**
 * Coarse tone-class mapping for the action-type chip. Write actions
 * (pr-merge, pr-create, issue-create, etc.) read as "warm" so they
 * pop in the row; reads / label / release / api-write stay neutral.
 *
 * Falls back to `''` when no specific tone matches; the chip renders
 * with the base neutral palette. Future kinds added to the
 * `OperatorActionKind` union land in `'other'` until an explicit tone
 * gets wired here.
 */
function actionTypeToneClass(kind: OperatorActionKind): string {
  switch (kind) {
    case 'pr-merge':
    case 'pr-create':
    case 'issue-create':
    case 'release':
      return styles.toneWarm ?? '';
    case 'pr-close':
    case 'issue-close':
      return styles.toneCool ?? '';
    default:
      return '';
  }
}

export function OperatorActionsView() {
  const routeQuery = useRouteQuery();
  const actor = routeQuery.get(ACTOR_QUERY_KEY) ?? null;
  /*
   * Guard the deep-link value against the OperatorActionKind union
   * before threading it into the query key + request payload. A
   * malformed URL (`?action_type=foo`) would otherwise produce an
   * avoidable error state on first paint; here it silently falls
   * back to "no filter" while the chip UI still lets the operator
   * pick a real value.
   */
  const rawActionType = routeQuery.get(ACTION_TYPE_QUERY_KEY);
  const actionType: OperatorActionKind | null = isOperatorActionKind(rawActionType)
    ? rawActionType
    : null;

  const query = useQuery({
    queryKey: ['operator-actions', { actor, actionType, limit: DEFAULT_LIMIT }],
    queryFn: ({ signal }) => listOperatorActions(
      { limit: DEFAULT_LIMIT, actor, actionType },
      signal,
    ),
    refetchInterval: POLL_INTERVAL_MS,
  });

  /*
   * Last-refreshed tick mirrors resume-audit's pattern. Reset by:
   *   - explicit Refresh click (set to now)
   *   - filter chip change (URL key flip triggers query refetch)
   *   - auto-poll completion (folded in via dataUpdatedAt below)
   */
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(() => Date.now());

  const handleRefresh = () => {
    setLastRefreshedAt(Date.now());
    void query.refetch();
  };

  const handleActorChange = (next: string | null) => {
    setRouteQuery({ [ACTOR_QUERY_KEY]: next });
    setLastRefreshedAt(Date.now());
  };

  const handleActionTypeChange = (next: OperatorActionKind | null) => {
    setRouteQuery({ [ACTION_TYPE_QUERY_KEY]: next });
    setLastRefreshedAt(Date.now());
  };

  const handleClearAll = () => {
    setRouteQuery({
      [ACTOR_QUERY_KEY]: null,
      [ACTION_TYPE_QUERY_KEY]: null,
    });
    setLastRefreshedAt(Date.now());
  };

  const someFiltersActive = actor !== null || actionType !== null;

  return (
    <section className={styles.view} data-testid="operator-actions-view">
      <header className={styles.intro}>
        <div className={styles.introText}>
          <h2 className={styles.heroTitle}>
            <ShieldCheck size={20} strokeWidth={1.75} aria-hidden="true" />
            {' '}
            Operator actions
          </h2>
          <p className={styles.heroSubtitle}>
            Audit trail of every bot-identity-mediated GitHub action.
            Each row is one operator-action atom written by the
            substrate's `gh-as.mjs` (and peer) wrappers. Click a row
            to drill into the source atom; use filter chips to narrow
            by actor or action type.
          </p>
        </div>
        <div className={styles.refreshGroup}>
          <LastRefreshedIndicator
            lastRefreshedAt={lastRefreshedAt}
            dataUpdatedAt={query.dataUpdatedAt}
          />
          <button
            type="button"
            className={styles.chip}
            onClick={handleRefresh}
            disabled={query.isFetching}
            aria-busy={query.isFetching}
            aria-label="Refresh"
            data-testid="operator-actions-refresh"
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              data-testid={query.isFetching ? 'operator-actions-refresh-spinner' : undefined}
            />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {query.isSuccess && (
        <FilterPanel
          actor={actor}
          actionType={actionType}
          actorFacets={query.data.actor_facets}
          actionTypeFacets={query.data.action_type_facets}
          onActorChange={handleActorChange}
          onActionTypeChange={handleActionTypeChange}
          onClearAll={someFiltersActive ? handleClearAll : null}
        />
      )}

      {query.isPending && (
        <LoadingState
          label="Loading operator actions..."
          testId="operator-actions-loading"
        />
      )}
      {query.isError && (
        <ErrorState
          title="Could not load operator actions"
          message={toErrorMessage(query.error)}
          testId="operator-actions-error"
        />
      )}
      {query.isSuccess && (
        <ResultsList data={query.data} hasFilters={someFiltersActive} />
      )}
    </section>
  );
}

/**
 * Last-refreshed indicator. Owns its own 1Hz tick so only this leaf
 * re-renders each second; the rest of the dashboard tree is not
 * invalidated. Mirrors `ResumeAuditView`'s LastRefreshedIndicator.
 */
function LastRefreshedIndicator({
  lastRefreshedAt,
  dataUpdatedAt,
}: {
  readonly lastRefreshedAt: number;
  readonly dataUpdatedAt: number;
}) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Fold dataUpdatedAt so auto-poll completions also bump the displayed
  // freshness; explicit `lastRefreshedAt` paths (Refresh button, filter
  // chip change) win against either when more recent.
  const effective = Math.max(lastRefreshedAt, dataUpdatedAt);
  const elapsedSeconds = Math.max(0, Math.round((now - effective) / 1000));
  const label = `Last refreshed ${RELATIVE_TIME_FORMATTER.format(-elapsedSeconds, 'second')}`;

  return (
    <span
      className={styles.lastRefreshed}
      data-testid="operator-actions-last-refreshed"
    >
      {label}
    </span>
  );
}

interface FilterPanelProps {
  readonly actor: string | null;
  readonly actionType: OperatorActionKind | null;
  readonly actorFacets: ReadonlyArray<{ readonly actor: string; readonly count: number }>;
  readonly actionTypeFacets: ReadonlyArray<{ readonly action_type: OperatorActionKind; readonly count: number }>;
  readonly onActorChange: (next: string | null) => void;
  readonly onActionTypeChange: (next: OperatorActionKind | null) => void;
  readonly onClearAll: (() => void) | null;
}

function FilterPanel({
  actor,
  actionType,
  actorFacets,
  actionTypeFacets,
  onActorChange,
  onActionTypeChange,
  onClearAll,
}: FilterPanelProps) {
  if (actorFacets.length === 0 && actionTypeFacets.length === 0) {
    return null;
  }
  return (
    <div className={styles.filters} data-testid="operator-actions-filters">
      <FilterGroup
        label="Actor"
        testIdPrefix="operator-actions-actor"
        chips={actorFacets.map((f) => ({
          key: f.actor,
          label: f.actor,
          count: f.count,
          selected: f.actor === actor,
          onClick: () => onActorChange(f.actor === actor ? null : f.actor),
        }))}
      />
      <FilterGroup
        label="Action type"
        testIdPrefix="operator-actions-type"
        chips={actionTypeFacets.map((f) => ({
          key: f.action_type,
          label: f.action_type,
          count: f.count,
          selected: f.action_type === actionType,
          onClick: () => onActionTypeChange(f.action_type === actionType ? null : f.action_type),
        }))}
      />
      {onClearAll && (
        <button
          type="button"
          className={styles.clearAll}
          onClick={onClearAll}
          data-testid="operator-actions-clear-all"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

interface FilterGroupProps {
  readonly label: string;
  readonly testIdPrefix: string;
  readonly chips: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly count: number;
    readonly selected: boolean;
    readonly onClick: () => void;
  }>;
}

function FilterGroup({ label, testIdPrefix, chips }: FilterGroupProps) {
  return (
    <div className={styles.filterGroup}>
      <span className={styles.filterGroupLabel}>{label}</span>
      <div className={styles.chipRow}>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`${styles.chip} ${c.selected ? styles.chipSelected : ''}`}
            aria-pressed={c.selected}
            data-testid={`${testIdPrefix}-chip-${c.key}`}
            onClick={c.onClick}
          >
            <span>{c.label}</span>
            <span className={styles.chipCount}>{c.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ResultsList({
  data,
  hasFilters,
}: {
  readonly data: OperatorActionsListResponse;
  readonly hasFilters: boolean;
}) {
  if (data.total === 0) {
    return (
      <EmptyState
        title="No operator-action atoms yet"
        detail="Operator-action atoms accumulate as the substrate's bot-identity wrappers (gh-as.mjs, cr-trigger.mjs, resolve-outdated-threads.mjs) execute mutations against GitHub. Run any bot-attributed gh action to populate this view."
        testId="operator-actions-empty-total"
      />
    );
  }
  if (data.rows.length === 0) {
    return (
      <EmptyState
        title="No actions match these filters"
        detail={
          hasFilters
            ? 'Try widening the actor or action-type chips to expose more rows.'
            : 'The current dataset is empty. Refresh after taking a bot-attributed action.'
        }
        testId="operator-actions-empty-filtered"
      />
    );
  }
  return (
    <>
      <StatsHeader
        total={data.filtered}
        label={`action${data.filtered === 1 ? '' : 's'}`}
        detail={
          <span className={styles.summaryLine}>
            <span className={styles.summaryLineStrong} data-testid="operator-actions-stats-filtered">
              showing {data.rows.length}
            </span>
            {' of '}
            <span data-testid="operator-actions-stats-total">{data.total}</span>
            {' total'}
          </span>
        }
      />
      <ol className={styles.list} data-testid="operator-actions-list">
        {data.rows.map((row) => (
          <ActionRow key={row.atom_id} row={row} />
        ))}
      </ol>
    </>
  );
}

function ActionRow({ row }: { readonly row: OperatorActionRow }) {
  const reducedMotion = useReducedMotion();
  /*
   * The row routes directly to /atom/<id> rather than the
   * routeForAtomId default ('activities' for op-action-* atoms) so the
   * operator drills into the dedicated atom-detail viewer (per
   * canon dec-routing-stage-output-to-atom-detail-viewer rationale).
   * The atom-detail viewer renders the full envelope including
   * metadata.operator_action.args, taint, provenance, derived_from.
   */
  const targetRoute: Route = 'atom';
  const href = routeHref(targetRoute, row.atom_id);
  /*
   * Primary interactive surface is a visible <a> with a real href so
   * the OS-native affordances survive: middle-click → new tab, Cmd/Ctrl-
   * click → background tab, right-click → "Copy link address" / "Open
   * in new window". We intercept only plain left-click (no modifier
   * keys, no default-prevented) for SPA routing; every other gesture
   * falls through to the browser. The <li> is now a structural carrier
   * for layout + data-* attrs only — no role="link" gymnastics.
   */
  const onClick = (e: MouseEvent) => {
    if (!isPlainLeftClick(e)) return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    e.preventDefault();
    setRoute(targetRoute, row.atom_id);
  };

  return (
    <motion.li
      className={styles.row}
      data-testid="operator-actions-row"
      data-atom-id={row.atom_id}
      data-actor={row.actor}
      data-action-type={row.action_type}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.16 }}
    >
      <a
        href={href}
        className={styles.rowLink}
        data-testid="operator-actions-row-link"
        onClick={onClick}
      >
        <span className={styles.actorBadge} data-testid="operator-actions-row-actor">
          {row.actor}
        </span>
        <span
          className={`${styles.actionType} ${actionTypeToneClass(row.action_type)}`}
          data-testid="operator-actions-row-action-type"
        >
          {row.action_type}
        </span>
        <span
          className={`${styles.target} ${row.target ? '' : styles.targetMissing}`}
          data-testid="operator-actions-row-target"
        >
          {row.target ?? row.subcommand}
        </span>
        <time
          className={styles.timestamp}
          dateTime={row.created_at}
          data-testid="operator-actions-row-time"
        >
          {formatRelative(row.created_at)}
        </time>
        <code className={styles.argsPreview} data-testid="operator-actions-row-args">
          {row.args_preview}
        </code>
      </a>
    </motion.li>
  );
}
