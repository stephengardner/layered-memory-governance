import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertOctagon, CheckCircle2, ExternalLink, GitMerge, Loader2, MinusCircle, PauseCircle, Target, XCircle } from 'lucide-react';
import { ErrorState } from '@/components/state-display/StateDisplay';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import {
  getIntentOutcome,
  type IntentOutcome,
  type IntentOutcomeState,
} from '@/services/pipelines.service';
import { formatDurationMs, formatRelative } from './PipelinesView';
import styles from './IntentOutcomeCard.module.css';

/**
 * Top-level "Intent outcome" card for /pipelines/<id>.
 *
 * The 5 stage cards + post-dispatch lifecycle below render the chain
 * step-by-step. This card aggregates the entire chain into one
 * answer to "did the operator's intent ship a PR yet?" so an
 * operator does not have to scroll + mentally fold to find out.
 *
 * State model lives on the server (`buildIntentOutcome`) so the
 * derivation is unit-testable in isolation and the wire shape stays
 * stable across consumers (this card today; a future Slack /pipelines
 * surface tomorrow). The component is dumb-ish: it renders the state
 * pill + summary + secondary lines based on what comes back; the
 * server owns the truth.
 *
 * Polling: 5s while the pipeline is running OR the PR is still under
 * review. Stops once the state is terminal (fulfilled / dispatch-failed
 * / abandoned).
 */
export function IntentOutcomeCard({ pipelineId }: { pipelineId: string }) {
  const query = useQuery({
    queryKey: ['pipeline', pipelineId, 'intent-outcome'],
    queryFn: ({ signal }) => getIntentOutcome(pipelineId, signal),
    refetchInterval: (queryState) => {
      const err = queryState.state.error;
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('pipeline-not-found')) return 10_000;
        // Generic error: slow-poll instead of stopping. A transient
        // 5xx or network blip should self-heal once the backend is
        // back, not strand the card on the error state forever.
        return 30_000;
      }
      const data = queryState.state.data;
      if (!data) return 5000;
      if (data.state === 'intent-running' || data.state === 'intent-dispatched-pending-review') {
        return 5000;
      }
      // Terminal states (fulfilled / dispatch-failed / paused /
      // abandoned / unknown) slow-poll rather than stopping. A
      // late-landing merge atom or a paused pipeline that resumes
      // should refresh the card without forcing the operator to
      // reload the page; 30s is gentle on the backend while still
      // closing the self-heal gap.
      return 30_000;
    },
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('pipeline-not-found')) return false;
      return failureCount < 2;
    },
  });

  if (query.isPending) {
    return <CardShell><LoadingShimmer /></CardShell>;
  }

  if (query.isError) {
    const err = query.error instanceof Error ? query.error : null;
    const msg = err?.message ?? String(query.error);
    if (msg.includes('pipeline-not-found')) {
      return (
        <CardShell>
          <p className={styles.empty} data-testid="intent-outcome-empty">
            No atoms reference this pipeline yet. Outcome will appear here as soon as the chain lands.
          </p>
        </CardShell>
      );
    }
    return (
      <CardShell>
        <ErrorState
          title="Could not load intent outcome"
          message={msg}
          testId="intent-outcome-error"
        />
      </CardShell>
    );
  }

  return <CardBody data={query.data} />;
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section className={styles.card} data-testid="intent-outcome-card">
      <header className={styles.head}>
        <span className={styles.headIcon} aria-hidden="true">
          <Target size={14} strokeWidth={2} />
        </span>
        <h3 className={styles.headTitle}>Intent outcome</h3>
      </header>
      {children}
    </section>
  );
}

function LoadingShimmer() {
  /*
   * Skeleton placeholder during the first fetch. Avoids the
   * blank-to-content flicker the dev-web-app-grade-polish rule
   * specifically forbids; the card occupies its eventual footprint
   * the moment the page renders.
   */
  return (
    <div className={styles.shimmer} data-testid="intent-outcome-loading">
      <div className={styles.shimmerPill} />
      <div className={styles.shimmerLine} />
      <div className={styles.shimmerLineShort} />
    </div>
  );
}

function CardBody({ data }: { data: IntentOutcome }) {
  const reduceMotion = useReducedMotion();
  const motionProps = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0 } }
    : {
      initial: { opacity: 0, y: 6 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.22 },
    };
  const tone = stateTone(data.state);
  return (
    <motion.section
      className={styles.card}
      data-testid="intent-outcome-card"
      data-state={data.state}
      data-tone={tone}
      {...motionProps}
    >
      <header className={styles.head}>
        <span className={styles.headIcon} aria-hidden="true" data-tone={tone}>
          <Target size={14} strokeWidth={2} />
        </span>
        <h3 className={styles.headTitle}>Intent outcome</h3>
      </header>
      <div className={styles.body}>
        <div className={styles.pillRow}>
          <span
            className={styles.pill}
            data-testid="intent-outcome-state"
            data-tone={tone}
            data-state={data.state}
          >
            <StateIcon state={data.state} />
            <span>{prettyState(data.state)}</span>
          </span>
          {data.dispatched_count > 0 && (
            <span className={styles.dispatchPill} data-testid="intent-outcome-dispatched-count">
              {data.dispatched_count} {data.dispatched_count === 1 ? 'PR' : 'PRs'} dispatched
            </span>
          )}
        </div>
        <p className={styles.summary} data-testid="intent-outcome-summary">
          {data.summary}
        </p>
        {(data.pr_number || data.pr_merged_at) && <PrSection data={data} />}
        {data.skip_reasons.length > 0 && <SkipReasonSection data={data} />}
        <MetaSection data={data} />
      </div>
    </motion.section>
  );
}

function PrSection({ data }: { data: IntentOutcome }) {
  return (
    <div className={styles.prSection} data-testid="intent-outcome-pr-section">
      <div className={styles.prRow}>
        {data.pr_number && data.pr_url && (
          <a
            className={styles.prLink}
            href={data.pr_url}
            target="_blank"
            rel="noreferrer"
            data-testid="intent-outcome-pr-link"
          >
            PR #{data.pr_number}
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        )}
        {data.pr_number && !data.pr_url && (
          <span className={styles.prLink}>PR #{data.pr_number}</span>
        )}
        {data.pr_title && (
          <span className={styles.prTitle}>{data.pr_title}</span>
        )}
      </div>
      {(data.merge_commit_sha || data.pr_merged_at) && (
        <div className={styles.prMeta}>
          {data.merge_commit_sha && (
            <>
              <span className={styles.metaLabel}>Commit</span>
              <code className={styles.metaCode}>{data.merge_commit_sha.slice(0, 12)}</code>
            </>
          )}
          {data.pr_merged_at && (
            <>
              <span className={styles.metaLabel}>Merged</span>
              <time dateTime={data.pr_merged_at}>{formatRelative(data.pr_merged_at)}</time>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SkipReasonSection({ data }: { data: IntentOutcome }) {
  return (
    <div className={styles.skipReasons} data-testid="intent-outcome-skip-reasons">
      <span className={styles.skipReasonsLabel}>Skip reasons</span>
      <ul className={styles.skipReasonList}>
        {data.skip_reasons.map((r, i) => (
          <li
            key={`${r.source}-${i}`}
            className={styles.skipReasonItem}
            data-source={r.source}
          >
            <AlertOctagon size={11} strokeWidth={2} aria-hidden="true" />
            <span className={styles.skipReasonSource}>{r.source}</span>
            <span className={styles.skipReasonText}>{r.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MetaSection({ data }: { data: IntentOutcome }) {
  return (
    <div className={styles.meta} data-testid="intent-outcome-meta">
      {data.total_duration_ms > 0 && (
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Pipeline ran</span>
          <code className={styles.metaCode}>{formatDurationMs(data.total_duration_ms)}</code>
        </div>
      )}
      {data.stage_count > 0 && (
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Stages</span>
          <code className={styles.metaCode}>
            {data.stage_completed_count} / {data.stage_count}
          </code>
        </div>
      )}
      {data.time_elapsed_ms > 0 && data.operator_intent_atom_id && (
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Intent age</span>
          <code className={styles.metaCode}>{formatDurationMs(data.time_elapsed_ms)}</code>
        </div>
      )}
      {data.mode && (
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Mode</span>
          <code className={styles.metaCode}>{data.mode}</code>
        </div>
      )}
      {data.operator_intent_atom_id && (
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Intent</span>
          <AtomRef id={data.operator_intent_atom_id} variant="chip" />
        </div>
      )}
    </div>
  );
}

function StateIcon({ state }: { state: IntentOutcomeState }) {
  switch (state) {
    case 'intent-fulfilled':
      return <GitMerge size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'intent-dispatched-pending-review':
      return <CheckCircle2 size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'intent-dispatch-failed':
      return <XCircle size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'intent-paused':
      return <PauseCircle size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'intent-running':
      return <Loader2 size={12} strokeWidth={2.25} aria-hidden="true" className={styles.spin} />;
    case 'intent-abandoned':
      return <MinusCircle size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'intent-unknown':
    default:
      return <MinusCircle size={12} strokeWidth={2.25} aria-hidden="true" />;
  }
}

/**
 * Map state -> tone token for the data attribute. Keep the resolver
 * inside the feature module: pipeline_state has its own tone resolver
 * in tones.ts, but the intent-outcome state has different semantic
 * coloring (a fulfilled intent is success-green; a still-running
 * pipeline is info-blue with motion). Sharing one resolver would
 * force a misleading mapping for one of the surfaces.
 */
export function stateTone(state: IntentOutcomeState): string {
  switch (state) {
    case 'intent-fulfilled':
      return 'success';
    case 'intent-dispatched-pending-review':
      return 'info';
    case 'intent-dispatch-failed':
      return 'danger';
    case 'intent-paused':
      return 'warning';
    case 'intent-running':
      return 'info';
    case 'intent-abandoned':
      return 'muted';
    case 'intent-unknown':
    default:
      return 'muted';
  }
}

/**
 * Convert the wire-shape state token to a human-friendly label. The
 * server emits `intent-fulfilled` (machine-friendly); the card body
 * shows "Fulfilled" so the operator does not have to mentally parse
 * the kebab-case prefix. Pure function for ease of unit testing.
 */
export function prettyState(state: IntentOutcomeState): string {
  switch (state) {
    case 'intent-fulfilled':
      return 'Fulfilled';
    case 'intent-dispatched-pending-review':
      return 'Dispatched - pending review';
    case 'intent-dispatch-failed':
      return 'Dispatch failed';
    case 'intent-paused':
      return 'Paused';
    case 'intent-running':
      return 'Running';
    case 'intent-abandoned':
      return 'Abandoned';
    case 'intent-unknown':
    default:
      return 'Unknown';
  }
}
