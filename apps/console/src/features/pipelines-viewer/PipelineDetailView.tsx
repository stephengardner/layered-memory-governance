import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowRight, Brain, CheckCircle2, ChevronRight, Clock, Coins, Cpu, ListChecks, MessageSquare, PauseCircle, PlayCircle, ShieldAlert, Workflow, XCircle } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import {
  getPipelineDetail,
  type PipelineAuditFinding,
  type PipelineDetail,
  type PipelineStageEvent,
  type PipelineStageSummary,
} from '@/services/pipelines.service';
import { setRoute } from '@/state/router.store';
import {
  findingSeverityTone,
  pipelineStateTone,
  stageStateTone,
} from './tones';
import { formatDurationMs, formatRelative, formatUsd } from './PipelinesView';
import { PipelineLifecycle } from './PipelineLifecycle';
import styles from './PipelineDetailView.module.css';

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
  const query = useQuery({
    queryKey: ['pipeline', pipelineId],
    queryFn: ({ signal }) => getPipelineDetail(pipelineId, signal),
    /*
     * Polling cadence: a running pipeline writes a new event atom
     * roughly every 30s in substrate-deep mode. 5s gives the operator
     * a near-live view without hammering the backend; the cap is
     * larger than the smallest stage to ensure progress visible.
     * Mirrors the live-ops 2s cadence in spirit but at a tier the
     * detail surface justifies (it's not the at-a-glance dashboard).
     *
     * Stop polling once the pipeline reaches a terminal state
     * (succeeded/failed) or the request errors (404/missing). The
     * org-ceiling case (canon dev-indie-floor-org-ceiling) is several
     * operators pinning detail tabs on terminal pipelines; an
     * unconditional 5s poll would waste backend cycles forever.
     */
    refetchInterval: (queryState) => {
      if (queryState.state.error) return false;
      const state = queryState.state.data?.pipeline.pipeline_state;
      if (state === 'pending' || state === 'running' || state === 'hil-paused') {
        return 5000;
      }
      return false;
    },
    refetchOnWindowFocus: true,
  });

  if (query.isPending) {
    return <LoadingState label="Loading pipeline..." testId="pipeline-detail-loading" />;
  }
  if (query.isError) {
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

  return <PipelineDetailBody data={query.data} />;
}

function PipelineDetailBody({ data }: { data: PipelineDetail }) {
  const { pipeline, stages, events, findings, audit_counts: audit, failure, resumes } = data;
  const stateTone = pipelineStateTone(pipeline.pipeline_state);

  return (
    <section className={styles.view} data-testid="pipeline-detail-view">
      <FocusBanner
        label="Pipeline"
        id={pipeline.id}
        onClear={() => setRoute('pipelines')}
      />

      <header className={styles.detailHead}>
        <div className={styles.detailHeadTop}>
          <span
            className={styles.statePill}
            data-testid="pipeline-detail-state"
            data-pipeline-state={pipeline.pipeline_state}
            style={{ borderColor: stateTone, color: stateTone }}
          >
            {pipeline.pipeline_state}
          </span>
          {pipeline.mode && <span className={styles.modeChip}>{pipeline.mode}</span>}
          {failure && (
            <span className={styles.failureBadge}>
              <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
              <span>failed at {failure.failed_stage_name}</span>
            </span>
          )}
        </div>
        <h2 className={styles.detailTitle}>{pipeline.title}</h2>
        <div className={styles.detailMeta}>
          <span>by {pipeline.principal_id}</span>
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
              key={stage.stage_name}
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
                  <strong>{r.stage_name}</strong> resumed by <code>{r.resumer_principal_id}</code>
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

function StageCard({
  stage,
  events,
  isLast,
}: {
  stage: PipelineStageSummary;
  events: ReadonlyArray<PipelineStageEvent>;
  isLast: boolean;
}) {
  const tone = stageStateTone(stage.state);
  const stateIcon = stageIcon(stage.state);
  return (
    <motion.li
      className={styles.stageCard}
      data-testid="pipeline-stage-card"
      data-stage-name={stage.stage_name}
      data-stage-state={stage.state}
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
            <button
              type="button"
              className={styles.resumeButton}
              data-testid="pipeline-stage-resume"
              data-stage-name={stage.stage_name}
              disabled
              title="Resume action wires through the operator CLI; UI affordance pending substrate gate"
            >
              <PlayCircle size={12} strokeWidth={2} aria-hidden="true" />
              Resume
            </button>
          )}
        </header>
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
        {stage.output_atom_id && (
          <div className={styles.stageOutput}>
            <span className={styles.stageMetaLabel}>Output</span>
            <AtomRef id={stage.output_atom_id} variant="chip" />
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
  return (
    <li
      className={styles.eventRow}
      data-testid="pipeline-stage-event"
      data-transition={event.transition}
    >
      <span className={styles.eventArrow} aria-hidden="true" style={{ color: tone }}>
        <ArrowRight size={11} strokeWidth={2} />
      </span>
      <span className={styles.eventTransition} style={{ color: tone }}>{transitionLabel}</span>
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
