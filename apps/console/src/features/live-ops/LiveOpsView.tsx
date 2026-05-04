import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Activity, Cpu, Eye, GitMerge, Heart, ShieldAlert, Timer, Users, Workflow } from 'lucide-react';
import {
  LoadingState,
  ErrorState,
} from '@/components/state-display/StateDisplay';
import {
  getLiveOpsSnapshot,
  type LiveOpsActiveElevation,
  type LiveOpsActiveSession,
  type LiveOpsDaemonPosture,
  type LiveOpsHeartbeat,
  type LiveOpsInFlightExecution,
  type LiveOpsLiveDeliberation,
  type LiveOpsPrActivity,
  type LiveOpsRecentTransition,
  type LiveOpsSnapshot,
} from '@/services/live-ops.service';
import {
  listLiveOpsPipelines,
  type PipelineLiveOpsRow,
} from '@/services/pipelines.service';
import { setRoute } from '@/state/router.store';
import { planStateTone } from '@/features/plan-state/tones';
import { pipelineStateTone } from '@/features/pipelines-viewer/tones';
import styles from './LiveOpsView.module.css';

/**
 * LiveOpsView - the "everything happening right now" dashboard.
 *
 * Single auto-refresh query (2s cadence) drives every tile so the
 * sections render off a coherent snapshot, never a torn read across
 * seven endpoints. Each tile is a self-contained card with a header,
 * a live indicator (pulsing dot when freshly fetched), and a list
 * body. Sections render an explicit empty state on null/empty data
 * so a fresh atom store still produces a polished page.
 *
 * Read-only by construction: every interaction is navigation
 * (drill into PlanLifecycle), never a mutation. v1 read-only contract
 * preserved.
 */

const REFRESH_INTERVAL_MS = 2000;

export function LiveOpsView() {
  const query = useQuery({
    queryKey: ['live-ops.snapshot'],
    queryFn: ({ signal }) => getLiveOpsSnapshot(signal),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  return (
    <section className={styles.view} data-testid="live-ops-view">
      <header className={styles.intro}>
        <div className={styles.titleBlock}>
          <h2 className={styles.heroTitle}>Pulse</h2>
          <p className={styles.heroSubtitle}>
            Every daemon, actor, deliberation, and dispatch in flight right now.
            Refreshes every {REFRESH_INTERVAL_MS / 1000}s while this tab is open.
          </p>
        </div>
        <PulseIndicator
          fetching={query.isFetching}
          computedAt={query.data?.computed_at ?? null}
        />
      </header>

      {query.isPending && <LoadingState label="Reading the org..." testId="live-ops-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load live ops snapshot"
          message={(query.error as Error).message}
          testId="live-ops-error"
        />
      )}
      {query.isSuccess && <Body data={query.data} />}
    </section>
  );
}

function PulseIndicator({
  fetching,
  computedAt,
}: {
  fetching: boolean;
  computedAt: string | null;
}) {
  return (
    <div className={styles.pulseIndicator} data-testid="live-ops-pulse">
      <span
        className={`${styles.pulseDot} ${fetching ? styles.pulseDotActive : ''}`}
        aria-hidden="true"
      />
      <span className={styles.pulseLabel}>
        {computedAt ? `As of ${formatClock(computedAt)}` : 'Connecting...'}
      </span>
    </div>
  );
}

function Body({ data }: { data: LiveOpsSnapshot }) {
  return (
    <div className={styles.grid}>
      <HeartbeatTile heartbeat={data.heartbeat} />
      <DaemonPostureTile posture={data.daemon_posture} />
      <ActiveSessionsTile sessions={data.active_sessions} />
      <LiveDeliberationsTile plans={data.live_deliberations} />
      <InFlightExecutionsTile plans={data.in_flight_executions} />
      <PipelinesTile />
      <RecentTransitionsTile transitions={data.recent_transitions} />
      <PrActivityTile prs={data.pr_activity} />
    </div>
  );
}

function PipelinesTile() {
  /*
   * Pipelines tile uses its own TanStack Query keyed off
   * `pipelines.live-ops`. Mirrors the snapshot's 2s cadence so the
   * "in flight" tile has the same liveness feel as the rest of the
   * dashboard. Stitching this into the snapshot endpoint server-side
   * was the alternative; kept separate so the snapshot endpoint stays
   * minimal-shape and a future Pulse-tile reorg can drop pipelines
   * out cheaply.
   */
  const query = useQuery({
    queryKey: ['live-ops.pipelines'],
    queryFn: ({ signal }) => listLiveOpsPipelines(signal),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  const rows: ReadonlyArray<PipelineLiveOpsRow> = query.data?.pipelines ?? [];
  return (
    <Tile
      icon={Workflow}
      title="Pipelines in flight"
      subtitle="Deep planning runs (running + paused)"
      testId="live-ops-pipelines"
    >
      {query.isPending && (
        <p className={styles.empty} data-testid="live-ops-pipelines-loading">
          Loading...
        </p>
      )}
      {query.isError && (
        <p className={styles.empty} data-testid="live-ops-pipelines-error">
          Could not load pipelines snapshot.
        </p>
      )}
      {query.isSuccess && rows.length === 0 && (
        <EmptyRow testId="live-ops-pipelines-empty">
          No pipelines in flight. Trigger a substrate-deep run to see the chain materialize.
        </EmptyRow>
      )}
      {query.isSuccess && rows.length > 0 && (
        <ul className={styles.list} data-testid="live-ops-pipelines-list">
          {rows.map((p) => (
            <PipelineRow key={p.pipeline_id} pipeline={p} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function PipelineRow({ pipeline }: { pipeline: PipelineLiveOpsRow }) {
  const tone = pipelineStateTone(pipeline.pipeline_state);
  const href = `/pipelines/${encodeURIComponent(pipeline.pipeline_id)}`;
  return (
    <li
      className={styles.row}
      data-testid="live-ops-pipeline-row"
      data-pipeline-id={pipeline.pipeline_id}
      data-pipeline-state={pipeline.pipeline_state}
    >
      <a
        className={styles.rowLink}
        href={href}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('pipelines', pipeline.pipeline_id);
        }}
      >
        <span className={styles.rowPrimary}>
          <span
            className={styles.statePill}
            style={{ borderColor: tone, color: tone }}
            aria-label={`pipeline state ${pipeline.pipeline_state}`}
          >
            {pipeline.pipeline_state}
          </span>
          {pipeline.title}
        </span>
        <span className={styles.rowSecondary}>
          {pipeline.current_stage_name
            ? `${pipeline.current_stage_name} (${pipeline.current_stage_index + 1}/${pipeline.total_stages || '?'})`
            : 'no stage event yet'}
          {' '}{'\u00B7'}{' '}{formatRelative(pipeline.last_event_at)}
        </span>
      </a>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function HeartbeatTile({ heartbeat }: { heartbeat: LiveOpsHeartbeat }) {
  const deltaTone = heartbeat.delta > 0
    ? styles.deltaUp
    : heartbeat.delta < 0
      ? styles.deltaDown
      : styles.deltaFlat;
  const deltaSign = heartbeat.delta > 0 ? '+' : '';
  return (
    <Tile
      icon={Heart}
      title="Heartbeat"
      subtitle="Atom write rate"
      testId="live-ops-heartbeat"
      hero
    >
      <div className={styles.heartbeatRow}>
        <Stat
          label="60s"
          value={heartbeat.last_60s.toString()}
          testId="live-ops-heartbeat-60s"
        />
        <Stat
          label="5m"
          value={heartbeat.last_5m.toString()}
          testId="live-ops-heartbeat-5m"
        />
        <Stat
          label="1h"
          value={heartbeat.last_1h.toString()}
          testId="live-ops-heartbeat-1h"
        />
      </div>
      <div className={`${styles.delta} ${deltaTone}`} data-testid="live-ops-heartbeat-delta">
        <span className={styles.deltaValue}>
          {deltaSign}{heartbeat.delta}
        </span>
        <span className={styles.deltaLabel}>vs prior 60s</span>
      </div>
    </Tile>
  );
}

function DaemonPostureTile({ posture }: { posture: LiveOpsDaemonPosture }) {
  return (
    <Tile
      icon={ShieldAlert}
      title="Posture"
      subtitle="Kill switch + autonomy + elevations"
      testId="live-ops-posture"
    >
      <div className={styles.postureRow}>
        <PostureBadge
          tone={posture.kill_switch_engaged ? 'danger' : 'success'}
          label={posture.kill_switch_engaged ? 'Engaged' : 'Clear'}
          detail={`tier ${posture.kill_switch_tier}`}
          testId="live-ops-kill-switch"
        />
        <PostureBadge
          tone="neutral"
          label={`Dial ${posture.autonomy_dial.toFixed(2)}`}
          detail="0 = full gate, 1 = no gate"
          testId="live-ops-autonomy-dial"
        />
      </div>
      {posture.active_elevations.length === 0 ? (
        <EmptyRow testId="live-ops-elevations-empty">
          No active elevations. Standing posture in effect.
        </EmptyRow>
      ) : (
        <ul className={styles.list} data-testid="live-ops-elevations-list">
          {posture.active_elevations.map((e) => (
            <ElevationRow key={e.atom_id} elevation={e} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function ElevationRow({ elevation }: { elevation: LiveOpsActiveElevation }) {
  return (
    <li
      className={styles.row}
      data-testid="live-ops-elevation-row"
      data-atom-id={elevation.atom_id}
    >
      <span className={styles.rowPrimary}>{elevation.atom_id}</span>
      <span className={styles.rowSecondary}>
        expires in {formatDuration(elevation.ms_until_expiry)}
      </span>
    </li>
  );
}

function ActiveSessionsTile({ sessions }: { sessions: ReadonlyArray<LiveOpsActiveSession> }) {
  return (
    <Tile
      icon={Cpu}
      title="Active sessions"
      subtitle="Agent loops in flight"
      testId="live-ops-active-sessions"
    >
      {sessions.length === 0 ? (
        <EmptyRow testId="live-ops-sessions-empty">
          No active agent sessions. The substrate is idle.
        </EmptyRow>
      ) : (
        <ul className={styles.list} data-testid="live-ops-sessions-list">
          {sessions.map((s) => (
            <SessionRow key={s.session_id} session={s} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function SessionRow({ session }: { session: LiveOpsActiveSession }) {
  const lastTurnLabel = session.last_turn_at
    ? `last turn ${formatRelative(session.last_turn_at)}`
    : 'no turns yet';
  return (
    <li className={styles.row} data-testid="live-ops-session-row" data-session-id={session.session_id}>
      <span className={styles.rowPrimary}>{session.principal_id}</span>
      <span className={styles.rowSecondary}>{lastTurnLabel}</span>
    </li>
  );
}

function LiveDeliberationsTile({ plans }: { plans: ReadonlyArray<LiveOpsLiveDeliberation> }) {
  return (
    <Tile
      icon={Users}
      title="Live deliberations"
      subtitle="Plans proposed, awaiting approval"
      testId="live-ops-deliberations"
    >
      {plans.length === 0 ? (
        <EmptyRow testId="live-ops-deliberations-empty">
          No proposed plans. The org is settled.
        </EmptyRow>
      ) : (
        <ul className={styles.list} data-testid="live-ops-deliberations-list">
          {plans.map((p) => (
            <DeliberationRow key={p.plan_id} plan={p} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function DeliberationRow({ plan }: { plan: LiveOpsLiveDeliberation }) {
  const href = `/plan-lifecycle/${encodeURIComponent(plan.plan_id)}`;
  return (
    <li className={styles.row} data-testid="live-ops-deliberation-row" data-plan-id={plan.plan_id}>
      <a
        className={styles.rowLink}
        href={href}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('plan-lifecycle', plan.plan_id);
        }}
      >
        <span className={styles.rowPrimary}>{plan.title}</span>
        <span className={styles.rowSecondary}>
          {plan.principal_id} {'\u00B7'} {formatAge(plan.age_seconds)}
        </span>
      </a>
    </li>
  );
}

function InFlightExecutionsTile({
  plans,
}: {
  plans: ReadonlyArray<LiveOpsInFlightExecution>;
}) {
  return (
    <Tile
      icon={Timer}
      title="In flight"
      subtitle="Plans executing"
      testId="live-ops-in-flight"
    >
      {plans.length === 0 ? (
        <EmptyRow testId="live-ops-in-flight-empty">
          Nothing executing. Last dispatch has completed or not yet started.
        </EmptyRow>
      ) : (
        <ul className={styles.list} data-testid="live-ops-in-flight-list">
          {plans.map((p) => (
            <InFlightRow key={p.plan_id} plan={p} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function InFlightRow({ plan }: { plan: LiveOpsInFlightExecution }) {
  const href = `/plan-lifecycle/${encodeURIComponent(plan.plan_id)}`;
  return (
    <li className={styles.row} data-testid="live-ops-in-flight-row" data-plan-id={plan.plan_id}>
      <a
        className={styles.rowLink}
        href={href}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('plan-lifecycle', plan.plan_id);
        }}
      >
        <span className={styles.rowPrimary}>{plan.plan_id}</span>
        <span className={styles.rowSecondary}>
          dispatched {formatAge(plan.age_seconds)} ago by {plan.dispatched_by}
        </span>
      </a>
    </li>
  );
}

function RecentTransitionsTile({
  transitions,
}: {
  transitions: ReadonlyArray<LiveOpsRecentTransition>;
}) {
  return (
    <Tile
      icon={Activity}
      title="Recent transitions"
      subtitle="Plan state changes in the last 15 minutes"
      testId="live-ops-transitions"
    >
      {transitions.length === 0 ? (
        <EmptyRow testId="live-ops-transitions-empty">
          No transitions in the last 15 minutes.
        </EmptyRow>
      ) : (
        <ul className={styles.list} data-testid="live-ops-transitions-list">
          {transitions.map((t) => (
            <TransitionRow key={`${t.plan_id}-${t.at}`} transition={t} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function TransitionRow({ transition }: { transition: LiveOpsRecentTransition }) {
  const href = `/plan-lifecycle/${encodeURIComponent(transition.plan_id)}`;
  return (
    <li className={styles.row} data-testid="live-ops-transition-row" data-plan-id={transition.plan_id}>
      <a
        className={styles.rowLink}
        href={href}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('plan-lifecycle', transition.plan_id);
        }}
      >
        <span className={styles.transitionStates}>
          <span
            className={styles.statePill}
            style={{ borderColor: planStateTone(transition.prev_state), color: planStateTone(transition.prev_state) }}
          >
            {transition.prev_state}
          </span>
          <span className={styles.transitionArrow} aria-hidden="true">{'\u2192'}</span>
          <span
            className={styles.statePill}
            style={{ borderColor: planStateTone(transition.new_state), color: planStateTone(transition.new_state) }}
          >
            {transition.new_state}
          </span>
        </span>
        <span className={styles.rowSecondary}>{formatRelative(transition.at)}</span>
      </a>
    </li>
  );
}

function PrActivityTile({ prs }: { prs: ReadonlyArray<LiveOpsPrActivity> }) {
  return (
    <Tile
      icon={GitMerge}
      title="PR activity"
      subtitle="Recent PR observations + merges"
      testId="live-ops-pr-activity"
    >
      {prs.length === 0 ? (
        <EmptyRow testId="live-ops-pr-activity-empty">
          No PR activity in the last 24 hours.
        </EmptyRow>
      ) : (
        <ul className={styles.list} data-testid="live-ops-pr-activity-list">
          {prs.map((p) => (
            <PrRow key={p.pr_number} pr={p} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function PrRow({ pr }: { pr: LiveOpsPrActivity }) {
  /*
   * When the projection layer derived a canonical GitHub URL, render
   * the row as an external anchor opening in a new tab. rel includes
   * `noopener noreferrer` to neutralize tabnabbing -- the navigated
   * window has no `window.opener` reference back to the dashboard,
   * and the Referer header isn't leaked to GitHub. When pr_url is
   * null (older atoms, shape variants), we keep the unlinked span
   * so the row never renders as a confidently-broken link. The
   * row's outer styling (.row + .rowLink hover state) lives in
   * LiveOpsView.module.css and resolves through the token system
   * -- no hardcoded colors per apps/console/CLAUDE.md principle 3.
   */
  const primary = (
    <>
      #{pr.pr_number} {pr.title ?? '(no title)'}
    </>
  );
  return (
    <li className={styles.row} data-testid="live-ops-pr-row" data-pr-number={pr.pr_number}>
      {pr.pr_url ? (
        <a
          className={styles.rowLink}
          href={pr.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="live-ops-pr-row-link"
        >
          <span className={styles.rowPrimary}>{primary}</span>
          <span className={styles.rowSecondary}>
            {pr.state} {'\u00B7'} {formatRelative(pr.at)}
          </span>
        </a>
      ) : (
        <>
          <span className={styles.rowPrimary}>{primary}</span>
          <span className={styles.rowSecondary}>
            {pr.state} {'\u00B7'} {formatRelative(pr.at)}
          </span>
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Tile({
  icon: Icon,
  title,
  subtitle,
  testId,
  hero,
  children,
}: {
  icon: typeof Heart;
  title: string;
  subtitle: string;
  testId: string;
  hero?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      className={`${styles.tile} ${hero ? styles.tileHero : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
      data-testid={testId}
    >
      <header className={styles.tileHead}>
        <span className={styles.tileIcon} aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
        <div className={styles.tileTitleBlock}>
          <h3 className={styles.tileTitle}>{title}</h3>
          <p className={styles.tileSubtitle}>{subtitle}</p>
        </div>
      </header>
      <div className={styles.tileBody}>{children}</div>
    </motion.section>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className={styles.stat} data-testid={testId}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function PostureBadge({
  tone,
  label,
  detail,
  testId,
}: {
  tone: 'success' | 'danger' | 'neutral';
  label: string;
  detail: string;
  testId?: string;
}) {
  const cls = tone === 'success'
    ? styles.postureBadgeSuccess
    : tone === 'danger'
      ? styles.postureBadgeDanger
      : styles.postureBadgeNeutral;
  return (
    <div className={`${styles.postureBadge} ${cls}`} data-testid={testId}>
      <Eye size={14} strokeWidth={2} aria-hidden="true" />
      <span className={styles.postureBadgeLabel}>{label}</span>
      <span className={styles.postureBadgeDetail}>{detail}</span>
    </div>
  );
}

function EmptyRow({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className={styles.empty} data-testid={testId}>
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatClock(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return `${formatAge(ageSec)} ago`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function formatDuration(ms: number): string {
  // Clamp negative values: `elevation.ms_until_expiry` is server-
  // computed at snapshot time; with the 2s poll cadence an elevation
  // can cross its expiry while the snapshot is in flight, briefly
  // yielding a negative ms value. The server filters expired
  // elevations on its side, but the client should reclamp so a stale
  // tile never renders "expires in -3s". Mirrors `formatRelative`.
  return formatAge(Math.max(0, Math.round(ms / 1000)));
}
