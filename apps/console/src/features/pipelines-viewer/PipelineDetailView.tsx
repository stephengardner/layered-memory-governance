import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Activity, AlertTriangle, ArrowRight, Brain, CheckCircle2, ChevronDown, ChevronRight, Clock, Coins, Cpu, ListChecks, Loader2, MessageSquare, OctagonX, PauseCircle, PlayCircle, ShieldAlert, Wrench, Workflow, XCircle, Zap } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { PrincipalLink } from '@/components/principal-link/PrincipalLink';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { FreshnessPill } from '@/components/freshness-pill/FreshnessPill';
import { Tooltip } from '@/components/tooltip/Tooltip';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import {
  abandonPipeline,
  getPipelineDetail,
  resumePipeline,
  type AgentTurnRow,
  type PipelineAuditFinding,
  type PipelineDetail,
  type PipelineStageEvent,
  type PipelineStageSummary,
} from '@/services/pipelines.service';
import { requireActorId } from '@/services/session.service';
import { useCurrentActorId } from '@/hooks/useCurrentActorId';
import { setRoute } from '@/state/router.store';
import {
  findingSeverityTone,
  pipelineStateTone,
  stageStateTone,
} from './tones';
import {
  deriveTrueOutcome,
  trueOutcomeTone,
} from '@/features/plan-state/trueOutcome';
import { formatDurationMs, formatRelative, formatUsd } from './PipelinesView';
import { IntentOutcomeCard } from './IntentOutcomeCard';
import { PipelineLifecycle } from './PipelineLifecycle';
import { StageInputs } from './StageInputs';
import { InlineStageOutput } from './InlineStageOutput';
import { readStageExpanded, writeStageExpanded } from './stageExpansion';
import { usePipelineStream } from './usePipelineStream';
import { PipelineErrorBlock } from './PipelineErrorBlock';
import styles from './PipelineDetailView.module.css';

/*
 * Polling cadences for the detail view.
 *
 * SSE_FALLBACK_POLL_MS is the long backstop interval that fires when
 * the SSE stream is connected. The stream pushes updates in
 * milliseconds, so the poll's only job is to catch the rare case
 * where a watcher event was missed (filesystem races, NFS-style
 * out-of-band changes) or the SSE handler invoked invalidateQueries
 * but the cache write itself dropped. 60s is the standard
 * server-sync floor used elsewhere in the Console (live-ops daemon
 * posture, control-status refresh).
 *
 * SSE_DEGRADED_POLL_MS is the cadence when SSE is unavailable
 * entirely (failed/connecting) -- keeps the original 5s polling
 * cadence so the operator-visible freshness does not regress when
 * the stream cannot connect (older Node servers, hostile proxies,
 * etc.).
 */
const SSE_FALLBACK_POLL_MS = 60_000;
const SSE_DEGRADED_POLL_MS = 5_000;

/**
 * Pipeline drill-in view: full chain for one pipeline id.
 *
 * Renders the projection at /api/pipelines.detail in five blocks:
 *   1. Header     -- pipeline_state pill, mode, seed atoms, correlation id
 *   2. Cost block -- total cost, duration, audit count, recovery flag
 *   3. Stages     -- per-stage cards stacked top -> bottom, each
 *                    showing the stage's events (enter / exit / pause /
 *                    resume) with timestamps + duration + cost
 *   4. Findings   -- audit findings ordered by severity, each linking
 *                    to the cited atoms (AtomRef hover-card) and paths
 *   5. Failure    -- when a pipeline-failed atom exists, surface the
 *                    cause + recovery_hint + chain
 *
 * Re-uses the shared FocusBanner so the operator sees an obvious
 * "back to list" affordance + a copyable id chip.
 */
export function PipelineDetailView({ pipelineId }: { pipelineId: string }) {
  /*
   * Open the per-pipeline SSE stream. The hook handles connection,
   * reconnect-on-error (1s -> 2s -> 4s -> 8s -> 16s), and query
   * invalidation. It returns the current connection state so the
   * fallback poll below can tighten its cadence when SSE is down.
   *
   * The SSE hook is the PRIMARY freshness signal; the TanStack Query
   * poll below is a backstop for the (rare) case where a watcher
   * event is missed or the stream cannot connect at all. Operator-
   * visible latency in the happy path is bounded by the server's
   * watcher debounce + a single round-trip on cache invalidate
   * (sub-second), down from the up-to-5s of the legacy polling.
   */
  const streamConnectionState = usePipelineStream(pipelineId);
  const streamIsLive = streamConnectionState === 'open';

  const query = useQuery({
    queryKey: ['pipeline', pipelineId],
    queryFn: ({ signal }) => getPipelineDetail(pipelineId, signal),
    /*
     * Polling cadence is dynamic on the SSE state:
     *   - 'open'  : 60s backstop (SSE handles the operator-visible
     *               freshness; the poll is only a safety net for
     *               missed watcher events).
     *   - any other state ('connecting', 'reconnecting', 'failed'):
     *               5s poll, matching the legacy cadence so the UI
     *               does not visibly regress while SSE is recovering.
     *
     * Stop polling once the pipeline reaches a terminal state
     * (succeeded/failed) or the request errors (404/missing). The
     * org-ceiling case (canon dev-indie-floor-org-ceiling) is
     * several operators pinning detail tabs on terminal pipelines;
     * an unconditional poll would waste backend cycles forever.
     */
    refetchInterval: (queryState) => {
      if (queryState.state.error) return false;
      const state = queryState.state.data?.pipeline.pipeline_state;
      if (state === 'pending' || state === 'running' || state === 'hil-paused') {
        return streamIsLive ? SSE_FALLBACK_POLL_MS : SSE_DEGRADED_POLL_MS;
      }
      return false;
    },
    refetchOnWindowFocus: true,
  });

  /*
   * Track the last *successful* poll timestamp for the freshness pill.
   * `query.dataUpdatedAt` is the canonical TanStack Query signal: it
   * advances on every settled fetchSuccess, sticks across error
   * retries (so the pill keeps ticking against the last good time on
   * a hard poll failure), and is `0` until the first success. Derive
   * directly rather than mirroring into state -- canon
   * `dev-web-no-useeffect-for-data` reserves useEffect for real DOM
   * side effects, and v5's `dataUpdatedAt` already preserves the last
   * successful update across error retries.
   */
  const lastSuccessAt = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null;

  if (query.isPending) {
    return <LoadingState label="Loading pipeline..." testId="pipeline-detail-loading" />;
  }
  /*
   * Top-level error short-circuit only applies when we have NEVER
   * received a successful response (`query.data` is undefined). Once
   * data has landed, refetch errors are non-fatal: the freshness
   * pill ages into the 'stale' state on its own and the operator
   * sees the last-good payload instead of a blanking error wall.
   * This satisfies the spec's "on hard poll failure, keep ticking
   * against last good timestamp - never silently retry with no
   * signal" - the pill IS the signal.
   */
  if (query.isError && query.data === undefined) {
    const err = query.error instanceof Error ? query.error : null;
    const msg = err?.message ?? String(query.error);
    if (msg.includes('pipeline-not-found')) {
      return (
        <EmptyState
          title="Pipeline not found"
          detail={
            <>
              <code>{pipelineId}</code> is not in the atom store.
            </>
          }
          action={
            <button
              type="button"
              className={styles.clearButton}
              onClick={() => setRoute('pipelines')}
            >
              Back to pipelines
            </button>
          }
          testId="pipeline-detail-empty"
        />
      );
    }
    return (
      <ErrorState
        title="Could not load pipeline"
        message={msg}
        testId="pipeline-detail-error"
      />
    );
  }

  return (
    <PipelineDetailBody
      data={query.data!}
      lastSuccessAt={lastSuccessAt}
      streamConnectionState={streamConnectionState}
    />
  );
}

function PipelineDetailBody({
  data,
  lastSuccessAt,
  streamConnectionState,
}: {
  data: PipelineDetail;
  lastSuccessAt: number | null;
  streamConnectionState: ReturnType<typeof usePipelineStream>;
}) {
  const { pipeline, stages, events, findings, audit_counts: audit, failure, resumes } = data;
  /*
   * Detail view paints the same TRUE-outcome pill as the card grid:
   * a 'completed' pipeline that produced no PR (silent-skip /
   * empty-diff) reads as noop, not green succeeded.
   */
  const trueOutcome = deriveTrueOutcome({
    pipeline_state: pipeline.pipeline_state,
    dispatch_summary: data.dispatch_summary,
  });
  const stateTone = trueOutcome === 'unknown'
    ? pipelineStateTone(pipeline.pipeline_state)
    : trueOutcomeTone(trueOutcome);
  // Use trueOutcome as the label whenever it diverges from the raw
  // pipeline_state -- both for noop (succeeded but produced 0 PRs) and
  // for failed (completed pipeline whose dispatch_summary.failed > 0).
  // Without the failed branch the pill renders a RED tone with the
  // text "completed", which is a visual lie: red + completed reads as
  // contradictory and operators have to mouse over to figure out the
  // dispatch failed.
  const pillLabel = (
    trueOutcome === 'noop'
    || (trueOutcome === 'failed' && pipeline.pipeline_state === 'completed')
  )
    ? trueOutcome
    : pipeline.pipeline_state;

  return (
    <section
      className={styles.view}
      data-testid="pipeline-detail-view"
      data-pipeline-stream={streamConnectionState}
    >
      <FocusBanner
        label="Pipeline"
        id={pipeline.id}
        onClear={() => setRoute('pipelines')}
      />

      <PipelineErrorBlock pipelineId={pipeline.id} />

      <IntentOutcomeCard pipelineId={pipeline.id} />

      <header className={styles.detailHead}>
        <div className={styles.detailHeadTop}>
          <span
            className={styles.statePill}
            data-testid="pipeline-detail-state"
            data-pipeline-state={pipeline.pipeline_state}
            data-true-outcome={trueOutcome}
            style={{ borderColor: stateTone, color: stateTone }}
          >
            {pillLabel}
          </span>
          {pipeline.mode && <span className={styles.modeChip}>{pipeline.mode}</span>}
          {failure && (
            <span className={styles.failureBadge}>
              <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
              <span>failed at {failure.failed_stage_name}</span>
            </span>
          )}
          <FreshnessPill
            lastSuccessAt={lastSuccessAt}
            testId="pipeline-detail-freshness"
          />
          {(
            pipeline.pipeline_state === 'pending'
            || pipeline.pipeline_state === 'running'
            || pipeline.pipeline_state === 'hil-paused'
          ) && (
            <AbandonControl pipelineId={pipeline.id} />
          )}
        </div>
        <h2 className={styles.detailTitle}>{pipeline.title}</h2>
        <div className={styles.detailMeta}>
          <span>
            by <PrincipalLink id={pipeline.principal_id} testId="pipeline-detail-principal-link" />
          </span>
          <span aria-hidden="true">{'\u00B7'}</span>
          <span>started {formatRelative(pipeline.started_at)}</span>
          {pipeline.completed_at && (
            <>
              <span aria-hidden="true">{'\u00B7'}</span>
              <span>completed {formatRelative(pipeline.completed_at)}</span>
            </>
          )}
          {pipeline.correlation_id && (
            <>
              <span aria-hidden="true">{'\u00B7'}</span>
              <span>corr <code>{pipeline.correlation_id}</code></span>
            </>
          )}
        </div>
      </header>

      <ul className={styles.statRow} data-testid="pipeline-detail-stats">
        <Stat
          icon={<Coins size={14} strokeWidth={2} aria-hidden="true" />}
          label="Cost"
          value={formatUsd(data.total_cost_usd)}
          testId="pipeline-detail-cost"
        />
        <Stat
          icon={<Clock size={14} strokeWidth={2} aria-hidden="true" />}
          label="Duration"
          value={formatDurationMs(data.total_duration_ms)}
          testId="pipeline-detail-duration"
        />
        <Stat
          icon={<Workflow size={14} strokeWidth={2} aria-hidden="true" />}
          label="Stage"
          value={pipeline.pipeline_state === 'completed'
            ? `${data.total_stages} / ${data.total_stages}`
            : `${data.current_stage_index + 1} / ${data.total_stages || '?'}`}
          testId="pipeline-detail-stage-count"
        />
        <Stat
          icon={<ListChecks size={14} strokeWidth={2} aria-hidden="true" />}
          label="Findings"
          value={`${audit.total}`}
          testId="pipeline-detail-finding-count"
          {...(audit.critical > 0
            ? { tone: 'danger' as const }
            : audit.major > 0
              ? { tone: 'warning' as const }
              : {})}
          {...(audit.total > 0
            ? { detail: `${audit.critical} crit / ${audit.major} maj / ${audit.minor} min` }
            : {})}
        />
      </ul>

      {pipeline.seed_atom_ids.length > 0 && (
        <Section
          icon={<Brain size={14} strokeWidth={2} aria-hidden="true" />}
          title="Seed atoms"
          count={pipeline.seed_atom_ids.length}
          testId="pipeline-detail-seeds"
        >
          <ul className={styles.atomRefList}>
            {pipeline.seed_atom_ids.map((id) => (
              <li key={id}><AtomRef id={id} variant="chip" /></li>
            ))}
          </ul>
        </Section>
      )}

      <AgentTurnsSection turns={data.agent_turns} />

      <Section
        icon={<Workflow size={14} strokeWidth={2} aria-hidden="true" />}
        title="Stages"
        count={stages.length}
        testId="pipeline-detail-stages"
        empty="No stage events recorded yet."
      >
        <ol className={styles.stageList}>
          {stages.map((stage, idx) => (
            <StageCard
              /*
               * Key includes pipeline.id so React's reconciler does not
               * reuse a StageCard instance across two pipelines that
               * happen to share a stage name (every substrate-deep run
               * has the same five stages: brainstorm/spec/plan/review/
               * dispatch). Without the pipeline id in the key, the
               * useState initializer (which reads pipeline-scoped
               * storage) never re-runs on navigation, so expansion
               * state from pipeline A would leak into pipeline B.
               */
              key={`${pipeline.id}:${stage.stage_name}`}
              pipelineId={pipeline.id}
              stage={stage}
              events={events.filter((e) => e.stage_name === stage.stage_name)}
              isLast={idx === stages.length - 1}
            />
          ))}
        </ol>
      </Section>

      <PipelineLifecycle pipelineId={pipeline.id} />

      <Section
        icon={<ListChecks size={14} strokeWidth={2} aria-hidden="true" />}
        title="Audit findings"
        count={findings.length}
        testId="pipeline-detail-findings"
        empty="No audit findings recorded."
      >
        <ul className={styles.findingList}>
          {findings.map((f) => (
            <FindingCard key={f.atom_id} finding={f} />
          ))}
        </ul>
      </Section>

      {failure && (
        <Section
          icon={<ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />}
          title="Failure"
          testId="pipeline-detail-failure"
        >
          <div className={styles.failureBlock} data-testid="pipeline-detail-failure-card">
            <div className={styles.failureRow}>
              <span className={styles.failureLabel}>Stage</span>
              <code className={styles.failureValue}>{failure.failed_stage_name}</code>
              <span className={styles.failureLabel}>Index</span>
              <code className={styles.failureValue}>{failure.failed_stage_index}</code>
            </div>
            <div className={styles.failureCause}>
              <span className={styles.failureLabel}>Cause</span>
              <p>{failure.cause}</p>
            </div>
            <div className={styles.failureCause}>
              <span className={styles.failureLabel}>Recovery hint</span>
              <p>{failure.recovery_hint}</p>
            </div>
            {failure.chain.length > 0 && (
              <div className={styles.failureChain}>
                <span className={styles.failureLabel}>Chain</span>
                <ul className={styles.atomRefList}>
                  {failure.chain.map((id) => (
                    <li key={id}><AtomRef id={id} variant="chip" /></li>
                  ))}
                </ul>
              </div>
            )}
            {failure.truncated && (
              <p className={styles.truncationNote}>
                Chain was truncated by the substrate; full chain available in the atom store.
              </p>
            )}
          </div>
        </Section>
      )}

      {resumes.length > 0 && (
        <Section
          icon={<PlayCircle size={14} strokeWidth={2} aria-hidden="true" />}
          title="HIL resumes"
          count={resumes.length}
          testId="pipeline-detail-resumes"
        >
          <ul className={styles.resumeList}>
            {resumes.map((r) => (
              <li key={r.atom_id} className={styles.resumeRow} data-testid="pipeline-detail-resume-row">
                <span>
                  <strong>{r.stage_name}</strong> resumed by{' '}
                  <PrincipalLink
                    id={r.resumer_principal_id}
                    testId="pipeline-detail-resumer-link"
                  />
                </span>
                <time dateTime={r.at}>{formatRelative(r.at)}</time>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </section>
  );
}

/**
 * "Live progress" section: surfaces per-turn telemetry from any agentic
 * stage that has emitted pipeline-stage-event atoms with
 * `transition='agent-turn'`. Newest-first ordering means the actively
 * running stage's most-recent turn always sits at the top, so the
 * operator sees "what is the agent doing right now" the moment they
 * open the detail view.
 *
 * Read-only display. The detail-view parent already polls every 5s
 * while a pipeline is running/paused (see refetchInterval above); this
 * section inherits that cadence with zero additional state and no
 * extra fetch. Empty-state copy explicitly names the substrate
 * pre-condition (substrate-deep mode + agentic stage) so an operator
 * running single-pass mode does not interpret the empty list as a bug.
 *
 * Test seam (`data-testid` + `data-*` attrs):
 *   - pipeline-detail-agent-turns         : section container
 *   - pipeline-detail-agent-turn-row      : each row
 *   - data-stage-name / data-turn-index / data-atom-id on each row
 */
function AgentTurnsSection({ turns }: { turns: ReadonlyArray<AgentTurnRow> }) {
  if (turns.length === 0) {
    return (
      <section
        className={styles.section}
        data-testid="pipeline-detail-agent-turns"
        data-empty="true"
      >
        <header className={styles.sectionHead}>
          <span className={styles.sectionIcon}>
            <Activity size={14} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3 className={styles.sectionTitle}>Live progress</h3>
          <span className={styles.sectionCount}>0</span>
        </header>
        <p className={styles.sectionEmpty}>
          No agent turns recorded yet. Agentic stages (substrate-deep mode) write per-turn telemetry that appears here as they execute.
        </p>
      </section>
    );
  }

  return (
    <section
      className={styles.section}
      data-testid="pipeline-detail-agent-turns"
      data-empty="false"
    >
      <header className={styles.sectionHead}>
        <span className={styles.sectionIcon}>
          <Activity size={14} strokeWidth={2} aria-hidden="true" />
        </span>
        <h3 className={styles.sectionTitle}>Live progress</h3>
        <span className={styles.sectionCount}>{turns.length}</span>
      </header>
      <ul className={styles.agentTurnList}>
        {turns.map((turn) => (
          <AgentTurnRowItem key={`${turn.stage_name}:${turn.turn_index}:${turn.created_at}`} turn={turn} />
        ))}
      </ul>
    </section>
  );
}

function AgentTurnRowItem({ turn }: { turn: AgentTurnRow }) {
  return (
    <li
      className={styles.agentTurnRow}
      data-testid="pipeline-detail-agent-turn-row"
      data-stage-name={turn.stage_name}
      data-turn-index={turn.turn_index}
      {...(turn.agent_turn_atom_id ? { 'data-atom-id': turn.agent_turn_atom_id } : {})}
    >
      <div className={styles.agentTurnHead}>
        <span className={styles.agentTurnStage}>{turn.stage_name}</span>
        <span className={styles.agentTurnIndex} aria-label={`turn ${turn.turn_index}`}>
          #{turn.turn_index}
        </span>
        <span className={styles.agentTurnTime}>
          <Clock size={11} strokeWidth={2} aria-hidden="true" />
          <time dateTime={turn.created_at}>{formatRelative(turn.created_at)}</time>
        </span>
        {turn.latency_ms !== null && (
          <span className={styles.agentTurnPill} data-kind="latency">
            <Zap size={11} strokeWidth={2} aria-hidden="true" />
            {formatLatencyMs(turn.latency_ms)}
          </span>
        )}
        {/*
         * Render whenever tool_calls_count is a known number (including
         * 0). Hiding the pill on 0 makes a real zero-tool turn
         * indistinguishable from `null` (cross-walk unavailable); the
         * backend preserves that distinction so the UI surfaces it
         * too. CR finding on PR #387.
         */}
        {turn.tool_calls_count !== null && (
          <span className={styles.agentTurnPill} data-kind="tools">
            <Wrench size={11} strokeWidth={2} aria-hidden="true" />
            {turn.tool_calls_count} {turn.tool_calls_count === 1 ? 'tool' : 'tools'}
          </span>
        )}
      </div>
      {turn.llm_input_preview !== null && turn.llm_input_preview.length > 0 && (
        <code className={styles.agentTurnPreview} data-testid="pipeline-detail-agent-turn-preview">
          {turn.llm_input_preview}
        </code>
      )}
    </li>
  );
}

function formatLatencyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function StageCard({
  pipelineId,
  stage,
  events,
  isLast,
}: {
  pipelineId: string;
  stage: PipelineStageSummary;
  events: ReadonlyArray<PipelineStageEvent>;
  isLast: boolean;
}) {
  const tone = stageStateTone(stage.state);
  const stateIcon = stageIcon(stage.state);
  /*
   * Inline-expansion state. Default collapsed; persisted per-pipeline +
   * per-stage via storage.service so a reload restores what the
   * operator was reading. Initial value reads storage synchronously
   * (no useEffect) so the first paint already shows expanded panels
   * without a flash-of-collapsed -- canon dev-web-interaction-quality
   * forbids that visible-jank pattern.
   */
  const [expanded, setExpanded] = useState<boolean>(() =>
    readStageExpanded(pipelineId, stage.stage_name),
  );
  const canExpand = Boolean(stage.output_atom_id);
  const toggleExpand = () => {
    setExpanded((prev) => {
      const next = !prev;
      writeStageExpanded(pipelineId, stage.stage_name, next);
      return next;
    });
  };
  const panelId = `pipeline-stage-output-${pipelineId}-${stage.stage_name}`;

  /*
   * Resume mutation: lifts an HIL-paused pipeline back to running.
   *
   * The resumer principal is derived SERVER-SIDE from
   * `LAG_CONSOLE_ACTOR_ID`. Unlike KillSwitchPill's transition mutation
   * (which passes the client-resolved actor_id to the server), this
   * route is gated by a canon `allowed_resumers` list and trusting a
   * client-supplied identity would let any origin-allowed caller
   * impersonate a principal in that list (CR PR #396 critical
   * finding). The client never sends an actor_id; the server-side
   * `LAG_CONSOLE_ACTOR_ID` is the only authoritative source.
   *
   * The client-side `useCurrentActorId` hook still drives a defensive
   * pre-mutation check: if the server has no actor configured, the
   * mutation surfaces an actionable error at click time instead of a
   * server-side 500. This is a UX guard, not an authorization check.
   *
   * On success, invalidate the pipeline-detail query so the strip
   * re-fetches and the resume atom shows up in the "HIL resumes"
   * section. The substrate writes the same resume atom on disk; the
   * file-watcher picks it up and the next poll reflects the new state.
   */
  const actorId = useCurrentActorId();
  const qc = useQueryClient();
  const resumeMutation = useMutation({
    mutationFn: () => {
      // Pre-mutation UX guard: fail at click time when the server has
      // no actor configured. The server-side check is the authoritative
      // gate (500 server-actor-unset); this is just to surface the
      // error before the network round-trip.
      requireActorId(actorId);
      return resumePipeline({
        pipeline_id: pipelineId,
        reason: `Console resume of ${stage.stage_name}`,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline', pipelineId] });
    },
  });

  return (
    <motion.li
      className={styles.stageCard}
      data-testid="pipeline-stage-card"
      data-stage-name={stage.stage_name}
      data-stage-state={stage.state}
      data-stage-expanded={canExpand && expanded ? 'true' : 'false'}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className={styles.stageRail} aria-hidden="true">
        <span className={styles.stageRailDot} style={{ background: tone }}>
          {stateIcon}
        </span>
        {!isLast && <span className={styles.stageRailLine} />}
      </div>
      <div className={styles.stageBody}>
        <header className={styles.stageHead}>
          <span className={styles.stageIndex}>#{stage.index + 1}</span>
          <h4 className={styles.stageName}>{stage.stage_name}</h4>
          <span
            className={styles.stagePill}
            data-stage-state={stage.state}
            style={{ borderColor: tone, color: tone }}
          >
            {stage.state}
          </span>
          {stage.state === 'paused' && (
            <Tooltip
              content={
                resumeMutation.isError
                  ? `Resume failed: ${(resumeMutation.error as Error).message}`
                  : 'Resume this paused stage. The pipeline state flips to running; the substrate runner picks up the unpause on its next tick.'
              }
              testId="pipeline-stage-resume-tooltip"
            >
              <button
                type="button"
                className={styles.resumeButton}
                data-testid="pipeline-stage-resume"
                data-stage-name={stage.stage_name}
                data-resume-status={
                  resumeMutation.isPending
                    ? 'pending'
                    : resumeMutation.isError
                      ? 'error'
                      : 'idle'
                }
                disabled={resumeMutation.isPending}
                onClick={() => resumeMutation.mutate()}
              >
                {resumeMutation.isPending ? (
                  <Loader2 size={12} strokeWidth={2} aria-hidden="true" className={styles.resumeSpinner} />
                ) : (
                  <PlayCircle size={12} strokeWidth={2} aria-hidden="true" />
                )}
                {resumeMutation.isPending ? 'Resuming...' : 'Resume'}
              </button>
            </Tooltip>
          )}
        </header>
        {stage.input_atom_ids && stage.input_atom_ids.length > 0 && (
          <StageInputs stageName={stage.stage_name} inputAtomIds={stage.input_atom_ids} />
        )}
        <ul className={styles.stageMeta}>
          <li>
            <Clock size={11} strokeWidth={2} aria-hidden="true" />
            {formatDurationMs(stage.duration_ms)}
          </li>
          <li>
            <Coins size={11} strokeWidth={2} aria-hidden="true" />
            {formatUsd(stage.cost_usd)}
          </li>
          {stage.last_event_at && (
            <li>
              <Cpu size={11} strokeWidth={2} aria-hidden="true" />
              {formatRelative(stage.last_event_at)}
            </li>
          )}
        </ul>
        {canExpand && stage.output_atom_id && (
          <div className={styles.stageOutput}>
            <span className={styles.stageMetaLabel}>Output</span>
            <AtomRef id={stage.output_atom_id} variant="chip" />
            <button
              type="button"
              className={styles.expandButton}
              data-testid="pipeline-stage-expand"
              data-stage-name={stage.stage_name}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={toggleExpand}
            >
              {expanded
                ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
                : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
        )}
        {canExpand && expanded && stage.output_atom_id && (
          <div id={panelId}>
            <InlineStageOutput atomId={stage.output_atom_id} />
          </div>
        )}
        <ol className={styles.eventList} data-testid="pipeline-stage-events">
          {events.map((e) => (
            <EventRow key={e.atom_id} event={e} />
          ))}
        </ol>
      </div>
    </motion.li>
  );
}

function EventRow({ event }: { event: PipelineStageEvent }) {
  const transitionLabel = humanizeTransition(event.transition);
  const tone = transitionTone(event.transition);
  // Retry transitions carry attempt_index on the wire shape. Render
  // the "attempt N/total" marker next to the transition label so the
  // operator sees "stage X retrying (audit feedback) attempt 2" rather
  // than just "stage X retrying". The total is not on the event
  // (canon-side dial), so we show only the current attempt; the
  // canon-resolved cap is rendered separately on the stage card when
  // a future enhancement surfaces it.
  const isRetryTransition =
    event.transition === 'retry-after-findings'
    || event.transition === 'validator-retry-after-failure';
  // Render the validator error message inline on the
  // 'validator-retry-after-failure' event so the operator sees WHICH
  // schema-validation error triggered the teach-back -- not just that
  // a retry happened. Mirrors the way auditor-feedback retry events
  // surface findings_summary via the substrate's stamped metadata;
  // both teaching signals belong on the timeline row that minted them.
  // The full message is on `title` attribute so a long zod error is
  // discoverable on hover; the visible row keeps the timeline scannable.
  const validatorMessage = event.transition === 'validator-retry-after-failure'
    ? event.validator_error_message
    : undefined;
  return (
    <li
      className={styles.eventRow}
      data-testid="pipeline-stage-event"
      data-transition={event.transition}
      {...(event.attempt_index !== undefined
        ? { 'data-attempt-index': String(event.attempt_index) }
        : {})}
    >
      <span className={styles.eventArrow} aria-hidden="true" style={{ color: tone }}>
        <ArrowRight size={11} strokeWidth={2} />
      </span>
      <span className={styles.eventTransition} style={{ color: tone }}>{transitionLabel}</span>
      {isRetryTransition && event.attempt_index !== undefined && (
        <span
          className={styles.eventDetail}
          data-testid="pipeline-stage-event-attempt"
          aria-label={`attempt ${event.attempt_index}`}
        >
          attempt {event.attempt_index}
        </span>
      )}
      {validatorMessage !== undefined && (
        <span
          className={styles.eventDetail}
          data-testid="pipeline-stage-event-validator-error"
          title={validatorMessage}
        >
          {validatorMessage}
        </span>
      )}
      <span className={styles.eventTime}>
        <time dateTime={event.at}>{formatRelative(event.at)}</time>
      </span>
      {event.duration_ms > 0 && (
        <span className={styles.eventDetail}>
          <Clock size={10} strokeWidth={2} aria-hidden="true" />
          {formatDurationMs(event.duration_ms)}
        </span>
      )}
      {event.cost_usd > 0 && (
        <span className={styles.eventDetail}>
          <Coins size={10} strokeWidth={2} aria-hidden="true" />
          {formatUsd(event.cost_usd)}
        </span>
      )}
    </li>
  );
}

function FindingCard({ finding }: { finding: PipelineAuditFinding }) {
  const tone = findingSeverityTone(finding.severity);
  return (
    <li
      className={styles.findingCard}
      data-testid="pipeline-finding-card"
      data-severity={finding.severity}
      data-stage={finding.stage_name}
    >
      <header className={styles.findingHead}>
        <span
          className={styles.severityPill}
          style={{ borderColor: tone, color: tone }}
          data-testid="pipeline-finding-severity"
        >
          {finding.severity}
        </span>
        <span className={styles.findingCategory}>{finding.category}</span>
        <span className={styles.findingStage}>at <strong>{finding.stage_name}</strong></span>
      </header>
      <p className={styles.findingMessage}>{finding.message}</p>
      {finding.cited_atom_ids.length > 0 && (
        <div className={styles.citationBlock}>
          <span className={styles.citationLabel}>Cited atoms</span>
          <ul className={styles.atomRefList}>
            {finding.cited_atom_ids.map((id) => (
              <li key={id}><AtomRef id={id} variant="chip" /></li>
            ))}
          </ul>
        </div>
      )}
      {finding.cited_paths.length > 0 && (
        <div className={styles.citationBlock}>
          <span className={styles.citationLabel}>Cited paths</span>
          <ul className={styles.pathList}>
            {finding.cited_paths.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function Stat({
  icon,
  label,
  value,
  testId,
  tone,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  testId?: string;
  tone?: 'danger' | 'warning';
  detail?: string;
}) {
  const cls = [
    styles.stat,
    tone === 'danger' ? styles.statDanger : '',
    tone === 'warning' ? styles.statWarning : '',
  ].filter(Boolean).join(' ');
  return (
    <li className={cls} data-testid={testId}>
      <span className={styles.statIcon}>{icon}</span>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
      {detail && <span className={styles.statDetail}>{detail}</span>}
    </li>
  );
}

function Section({
  icon,
  title,
  count,
  testId,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  testId?: string;
  empty?: string;
  children: React.ReactNode;
}) {
  if (typeof count === 'number' && count === 0) {
    return (
      <section className={styles.section} data-testid={testId}>
        <header className={styles.sectionHead}>
          <span className={styles.sectionIcon}>{icon}</span>
          <h3 className={styles.sectionTitle}>{title}</h3>
          <span className={styles.sectionCount}>0</span>
        </header>
        <p className={styles.sectionEmpty}>{empty ?? 'Nothing recorded.'}</p>
      </section>
    );
  }
  return (
    <section className={styles.section} data-testid={testId}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionIcon}>{icon}</span>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {typeof count === 'number' && <span className={styles.sectionCount}>{count}</span>}
      </header>
      {children}
    </section>
  );
}

function stageIcon(state: string): React.ReactNode {
  switch (state) {
    case 'running':
      return <PlayCircle size={11} strokeWidth={2.25} aria-hidden="true" />;
    case 'paused':
      return <PauseCircle size={11} strokeWidth={2.25} aria-hidden="true" />;
    case 'succeeded':
      return <CheckCircle2 size={11} strokeWidth={2.25} aria-hidden="true" />;
    case 'failed':
      return <XCircle size={11} strokeWidth={2.25} aria-hidden="true" />;
    default:
      return <ChevronRight size={11} strokeWidth={2.25} aria-hidden="true" />;
  }
}

function humanizeTransition(t: string): string {
  switch (t) {
    case 'enter': return 'entered';
    case 'exit-success': return 'exited (success)';
    case 'exit-failure': return 'exited (failure)';
    case 'hil-pause': return 'paused for HIL';
    case 'hil-resume': return 'resumed';
    case 'retry-after-findings': return 'retrying (audit feedback)';
    case 'validator-retry-after-failure': return 'retrying (schema feedback)';
    default: return t;
  }
}

function transitionTone(t: string): string {
  switch (t) {
    case 'enter': return 'var(--status-info)';
    case 'exit-success': return 'var(--status-success)';
    case 'exit-failure': return 'var(--status-danger)';
    case 'hil-pause': return 'var(--status-warning)';
    case 'hil-resume': return 'var(--status-info)';
    case 'retry-after-findings': return 'var(--status-warning)';
    case 'validator-retry-after-failure': return 'var(--status-warning)';
    default: return 'var(--text-secondary)';
  }
}

// Suppress an unused MessageSquare import warning by referencing it.
// MessageSquare is reserved for a future "open recovery thread" CTA
// that will live next to the failure block once the substrate exposes
// a thread id; keeping the import documents that intent without
// shipping the affordance.
const _RESERVED_MESSAGE_ICON = MessageSquare;
void _RESERVED_MESSAGE_ICON;

/*
 * Reason-length bounds mirror the substrate-side constants on
 * pipeline-abandon.ts (REASON_MIN_LENGTH / REASON_MAX_LENGTH). Keeping
 * them locally avoids importing server-side modules into client code;
 * the server is still the authoritative validator (a client that
 * bypasses these bounds will hit a 400 server-side). Drift between
 * the two is caught at PR review (the substrate test asserts both
 * sides agree).
 */
const ABANDON_REASON_MIN_LENGTH = 10;
const ABANDON_REASON_MAX_LENGTH = 500;

/**
 * Operator-facing abandon control. Surfaces a Kill pipeline button in
 * the header for any running or hil-paused pipeline. Clicking opens
 * a confirmation modal with a required free-text reason field; the
 * submit handler posts to /api/pipeline.abandon and invalidates the
 * pipeline-detail query so the UI re-fetches.
 *
 * Identity binding: the abandoner principal is derived SERVER-side
 * from `LAG_CONSOLE_ACTOR_ID`. The client never sends an actor_id;
 * trusting client-supplied identity for a canon-gated write would
 * let any caller who reaches the origin-allowed endpoint impersonate
 * any principal in the allowed_principals list. Mirrors the resume
 * mutation's identity binding (CR PR #396 critical finding).
 *
 * Modal pattern: a controlled state machine (closed / open / pending)
 * gates the UI. Submitting closes the modal on success; the
 * mutation's error state surfaces inline so the operator can retry
 * without re-typing the reason. Escape key + click outside the
 * dialog close the modal as long as the mutation is not in flight.
 */
function AbandonControl({ pipelineId }: { pipelineId: string }) {
  const qc = useQueryClient();
  const actorId = useCurrentActorId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const abandonMutation = useMutation({
    mutationFn: (params: { reason: string }) => {
      /*
       * Client-side actor preflight. Mirrors the resume mutation
       * pattern in StageCard: every console write surface that calls
       * a canon-gated endpoint MUST run requireActorId(actorId)
       * inside mutationFn so the UI fails closed when
       * LAG_CONSOLE_ACTOR_ID is unset on the backend. The server-side
       * 500 server-actor-unset is the authoritative gate; this
       * pre-check surfaces the misconfiguration at click time instead
       * of after the network round-trip (CR PR #402 finding).
       */
      requireActorId(actorId);
      return abandonPipeline({ pipeline_id: pipelineId, reason: params.reason });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline', pipelineId] });
      closeModal();
    },
  });

  /*
   * Shared close helper: reset both the local form state AND the
   * TanStack Query mutation state so re-opening the modal after a
   * 403/409 does not show the stale server error. Every close path
   * (Escape, backdrop click, Cancel button, success handler) routes
   * through this helper for symmetry (CR PR #402 finding).
   */
  const closeModal = () => {
    setOpen(false);
    setReason('');
    setTouched(false);
    abandonMutation.reset();
  };

  const trimmedLength = reason.trim().length;
  const reasonValid =
    trimmedLength >= ABANDON_REASON_MIN_LENGTH
    && trimmedLength <= ABANDON_REASON_MAX_LENGTH;

  /*
   * Close-on-Escape handler. Honors the in-flight guard: an in-flight
   * abandon mutation must complete or fail before the modal closes
   * so the operator does not lose the audit-trail entry mid-write.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !abandonMutation.isPending) {
        closeModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // closeModal is a stable closure (only uses setters + the
    // mutation, both already in deps via abandonMutation.isPending);
    // we intentionally exclude it from the dep array so a stale
    // closure does not race the mutation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, abandonMutation.isPending]);

  /*
   * Auto-focus the reason textarea when the modal opens so the
   * operator can start typing immediately. Canon
   * dev-web-interaction-quality requires preserving focus across
   * re-renders; we focus once on mount via a ref handle.
   */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (open && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open]);

  /*
   * Cross-component open trigger. The PipelineErrorBlock surfaces an
   * Abandon button when a pipeline is halted by the kill switch; it
   * dispatches a 'pipeline-error-abandon' DOM custom event so this
   * existing modal owns the actor-id preflight + reason input rather
   * than the error block re-implementing the dialog. The listener
   * gates on matching pipelineId so two tabs viewing different
   * pipelines do not cross-fire.
   */
  useEffect(() => {
    const onAbandonRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ pipelineId: string }>).detail;
      if (detail?.pipelineId === pipelineId) setOpen(true);
    };
    window.addEventListener('pipeline-error-abandon', onAbandonRequest as EventListener);
    return () => {
      window.removeEventListener(
        'pipeline-error-abandon',
        onAbandonRequest as EventListener,
      );
    };
  }, [pipelineId]);

  return (
    <>
      <Tooltip
        content="Abandon this pipeline. The pipeline state flips to abandoned; the substrate runner halts cleanly before dispatching the next stage. Requires a reason for the audit trail; irreversible."
        testId="pipeline-detail-abandon-tooltip"
      >
        <button
          type="button"
          className={styles.abandonButton}
          data-testid="pipeline-detail-abandon"
          data-pipeline-id={pipelineId}
          onClick={() => setOpen(true)}
        >
          <OctagonX size={12} strokeWidth={2} aria-hidden="true" />
          Abandon
        </button>
      </Tooltip>
      {open && (
        <div
          className={styles.abandonBackdrop}
          data-testid="pipeline-detail-abandon-modal"
          role="presentation"
          onClick={(e) => {
            /*
             * Click-outside-to-close, gated by the in-flight check
             * so the operator does not accidentally cancel an
             * in-progress write. Only close if the click target is
             * the backdrop itself, not a descendant of the dialog.
             */
            if (e.target === e.currentTarget && !abandonMutation.isPending) {
              closeModal();
            }
          }}
        >
          <div
            className={styles.abandonDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`abandon-title-${pipelineId}`}
            aria-describedby={`abandon-body-${pipelineId}`}
          >
            <header className={styles.abandonDialogHead}>
              <span className={styles.abandonDialogIcon} aria-hidden="true">
                <OctagonX size={18} strokeWidth={2} />
              </span>
              <h3
                className={styles.abandonDialogTitle}
                id={`abandon-title-${pipelineId}`}
              >
                Abandon pipeline?
              </h3>
            </header>
            <div className={styles.abandonDialogBody} id={`abandon-body-${pipelineId}`}>
              <p className={styles.abandonDialogText}>
                This stops the pipeline before its next stage dispatches and marks it as
                <strong> abandoned</strong>. The action is irreversible and produces an
                audit-trail atom signed by the configured console actor.
              </p>
              <code
                className={styles.abandonDialogPipelineId}
                data-testid="pipeline-detail-abandon-id"
              >
                {pipelineId}
              </code>
              <label className={styles.abandonDialogReasonLabel}>
                Reason (required)
                <textarea
                  ref={textareaRef}
                  className={styles.abandonDialogReasonInput}
                  data-testid="pipeline-detail-abandon-reason"
                  value={reason}
                  disabled={abandonMutation.isPending}
                  maxLength={ABANDON_REASON_MAX_LENGTH}
                  minLength={ABANDON_REASON_MIN_LENGTH}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setTouched(true);
                  }}
                  onBlur={() => setTouched(true)}
                  placeholder="Why are you abandoning this pipeline? (10-500 characters)"
                  rows={4}
                />
                <span className={styles.abandonDialogReasonHint}>
                  <span
                    data-testid="pipeline-detail-abandon-reason-count"
                    {...(touched && !reasonValid
                      ? { className: styles.abandonDialogReasonError }
                      : {})}
                  >
                    {trimmedLength} / {ABANDON_REASON_MAX_LENGTH} characters
                  </span>
                  {touched && trimmedLength > 0 && trimmedLength < ABANDON_REASON_MIN_LENGTH && (
                    <span
                      className={styles.abandonDialogReasonError}
                      data-testid="pipeline-detail-abandon-reason-error"
                    >
                      Minimum {ABANDON_REASON_MIN_LENGTH} characters
                    </span>
                  )}
                </span>
              </label>
              {abandonMutation.isError && (
                <p
                  className={styles.abandonDialogServerError}
                  data-testid="pipeline-detail-abandon-server-error"
                  role="alert"
                >
                  {(abandonMutation.error as Error).message}
                </p>
              )}
            </div>
            <footer className={styles.abandonDialogActions}>
              <button
                type="button"
                className={styles.abandonDialogCancel}
                data-testid="pipeline-detail-abandon-cancel"
                disabled={abandonMutation.isPending}
                onClick={closeModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.abandonDialogSubmit}
                data-testid="pipeline-detail-abandon-submit"
                data-abandon-status={
                  abandonMutation.isPending
                    ? 'pending'
                    : abandonMutation.isError
                      ? 'error'
                      : 'idle'
                }
                disabled={!reasonValid || abandonMutation.isPending}
                onClick={() => {
                  setTouched(true);
                  if (!reasonValid) return;
                  abandonMutation.mutate({ reason: reason.trim() });
                }}
              >
                {abandonMutation.isPending ? (
                  <Loader2 size={14} strokeWidth={2} aria-hidden="true" className={styles.resumeSpinner} />
                ) : (
                  <OctagonX size={14} strokeWidth={2} aria-hidden="true" />
                )}
                {abandonMutation.isPending ? 'Abandoning...' : 'Abandon pipeline'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
