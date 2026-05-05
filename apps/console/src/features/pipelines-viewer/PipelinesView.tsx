import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { AlertTriangle, Clock, Coins, ListChecks, Workflow } from 'lucide-react';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { listPipelines, type PipelineSummary } from '@/services/pipelines.service';
import { toErrorMessage } from '@/services/errors';
import { storage } from '@/services/storage.service';
import { setRoute, useRouteId, routeHref } from '@/state/router.store';
import { PipelineDetailView } from './PipelineDetailView';
import { pipelineStateTone } from './tones';
import {
  bucketForPipelineState,
  matchesBucket,
  normalizeBucket,
  PIPELINE_FILTER_STORAGE_KEY,
  DEFAULT_PIPELINE_FILTER,
  type PipelineStateBucket,
} from './pipelineStateFilter';
import styles from './PipelinesView.module.css';

/**
 * Pipelines list + drill-in routing.
 *
 * Operator concerns this view answers at a glance:
 *   - which pipelines are running right now
 *   - which paused at a HIL gate (and where)
 *   - which failed (and at which stage)
 *   - cost + duration roll-ups so a regressive run is visible
 *
 * The drill-in (`/pipelines/<id>`) lives in `PipelineDetailView`; this
 * file owns the list grid plus the bucket-filter chip row. When a
 * focus id is in the URL we delegate the entire render to the detail
 * view so the operator never sees the grid + an empty "Pipeline not
 * found" card stacked. List default bucket is `all` because pipelines
 * are intentionally low-volume and filtering away on first load would
 * hide most rows.
 */
export function PipelinesView() {
  const focusId = useRouteId();
  if (focusId) return <PipelineDetailView pipelineId={focusId} />;
  return <PipelinesList />;
}

function PipelinesList() {
  const query = useQuery({
    queryKey: ['pipelines'],
    queryFn: ({ signal }) => listPipelines(signal),
  });

  const [bucket, setBucket] = useState<PipelineStateBucket>(
    () => normalizeBucket(storage.get<unknown>(PIPELINE_FILTER_STORAGE_KEY)) ?? DEFAULT_PIPELINE_FILTER,
  );

  const handleBucketChange = (next: PipelineStateBucket) => {
    setBucket(next);
    storage.set(PIPELINE_FILTER_STORAGE_KEY, next);
  };

  const allPipelines = query.data?.pipelines ?? [];

  const counts = useMemo(() => {
    // `unknown` covers any pipeline_state the UI does not have a chip
    // for yet (future state, malformed atom). Tracked separately so a
    // new state never silently inflates the Running count.
    const c: Record<PipelineStateBucket, number> = {
      running: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
      all: allPipelines.length,
    };
    for (const p of allPipelines) {
      const b = bucketForPipelineState(p.pipeline_state);
      c[b] += 1;
    }
    return c;
  }, [allPipelines]);

  const pipelines = useMemo(
    () => allPipelines.filter((p) => matchesBucket(p.pipeline_state, bucket)),
    [allPipelines, bucket],
  );

  const filteredOut = allPipelines.length > 0 && pipelines.length === 0;

  return (
    <section className={styles.view} data-testid="pipelines-view">
      <header className={styles.intro}>
        <h2 className={styles.heroTitle}>Pipelines</h2>
        <p className={styles.heroSubtitle}>
          Deep planning runs across brainstorm, spec, plan, review, and dispatch stages.
          Each row stitches the substrate atom chain into a single pipeline-shape projection.
        </p>
      </header>

      {query.isPending && <LoadingState label="Loading pipelines..." testId="pipelines-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load pipelines"
          message={toErrorMessage(query.error)}
          testId="pipelines-error"
        />
      )}
      {query.isSuccess && allPipelines.length === 0 && (
        <EmptyState
          title="No pipelines have run yet"
          detail="Pipelines appear here once a planning run mints a `pipeline` atom. Trigger a run via the cto-actor flow with mode=substrate-deep to see one materialize."
          testId="pipelines-empty"
        />
      )}
      {query.isSuccess && allPipelines.length > 0 && (
        <>
          <StatsHeader
            total={pipelines.length}
            label={`pipeline${pipelines.length === 1 ? '' : 's'}`}
            detail={bucket === 'all' ? undefined : `of ${allPipelines.length} (${bucket})`}
          />
          <PipelineFilterChips bucket={bucket} counts={counts} onChange={handleBucketChange} />
          {filteredOut && (
            <EmptyState
              title="No pipelines match this filter"
              detail={
                <>
                  Nothing in the <code>{bucket}</code> bucket right now.{' '}
                  <button
                    type="button"
                    className={styles.inlineLink}
                    onClick={() => handleBucketChange('all')}
                    data-testid="pipelines-filter-show-all"
                  >
                    Show all {allPipelines.length}
                  </button>
                </>
              }
              testId="pipelines-filter-empty"
            />
          )}
          {!filteredOut && (
            /*
             * Two-stack masonry: pipelines distributed by index parity
             * into left/right stacks. Mirrors the Plans grid pattern
             * per `arch-masonry-two-stack-pattern`. Each stack is a
             * flex column so card height variation does not cause
             * sibling re-layout when expanding/collapsing later.
             */
            <div className={styles.grid}>
              <div className={styles.stack}>
                {pipelines.filter((_, i) => i % 2 === 0).map((p, idx) => (
                  <PipelineCard key={p.pipeline_id} pipeline={p} index={idx} />
                ))}
              </div>
              <div className={styles.stack}>
                {pipelines.filter((_, i) => i % 2 === 1).map((p, idx) => (
                  <PipelineCard key={p.pipeline_id} pipeline={p} index={idx} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const FILTER_LABELS: ReadonlyArray<{ bucket: PipelineStateBucket; label: string }> = [
  { bucket: 'running', label: 'Running' },
  { bucket: 'paused', label: 'Paused' },
  { bucket: 'completed', label: 'Completed' },
  { bucket: 'failed', label: 'Failed' },
  { bucket: 'all', label: 'All' },
];

function PipelineFilterChips({
  bucket,
  counts,
  onChange,
}: {
  bucket: PipelineStateBucket;
  counts: Readonly<Record<PipelineStateBucket, number>>;
  onChange: (next: PipelineStateBucket) => void;
}) {
  return (
    <nav
      className={styles.filterChips}
      aria-label="Filter pipelines by state"
      data-testid="pipelines-filter-chips"
    >
      {FILTER_LABELS.map(({ bucket: b, label }) => {
        const selected = bucket === b;
        return (
          <button
            key={b}
            type="button"
            className={`${styles.filterChip} ${selected ? styles.filterChipSelected : ''}`}
            aria-pressed={selected}
            data-testid={`pipelines-filter-chip-${b}`}
            data-bucket={b}
            onClick={() => onChange(b)}
          >
            <span className={styles.filterChipLabel}>{label}</span>
            <span className={styles.filterChipCount}>{counts[b]}</span>
          </button>
        );
      })}
    </nav>
  );
}

function PipelineCard({ pipeline, index }: { pipeline: PipelineSummary; index: number }) {
  const tone = pipelineStateTone(pipeline.pipeline_state);
  const progress = pipeline.total_stages > 0
    ? (pipeline.current_stage_index + 1) / pipeline.total_stages
    : 0;
  const totalCost = formatUsd(pipeline.total_cost_usd);
  const duration = formatDurationMs(pipeline.total_duration_ms);
  const audit = pipeline.audit_counts;
  return (
    <motion.article
      className={styles.card}
      data-testid="pipeline-card"
      data-pipeline-id={pipeline.pipeline_id}
      data-pipeline-state={pipeline.pipeline_state}
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
        setRoute('pipelines', pipeline.pipeline_id);
      }}
    >
      <header className={styles.cardHead}>
        <span
          className={styles.statePill}
          data-testid="pipeline-card-state"
          data-pipeline-state={pipeline.pipeline_state}
          style={{ borderColor: tone, color: tone }}
        >
          {pipeline.pipeline_state}
        </span>
        {pipeline.mode && <span className={styles.modeChip}>{pipeline.mode}</span>}
        <code className={styles.cardId}>{pipeline.pipeline_id}</code>
      </header>

      <h3 className={styles.cardTitle}>
        <a
          className={styles.titleLink}
          href={routeHref('pipelines', pipeline.pipeline_id)}
          data-testid="pipeline-card-link"
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute('pipelines', pipeline.pipeline_id);
          }}
        >
          {pipeline.title}
        </a>
      </h3>

      <div className={styles.progressBlock}>
        <div className={styles.progressLabel}>
          <Workflow size={12} strokeWidth={2} aria-hidden="true" />
          {pipeline.current_stage_name
            ? <>Stage {pipeline.current_stage_index + 1} of {pipeline.total_stages || '?'} {'\u00B7'} {pipeline.current_stage_name}</>
            : <>{pipeline.total_stages > 0 ? `${pipeline.total_stages} stages registered` : 'No stage events yet'}</>}
        </div>
        <div
          className={styles.progressBar}
          data-testid="pipeline-card-progress"
          data-progress-fraction={progress.toFixed(3)}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className={styles.progressFill}
            style={{ width: `${Math.min(100, Math.max(0, Math.round(progress * 100)))}%`, background: tone }}
          />
        </div>
      </div>

      <ul className={styles.metaRow}>
        <Meta
          icon={<Coins size={12} strokeWidth={2} aria-hidden="true" />}
          label={totalCost}
          testId="pipeline-card-cost"
        />
        <Meta
          icon={<Clock size={12} strokeWidth={2} aria-hidden="true" />}
          label={duration}
          testId="pipeline-card-duration"
        />
        <Meta
          icon={<ListChecks size={12} strokeWidth={2} aria-hidden="true" />}
          label={`${audit.total} finding${audit.total === 1 ? '' : 's'}`}
          testId="pipeline-card-findings"
          {...(audit.critical > 0
            ? { tone: 'danger' as const }
            : audit.major > 0
              ? { tone: 'warning' as const }
              : {})}
        />
        {pipeline.has_failed_atom && (
          <Meta
            icon={<AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />}
            label="Failed"
            testId="pipeline-card-failed-flag"
            tone="danger"
          />
        )}
      </ul>

      <footer className={styles.cardFoot}>
        <span>by {pipeline.principal_id}</span>
        <span aria-hidden="true">{'\u00B7'}</span>
        <time dateTime={pipeline.last_event_at}>{formatRelative(pipeline.last_event_at)}</time>
      </footer>
    </motion.article>
  );
}

interface MetaProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly testId?: string;
  readonly tone?: 'danger' | 'warning';
}

function Meta({ icon, label, testId, tone }: MetaProps) {
  const cls = [
    styles.meta,
    tone === 'danger' ? styles.metaDanger : '',
    tone === 'warning' ? styles.metaWarning : '',
  ].filter(Boolean).join(' ');
  return (
    <li className={cls} data-testid={testId}>
      <span className={styles.metaIcon}>{icon}</span>
      <span>{label}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Formatters (shared with the detail view via re-export).
// ---------------------------------------------------------------------------

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${(ageSec / 3600).toFixed(1)}h ago`;
  return new Date(ts).toLocaleString();
}

// Re-export the focus banner so future refactors that move it around
// don't require chasing imports across the feature.
export { FocusBanner };
