import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { Activity, AlertCircle, ArrowRightLeft, Clock3, RefreshCw, RotateCcw, Users } from 'lucide-react';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { setRoute, routeHref, routeForAtomId, type Route } from '@/state/router.store';
import { formatRelative } from '@/features/pipelines-viewer/PipelinesView';
import {
  getResumeRecent,
  getResumeResets,
  getResumeSummary,
  type ResumeAuditPrincipalStats,
  type ResumeAuditRecentResponse,
  type ResumeAuditRecentSession,
  type ResumeAuditResetRecord,
  type ResumeAuditResetsResponse,
  type ResumeAuditSummary,
} from '@/services/resume-audit.service';
import { toErrorMessage } from '@/services/errors';
import styles from './ResumeAuditView.module.css';

/**
 * Module-scoped relative-time formatter. One instance reused across
 * renders so each tick pays only the formatter call, not an allocator
 * round-trip. Locale fixed to 'en' until a console-wide i18n source
 * appears (the second consumer is the upgrade trigger per
 * `dev-dry-extract-at-second-duplication`).
 */
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * Resume audit dashboard.
 *
 * Cross-actor projection of the resume-by-default substrate's audit
 * fields (`metadata.agent_session.extra.resume_attempt`,
 * `extra.resume_strategy_used`, `extra.resumed_from_atom_id`). The
 * substrate ships these via the `ResumeAuthorAgentLoopAdapter` wrapper
 * (PR #171 + Phases 1-3 of the resume-by-default extension).
 *
 * Three sections, top-to-bottom:
 *   1. Per-principal ratio cards: which actors are resuming, how often.
 *   2. Recent resumed sessions: click-through to the resumed session
 *      atom OR to the prior session it resumed from.
 *   3. Recent operator-reset signals: when an operator wrote a
 *      `resume-reset-<principal>-<work-item>` atom to override resume
 *      and force a fresh-spawn.
 *
 * Mobile-first per `dev-web-mobile-first-required`: single-column at
 * <60rem, two-column ratio grid + side-by-side recent + resets at
 * larger widths. No useEffect for data; TanStack Query owns lifecycle.
 *
 * Three queries are held at this root so the Refresh control can drive
 * a coordinated refetch across all sections (per the `Last refreshed`
 * indicator below). Section components consume the query results via
 * props so each section still owns its own loading / error / empty
 * branches.
 */
export function ResumeAuditView() {
  const [windowHours, setWindowHours] = useState<number>(24);

  const summaryQuery = useQuery({
    queryKey: ['resume-audit', 'summary', windowHours],
    queryFn: ({ signal }) => getResumeSummary(windowHours, signal),
  });
  const recentQuery = useQuery({
    queryKey: ['resume-audit', 'recent'],
    queryFn: ({ signal }) => getResumeRecent(20, signal),
  });
  const resetsQuery = useQuery({
    queryKey: ['resume-audit', 'resets'],
    queryFn: ({ signal }) => getResumeResets(20, signal),
  });

  const someFetching =
    summaryQuery.isFetching || recentQuery.isFetching || resetsQuery.isFetching;

  /*
   * Last-refreshed instant (the explicit-action floor for the
   * indicator). Refresh button + window-chip change each call
   * `setLastRefreshedAt(Date.now())` so the indicator snaps to 0s
   * for any path that *intentionally* produces fresh data. The
   * `LastRefreshedIndicator` leaf folds in each query's
   * `dataUpdatedAt` so auto-refetch under TanStack Query's 30s
   * `staleTime` is also reflected without going through these
   * handlers. The tick lives in the leaf so only the label
   * re-renders each second; the parent dashboard tree is not
   * invalidated by the 1Hz timer per the `no-jank` guideline.
   */
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(() => Date.now());

  const handleRefresh = () => {
    setLastRefreshedAt(Date.now());
    void Promise.all([
      summaryQuery.refetch(),
      recentQuery.refetch(),
      resetsQuery.refetch(),
    ]);
  };

  /*
   * Window-chip changes flip the summaryQuery key (line above
   * threads windowHours into queryKey), which triggers an automatic
   * refetch by TanStack Query. The data then becomes fresh while
   * `lastRefreshedAt` still points at the previous reset instant,
   * so the indicator would falsely show "Last refreshed 3 minutes
   * ago" against just-loaded data. Reset alongside the chip change
   * so the indicator stays truthful for any path that produces
   * fresh data, not only the explicit Refresh button.
   */
  const handleWindowChange = (next: number) => {
    setWindowHours(next);
    setLastRefreshedAt(Date.now());
  };

  return (
    <section className={styles.view} data-testid="resume-audit-view">
      <header className={styles.intro}>
        <div className={styles.introText}>
          <h2 className={styles.heroTitle}>Resume audit</h2>
          <p className={styles.heroSubtitle}>
            Cross-actor view of resume-vs-fresh-spawn behavior. The
            substrate writes resume telemetry on each agent-session
            atom; this dashboard projects those fields so an operator
            can see whether actors are inheriting prior context as
            intended, or silently fresh-spawning every iteration.
          </p>
        </div>
        <div className={styles.refreshGroup}>
          <LastRefreshedIndicator
            lastRefreshedAt={lastRefreshedAt}
            summaryUpdatedAt={summaryQuery.dataUpdatedAt}
            recentUpdatedAt={recentQuery.dataUpdatedAt}
            resetsUpdatedAt={resetsQuery.dataUpdatedAt}
          />
          <button
            type="button"
            className={styles.refreshButton}
            onClick={handleRefresh}
            disabled={someFetching}
            aria-busy={someFetching}
            aria-label="Refresh"
            data-testid="resume-audit-refresh"
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className={someFetching ? styles.refreshSpinning : ''}
              data-testid={someFetching ? 'resume-audit-refresh-spinner' : undefined}
            />
            <span className={styles.refreshLabel}>Refresh</span>
          </button>
        </div>
      </header>

      <SummarySection
        windowHours={windowHours}
        onWindowChange={handleWindowChange}
        query={summaryQuery}
      />
      <RecentResumedSection query={recentQuery} />
      <RecentResetsSection query={resetsQuery} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Last-refreshed indicator (leaf component).
//
// Owns the 1-second `now` tick locally so only this leaf re-renders
// each second; the parent dashboard + its three section subtrees are
// not invalidated by the timer per the `no-jank` interaction
// guideline. `dataUpdatedAt` props are read each render and folded
// into the displayed timestamp via Math.max so the indicator reflects
// actual data freshness (auto-refetch + explicit Refresh + window-chip
// change all update it) rather than only the paths that bump the
// parent's tracked `lastRefreshedAt`.
// ---------------------------------------------------------------------------

interface LastRefreshedIndicatorProps {
  readonly lastRefreshedAt: number;
  readonly summaryUpdatedAt: number;
  readonly recentUpdatedAt: number;
  readonly resetsUpdatedAt: number;
}

function LastRefreshedIndicator({
  lastRefreshedAt,
  summaryUpdatedAt,
  recentUpdatedAt,
  resetsUpdatedAt,
}: LastRefreshedIndicatorProps) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /*
   * Fold each query's `dataUpdatedAt` into the displayed timestamp
   * so the indicator reflects actual data freshness, not only the
   * paths that explicitly bump `lastRefreshedAt`. The global
   * QueryClient ships `staleTime: 30_000`, so any of the three
   * useQuery hooks can auto-refetch on remount or window focus
   * after 30s without going through handleRefresh /
   * handleWindowChange. Without this max(...), the indicator would
   * report e.g. "Last refreshed 2 minutes ago" against just-loaded
   * data. The tracked `lastRefreshedAt` remains in the max so the
   * click-resets-to-0 semantics for the explicit Refresh path stay
   * untouched (the click bumps it past the queries' updated
   * timestamps before the optimistic-set landing).
   */
  const effectiveLastRefreshedAt = Math.max(
    lastRefreshedAt,
    summaryUpdatedAt,
    recentUpdatedAt,
    resetsUpdatedAt,
  );
  const elapsedSeconds = Math.max(0, Math.round((now - effectiveLastRefreshedAt) / 1000));
  const lastRefreshedLabel = `Last refreshed ${RELATIVE_TIME_FORMATTER.format(-elapsedSeconds, 'second')}`;

  /*
   * The visible label updates every second (from the `now` tick),
   * so leaving an `aria-live` region here would cause screen
   * readers to chant "Last refreshed N seconds ago" every second,
   * which is exactly the disruption `aria-live` is meant to avoid.
   * The label remains available to AT in the DOM via this span;
   * routine ticks are not announced. Should we ever want to announce
   * on explicit refresh, the right shape is a separate sr-only
   * live-region element written only inside the parent's
   * `handleRefresh`, not on the per-second tick.
   */
  return (
    <span
      className={styles.lastRefreshed}
      data-testid="resume-audit-last-refreshed"
    >
      {lastRefreshedLabel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section 1: per-principal ratio cards.
// ---------------------------------------------------------------------------

const WINDOW_OPTIONS: ReadonlyArray<{ readonly hours: number; readonly label: string }> = [
  { hours: 1, label: '1h' },
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 72, label: '3d' },
  { hours: 168, label: '7d' },
];

interface SummarySectionProps {
  readonly windowHours: number;
  readonly onWindowChange: (next: number) => void;
  readonly query: UseQueryResult<ResumeAuditSummary>;
}

function SummarySection({ windowHours, onWindowChange, query }: SummarySectionProps) {
  return (
    <section className={styles.section} aria-labelledby="resume-audit-summary-heading">
      <header className={styles.sectionHead}>
        <h3 id="resume-audit-summary-heading" className={styles.sectionTitle}>
          <Users size={14} strokeWidth={2} aria-hidden="true" />
          Per-principal resume ratio
        </h3>
        <WindowChips windowHours={windowHours} onChange={onWindowChange} />
      </header>

      {query.isPending && <LoadingState label="Loading summary..." testId="resume-audit-summary-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load resume summary"
          message={toErrorMessage(query.error)}
          testId="resume-audit-summary-error"
        />
      )}
      {query.isSuccess && <SummaryGrid summary={query.data} />}
    </section>
  );
}

function WindowChips({
  windowHours,
  onChange,
}: {
  windowHours: number;
  onChange: (next: number) => void;
}) {
  return (
    <nav
      className={styles.windowChips}
      aria-label="Time window"
      data-testid="resume-audit-window-chips"
    >
      {WINDOW_OPTIONS.map(({ hours, label }) => {
        const selected = hours === windowHours;
        return (
          <button
            key={hours}
            type="button"
            className={`${styles.windowChip} ${selected ? styles.windowChipSelected : ''}`}
            aria-pressed={selected}
            data-testid={`resume-audit-window-${hours}h`}
            onClick={() => onChange(hours)}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function SummaryGrid({ summary }: { summary: ResumeAuditSummary }) {
  if (summary.principals.length === 0) {
    return (
      <EmptyState
        title="No agent-session atoms in this window"
        detail={
          <>
            No actors have written agent-session atoms in the last{' '}
            <strong>{summary.window_hours}h</strong>. Sessions appear
            here once an actor with the resume-by-default substrate
            wired in writes a session atom carrying{' '}
            <code>metadata.agent_session.extra.resume_attempt</code>.
          </>
        }
        testId="resume-audit-summary-empty"
      />
    );
  }
  return (
    <>
      <StatsHeader
        total={summary.total_sessions}
        label={`session${summary.total_sessions === 1 ? '' : 's'}`}
        detail={
          <span className={styles.headerDetail}>
            <span data-testid="resume-audit-total-resumed">
              {summary.total_resumed} resumed
            </span>
            <span aria-hidden="true">{'\u00B7'}</span>
            <span data-testid="resume-audit-total-attempts">
              {summary.total_resume_attempts} attempts
            </span>
          </span>
        }
      />
      <div className={styles.principalGrid} data-testid="resume-audit-principal-grid">
        {summary.principals.map((p, idx) => (
          <PrincipalRatioCard key={p.principal_id} stats={p} index={idx} />
        ))}
      </div>
    </>
  );
}

function PrincipalRatioCard({
  stats,
  index,
}: {
  stats: ResumeAuditPrincipalStats;
  index: number;
}) {
  const ratioPct = stats.ratio === null ? null : Math.round(stats.ratio * 100);
  const tone = ratioToneClass(stats.ratio);
  const reducedMotion = useReducedMotion();

  return (
    <motion.article
      className={`${styles.principalCard} ${tone}`}
      data-testid="resume-audit-principal-card"
      data-principal-id={stats.principal_id}
      data-ratio={stats.ratio === null ? 'no-data' : ratioPct ?? 0}
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.18, delay: reducedMotion ? 0 : Math.min(index * 0.025, 0.3) }}
      onClick={makeCardNav('principals', stats.principal_id)}
    >
      <header className={styles.principalCardHead}>
        <h4 className={styles.principalName}>
          <a
            className={styles.principalLink}
            href={routeHref('principals', stats.principal_id)}
            data-testid="resume-audit-principal-link"
            onClick={makeNav('principals', stats.principal_id)}
          >
            {stats.principal_id}
          </a>
        </h4>
      </header>

      <div className={styles.ratioBlock}>
        <div className={styles.ratioValueRow}>
          {stats.ratio === null ? (
            <span className={styles.ratioNoData} data-testid="resume-audit-ratio-no-data">
              no resume telemetry
            </span>
          ) : (
            <span className={styles.ratioValue}>
              <span className={styles.ratioPct} data-testid="resume-audit-ratio-pct">
                {ratioPct}%
              </span>
              <span className={styles.ratioLabel}>resumed</span>
            </span>
          )}
        </div>
        <div
          className={styles.ratioBar}
          data-testid="resume-audit-ratio-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ratioPct ?? 0}
        >
          <div
            className={styles.ratioFill}
            style={{ width: `${ratioPct ?? 0}%` }}
          />
        </div>
      </div>

      <ul className={styles.principalMeta}>
        <li className={styles.principalStat} data-testid="resume-audit-stat-total">
          <span className={styles.principalStatNum}>{stats.total_sessions}</span>
          <span className={styles.principalStatLabel}>total</span>
        </li>
        <li className={styles.principalStat} data-testid="resume-audit-stat-resumed">
          <span className={styles.principalStatNum}>{stats.resumed_count}</span>
          <span className={styles.principalStatLabel}>resumed</span>
        </li>
        <li className={styles.principalStat} data-testid="resume-audit-stat-fresh">
          <span className={styles.principalStatNum}>{stats.fresh_spawn_count}</span>
          <span className={styles.principalStatLabel}>fresh</span>
        </li>
      </ul>

      {stats.last_session_at && (
        <footer className={styles.principalCardFoot}>
          <Clock3 size={11} strokeWidth={2} aria-hidden="true" />
          <span>last session</span>
          <time dateTime={stats.last_session_at}>{formatRelative(stats.last_session_at)}</time>
        </footer>
      )}
    </motion.article>
  );
}

function ratioToneClass(ratio: number | null): string {
  if (ratio === null) return styles.toneNoData ?? '';
  if (ratio >= 0.75) return styles.toneHealthy ?? '';
  if (ratio >= 0.4) return styles.toneCaution ?? '';
  return styles.toneCold ?? '';
}

// ---------------------------------------------------------------------------
// Section 2: recent resumed sessions.
// ---------------------------------------------------------------------------

interface RecentResumedSectionProps {
  readonly query: UseQueryResult<ResumeAuditRecentResponse>;
}

function RecentResumedSection({ query }: RecentResumedSectionProps) {
  return (
    <section className={styles.section} aria-labelledby="resume-audit-recent-heading">
      <header className={styles.sectionHead}>
        <h3 id="resume-audit-recent-heading" className={styles.sectionTitle}>
          <Activity size={14} strokeWidth={2} aria-hidden="true" />
          Recent resumed sessions
        </h3>
      </header>

      {query.isPending && <LoadingState label="Loading recent..." testId="resume-audit-recent-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load recent sessions"
          message={toErrorMessage(query.error)}
          testId="resume-audit-recent-error"
        />
      )}
      {query.isSuccess && query.data.sessions.length === 0 && (
        <EmptyState
          title="No resumed sessions yet"
          detail="Sessions appear here once an actor with the resume-by-default substrate successfully resumes a prior session."
          testId="resume-audit-recent-empty"
        />
      )}
      {query.isSuccess && query.data.sessions.length > 0 && (
        <ul className={styles.recentList} data-testid="resume-audit-recent-list">
          {query.data.sessions.map((s) => (
            <RecentResumedRow key={s.session_atom_id} session={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentResumedRow({ session }: { session: ResumeAuditRecentSession }) {
  const sessionRoute = routeForAtomId(session.session_atom_id);
  const priorRoute = session.resumed_from_atom_id
    ? routeForAtomId(session.resumed_from_atom_id)
    : null;
  const reducedMotion = useReducedMotion();

  return (
    <motion.li
      className={styles.recentRow}
      data-testid="resume-audit-recent-row"
      data-session-id={session.session_atom_id}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.16 }}
    >
      <div className={styles.recentRowHead}>
        <a
          className={styles.recentSessionId}
          href={routeHref(sessionRoute, session.session_atom_id)}
          data-testid="resume-audit-recent-session-link"
          onClick={makeNav(sessionRoute, session.session_atom_id)}
        >
          {session.session_atom_id}
        </a>
        <span className={styles.recentPrincipal}>{session.principal_id}</span>
      </div>
      <div className={styles.recentRowBody}>
        {session.resume_strategy_used && (
          <span className={styles.recentStrategy} data-testid="resume-audit-recent-strategy">
            <ArrowRightLeft size={10} strokeWidth={2} aria-hidden="true" />
            {session.resume_strategy_used}
          </span>
        )}
        {session.resumed_from_atom_id && priorRoute && (
          <a
            className={styles.recentPriorLink}
            href={routeHref(priorRoute, session.resumed_from_atom_id)}
            data-testid="resume-audit-recent-prior-link"
            onClick={makeNav(priorRoute, session.resumed_from_atom_id)}
          >
            from {session.resumed_from_atom_id}
          </a>
        )}
        {session.model_id && (
          <span className={styles.recentModel}>{session.model_id}</span>
        )}
      </div>
      <time className={styles.recentTime} dateTime={session.created_at}>
        {formatRelative(session.created_at)}
      </time>
    </motion.li>
  );
}

// ---------------------------------------------------------------------------
// Section 3: recent reset signals.
// ---------------------------------------------------------------------------

interface RecentResetsSectionProps {
  readonly query: UseQueryResult<ResumeAuditResetsResponse>;
}

function RecentResetsSection({ query }: RecentResetsSectionProps) {
  return (
    <section className={styles.section} aria-labelledby="resume-audit-resets-heading">
      <header className={styles.sectionHead}>
        <h3 id="resume-audit-resets-heading" className={styles.sectionTitle}>
          <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
          Recent reset signals
        </h3>
        <ResetHelpButton />
      </header>

      {query.isPending && <LoadingState label="Loading resets..." testId="resume-audit-resets-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load reset signals"
          message={toErrorMessage(query.error)}
          testId="resume-audit-resets-error"
        />
      )}
      {query.isSuccess && query.data.resets.length === 0 && (
        <EmptyState
          title="No resume-reset atoms"
          detail={
            <>
              An operator can write a <code>resume-reset</code> atom to
              override resume on a stuck work-item and force a
              fresh-spawn. None have been written yet.
            </>
          }
          testId="resume-audit-resets-empty"
        />
      )}
      {query.isSuccess && query.data.resets.length > 0 && (
        <ul className={styles.resetList} data-testid="resume-audit-resets-list">
          {query.data.resets.map((r) => (
            <ResetRow key={r.atom_id} record={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResetHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.helpHost}>
      <button
        type="button"
        className={styles.helpButton}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="resume-audit-reset-help"
        data-testid="resume-audit-reset-help-button"
      >
        <AlertCircle size={11} strokeWidth={2} aria-hidden="true" />
        How do I write one?
      </button>
      {open && (
        <div
          id="resume-audit-reset-help"
          className={styles.helpPopover}
          role="region"
          aria-label="How to write a resume-reset atom"
          data-testid="resume-audit-reset-help-popover"
        >
          <p>
            Reset signals are written via the canonical decide path so the
            audit chain stays intact:
          </p>
          <pre className={styles.helpCode}>
{`node scripts/decide.mjs \\
  --type=resume-reset \\
  --principal=cto-actor \\
  --work-item-key='{"kind":"intent","intentAtomId":"<id>"}' \\
  --reason='your free-text reason'`}
          </pre>
          <p>
            See spec section 6.4 for the full atom shape and the
            consume-once semantics.
          </p>
        </div>
      )}
    </div>
  );
}

function ResetRow({ record }: { record: ResumeAuditResetRecord }) {
  const route = routeForAtomId(record.atom_id);
  const reducedMotion = useReducedMotion();
  return (
    <motion.li
      className={styles.resetRow}
      data-testid="resume-audit-reset-row"
      data-reset-id={record.atom_id}
      data-consumed={record.consumed ? 'true' : 'false'}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.16 }}
    >
      <div className={styles.resetRowHead}>
        <a
          className={styles.resetAtomLink}
          href={routeHref(route, record.atom_id)}
          data-testid="resume-audit-reset-atom-link"
          onClick={makeNav(route, record.atom_id)}
        >
          {record.atom_id}
        </a>
        <span
          className={`${styles.resetStatus} ${record.consumed ? styles.resetConsumed : styles.resetPending}`}
          data-testid="resume-audit-reset-status"
        >
          {record.consumed ? 'Consumed' : 'Pending'}
        </span>
      </div>
      <div className={styles.resetRowBody}>
        <span className={styles.resetField}>
          <span className={styles.resetFieldLabel}>actor</span>
          <span className={styles.resetFieldValue}>{record.reset_principal_id}</span>
        </span>
        {record.work_item_summary && (
          <span className={styles.resetField}>
            <span className={styles.resetFieldLabel}>work-item</span>
            <span className={styles.resetFieldValue}>{record.work_item_summary}</span>
          </span>
        )}
        {record.reason && (
          <span className={styles.resetReason} data-testid="resume-audit-reset-reason">
            {record.reason}
          </span>
        )}
      </div>
      <time className={styles.resetTime} dateTime={record.created_at}>
        {formatRelative(record.created_at)}
      </time>
    </motion.li>
  );
}

// ---------------------------------------------------------------------------
// Internal-link click guard (extracted at N=2 within this file per
// `dev-extract-helpers-at-n-2`).
//
// Five sites in this view (ratio-card body, principal-name link, recent-row
// body, recent prior-link, reset-row body, reset atom link) repeat the same
// shape: bail on modifier-or-non-primary clicks, prevent the default
// navigation, then call setRoute. Centralizing the predicate keeps the
// behavior consistent and lets a future tweak (e.g. a navigation analytic)
// land once.
//
// Cross-feature extraction (pulling this into a shared util alongside the
// 10 other call sites in this codebase) is scoped out: each feature owns
// its own click-handler shape today, and a substrate-wide refactor is a
// separate ship. This helper unblocks the inside-the-file duplication
// while preserving the larger seam.
// ---------------------------------------------------------------------------

function isPlainLeftClick(e: MouseEvent): boolean {
  if (e.defaultPrevented) return false;
  if (e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return true;
}

/**
 * Anchor-style onClick: bail on modifier/non-primary, otherwise prevent
 * default and call setRoute. Used by every <a href={routeHref(...)}> in
 * this view so the modified-click semantics (open in new tab, etc.)
 * survive while plain-left-click is intercepted into pushState.
 */
function makeNav(route: Route, id?: string) {
  return (e: MouseEvent) => {
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    setRoute(route, id);
  };
}

/**
 * Card-body onClick: same modified-click bail, plus skip when the click
 * landed on an interactive element inside the card (anchors, buttons,
 * inputs, code blocks) and skip when the user has a text selection
 * active. The card-as-a-link affordance must coexist with the inner
 * anchors and the user's ability to highlight text without navigating.
 */
function makeCardNav(route: Route, id?: string) {
  return (e: MouseEvent) => {
    if (!isPlainLeftClick(e)) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, textarea, select, pre')) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    setRoute(route, id);
  };
}
