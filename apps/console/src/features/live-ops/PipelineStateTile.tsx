import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import {
  ErrorState,
} from '@/components/state-display/StateDisplay';
import {
  getPulsePipelineSummary,
  type PulsePipelineSummary,
  type PulsePipelineSummaryRow,
} from '@/services/live-ops.service';
import { setRoute, setRouteQuery } from '@/state/router.store';
import { toErrorMessage } from '@/services/errors';
import liveOpsStyles from './LiveOpsView.module.css';
import styles from './PipelineStateTile.module.css';

/**
 * PipelineStateTile -- "what is the autonomous loop doing right now?"
 * at a glance.
 *
 * Renders three counts:
 *   - Running                  : pipelines in flight (pipeline_state
 *                                 pending or running)
 *   - Dispatched, awaiting merge: pipelines with an open PR not yet
 *                                  merged or closed
 *   - Intent fulfilled         : pipelines whose operator-intent
 *                                 produced a merged PR (TRUE-outcome
 *                                 semantics: real merged PR observed,
 *                                 NOT plan_state alone)
 *
 * Server-side aggregation per canon `dev-indie-floor-org-ceiling`:
 * shipping every pipeline atom on a 2s tick would scale poorly at
 * 50+ concurrent actors. The /api/pulse.pipeline-summary endpoint
 * rolls every clean+live pipeline atom through the same
 * `buildIntentOutcome` synthesizer the /pipelines/<id> detail view
 * uses, so the "fulfilled" definition is identical across surfaces.
 *
 * Read-only by construction: every interaction is navigation, never a
 * mutation. The tile clicks navigate to /pipelines with the relevant
 * query-param filter so the operator can drill into the active set
 * without losing their place on the dashboard.
 */

/**
 * Refresh cadence aligned with the rest of the Pulse dashboard so the
 * tile counts feel coherent with the surrounding surfaces. The
 * LiveOpsView itself uses 2_000ms; we mirror it here.
 */
const REFRESH_INTERVAL_MS = 2_000;

type BucketKey = 'running' | 'dispatched_pending_merge' | 'intent_fulfilled';

interface BucketConfig {
  readonly key: BucketKey;
  readonly label: string;
  readonly className: string;
  readonly testId: string;
  /**
   * Closure invoked when the bucket header is clicked. Each bucket
   * navigates to /pipelines, with a state filter when the bucket maps
   * cleanly to the existing pipeline-state filter chip-row. The
   * dispatched-pending and intent-fulfilled buckets do NOT map to a
   * single `pipeline_state` value (they are intent-outcome derived),
   * so they navigate to /pipelines with no filter and let the operator
   * choose a chip from the existing row.
   */
  readonly onNavigate: () => void;
  readonly emptyMessage: string;
}

function navigateToPipelinesWithState(state: string | null): void {
  setRoute('pipelines');
  // setRouteQuery operates on the CURRENT pathname; after the setRoute
  // call above the current location is /pipelines, so this places the
  // filter on the right surface. Clearing with null keeps the URL
  // clean when the bucket doesn't carry a filter.
  setRouteQuery({ state });
}

const BUCKETS: ReadonlyArray<BucketConfig> = [
  {
    key: 'running',
    label: 'Running',
    className: styles.bucketRunning,
    testId: 'pulse-pipeline-tile-running',
    onNavigate: () => navigateToPipelinesWithState('running'),
    emptyMessage: 'Nothing in flight.',
  },
  {
    key: 'dispatched_pending_merge',
    label: 'Awaiting merge',
    className: styles.bucketPendingMerge,
    testId: 'pulse-pipeline-tile-pending-merge',
    onNavigate: () => navigateToPipelinesWithState(null),
    emptyMessage: 'No PRs awaiting merge.',
  },
  {
    key: 'intent_fulfilled',
    label: 'Intent fulfilled',
    className: styles.bucketFulfilled,
    testId: 'pulse-pipeline-tile-fulfilled',
    onNavigate: () => navigateToPipelinesWithState(null),
    emptyMessage: 'No fulfilled intents yet.',
  },
];

/**
 * Map a bucket key to its sample row list. Centralized so the bucket
 * renderer doesn't need to switch on the key inside the render path.
 */
function samplesForBucket(
  data: PulsePipelineSummary,
  key: BucketKey,
): ReadonlyArray<PulsePipelineSummaryRow> {
  switch (key) {
    case 'running':
      return data.samples.running;
    case 'dispatched_pending_merge':
      return data.samples.dispatched_pending_merge;
    case 'intent_fulfilled':
      return data.samples.intent_fulfilled;
  }
}

function countForBucket(data: PulsePipelineSummary, key: BucketKey): number {
  switch (key) {
    case 'running':
      return data.running;
    case 'dispatched_pending_merge':
      return data.dispatched_pending_merge;
    case 'intent_fulfilled':
      return data.intent_fulfilled;
  }
}

export function PipelineStateTile() {
  const query = useQuery({
    queryKey: ['pulse.pipeline-summary'],
    queryFn: ({ signal }) => getPulsePipelineSummary(signal),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  return (
    <section
      className={liveOpsStyles.tile}
      data-testid="pulse-pipeline-tile"
    >
      <header className={liveOpsStyles.tileHead}>
        <span className={liveOpsStyles.tileIcon} aria-hidden="true">
          <Layers size={16} strokeWidth={2} />
        </span>
        <div className={liveOpsStyles.tileTitleBlock}>
          <h3 className={liveOpsStyles.tileTitle}>Pipeline state</h3>
          <p className={liveOpsStyles.tileSubtitle}>
            Running, awaiting merge, intent fulfilled
          </p>
        </div>
      </header>
      <div className={liveOpsStyles.tileBody}>
        {query.isPending && (
          <p className={styles.empty} data-testid="pulse-pipeline-tile-loading">
            Loading...
          </p>
        )}
        {query.isError && (
          <ErrorState
            title="Failed to load pipeline summary"
            message={toErrorMessage(query.error)}
            testId="pulse-pipeline-tile-error"
          />
        )}
        {query.isSuccess && <Buckets data={query.data} />}
      </div>
    </section>
  );
}

function Buckets({ data }: { data: PulsePipelineSummary }) {
  return (
    <div className={styles.bucketGrid} data-testid="pulse-pipeline-tile-grid">
      {BUCKETS.map((bucket) => (
        <Bucket
          key={bucket.key}
          config={bucket}
          count={countForBucket(data, bucket.key)}
          samples={samplesForBucket(data, bucket.key)}
        />
      ))}
    </div>
  );
}

function Bucket({
  config,
  count,
  samples,
}: {
  config: BucketConfig;
  count: number;
  samples: ReadonlyArray<PulsePipelineSummaryRow>;
}) {
  return (
    <div
      className={`${styles.bucket} ${config.className}`}
      data-testid={config.testId}
      data-bucket={config.key}
    >
      <button
        type="button"
        className={styles.bucketHeader}
        onClick={config.onNavigate}
        data-testid={`${config.testId}-header`}
      >
        <span
          className={styles.bucketCount}
          data-testid={`${config.testId}-count`}
        >
          {count}
        </span>
        <span className={styles.bucketLabel}>{config.label}</span>
      </button>
      {samples.length === 0 ? (
        <p
          className={styles.empty}
          data-testid={`${config.testId}-empty`}
        >
          {config.emptyMessage}
        </p>
      ) : (
        <ul
          className={styles.bucketSample}
          data-testid={`${config.testId}-samples`}
        >
          {samples.map((row) => (
            <SampleRow key={row.pipeline_id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SampleRow({ row }: { row: PulsePipelineSummaryRow }) {
  const href = `/pipelines/${encodeURIComponent(row.pipeline_id)}`;
  return (
    <li
      className={styles.sampleRow}
      data-testid="pulse-pipeline-tile-sample-row"
      data-pipeline-id={row.pipeline_id}
    >
      <a
        className={styles.sampleLink}
        href={href}
        onClick={(e) => {
          /*
           * Honor cmd-click / ctrl-click / new-tab gestures by falling
           * through to the browser's default; intercept only the plain
           * left click so the SPA stays a single-page navigation.
           * Mirrors the PipelineRow pattern in LiveOpsView.tsx.
           */
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('pipelines', row.pipeline_id);
        }}
      >
        <span className={styles.sampleTitle}>{row.title}</span>
        <span className={styles.sampleAge}>{formatRelative(row.last_event_at)}</span>
      </a>
    </li>
  );
}

/**
 * Render a UTC ISO string as a relative duration ("3m ago", "1h ago").
 * Mirrors the formatRelative in LiveOpsView.tsx; the two could be
 * extracted into a shared helper module per `dev-extract-at-n=2`, but
 * the formatter set lives entirely inside the live-ops feature today
 * so an in-feature copy is the lower-cost path until a third caller
 * forces the extraction.
 */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${(ageSec / 3600).toFixed(1)}h ago`;
  return `${(ageSec / 86400).toFixed(1)}d ago`;
}
