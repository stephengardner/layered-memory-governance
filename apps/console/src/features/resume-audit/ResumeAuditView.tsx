import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Activity, AlertCircle, ArrowRightLeft, Clock3, RotateCcw, Users } from 'lucide-react';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { setRoute, routeHref, routeForAtomId } from '@/state/router.store';
import {
  getResumeRecent,
  getResumeResets,
  getResumeSummary,
  type ResumeAuditPrincipalStats,
  type ResumeAuditRecentSession,
  type ResumeAuditResetRecord,
  type ResumeAuditSummary,
} from '@/services/resume-audit.service';
import { toErrorMessage } from '@/services/errors';
import styles from './ResumeAuditView.module.css';

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
 */
export function ResumeAuditView() {
  const [windowHours, setWindowHours] = useState<number>(24);

  return (
    <section className={styles.view} data-testid="resume-audit-view">
      <header className={styles.intro}>
        <h2 className={styles.heroTitle}>Resume audit</h2>
        <p className={styles.heroSubtitle}>
          Cross-actor view of resume-vs-fresh-spawn behavior. The
          substrate writes resume telemetry on each agent-session
          atom; this dashboard projects those fields so an operator
          can see whether actors are inheriting prior context as
          intended, or silently fresh-spawning every iteration.
        </p>
      </header>

      <SummarySection windowHours={windowHours} onWindowChange={setWindowHours} />
      <RecentResumedSection />
      <RecentResetsSection />
    </section>
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
}

function SummarySection({ windowHours, onWindowChange }: SummarySectionProps) {
  const query = useQuery({
    queryKey: ['resume-audit', 'summary', windowHours],
    queryFn: ({ signal }) => getResumeSummary(windowHours, signal),
  });

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

  return (
    <motion.article
      className={`${styles.principalCard} ${tone}`}
      data-testid="resume-audit-principal-card"
      data-principal-id={stats.principal_id}
      data-ratio={stats.ratio === null ? 'no-data' : ratioPct ?? 0}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.025, 0.3) }}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (target.closest('a, button, input, textarea, select, pre')) return;
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        setRoute('principals', stats.principal_id);
      }}
    >
      <header className={styles.principalCardHead}>
        <h4 className={styles.principalName}>
          <a
            className={styles.principalLink}
            href={routeHref('principals', stats.principal_id)}
            data-testid="resume-audit-principal-link"
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0) return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setRoute('principals', stats.principal_id);
            }}
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

function RecentResumedSection() {
  const query = useQuery({
    queryKey: ['resume-audit', 'recent'],
    queryFn: ({ signal }) => getResumeRecent(20, signal),
  });

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

  return (
    <motion.li
      className={styles.recentRow}
      data-testid="resume-audit-recent-row"
      data-session-id={session.session_atom_id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
    >
      <div className={styles.recentRowHead}>
        <a
          className={styles.recentSessionId}
          href={routeHref(sessionRoute, session.session_atom_id)}
          data-testid="resume-audit-recent-session-link"
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute(sessionRoute, session.session_atom_id);
          }}
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
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0) return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              if (session.resumed_from_atom_id) {
                setRoute(priorRoute, session.resumed_from_atom_id);
              }
            }}
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

function RecentResetsSection() {
  const query = useQuery({
    queryKey: ['resume-audit', 'resets'],
    queryFn: ({ signal }) => getResumeResets(20, signal),
  });

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
  return (
    <motion.li
      className={styles.resetRow}
      data-testid="resume-audit-reset-row"
      data-reset-id={record.atom_id}
      data-consumed={record.consumed ? 'true' : 'false'}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
    >
      <div className={styles.resetRowHead}>
        <a
          className={styles.resetAtomLink}
          href={routeHref(route, record.atom_id)}
          data-testid="resume-audit-reset-atom-link"
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute(route, record.atom_id);
          }}
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
// Format helpers (shared with sibling viewers; same shape as
// pipelines-viewer's formatters per `dev-extract-at-n=2`).
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${(ageSec / 3600).toFixed(1)}h ago`;
  return new Date(ts).toLocaleString();
}
