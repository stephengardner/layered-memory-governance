import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, ExternalLink, FileCheck, GitBranch, GitMerge, GitPullRequest, MinusCircle, Send, ShieldAlert, XCircle } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import {
  getPipelineLifecycle,
  type PipelineLifecycle as PipelineLifecycleData,
  type PipelineLifecycleObservation,
} from '@/services/pipelines.service';
import { formatRelative } from './PipelinesView';
import styles from './PipelineLifecycle.module.css';

/**
 * Post-dispatch lifecycle section for the pipeline detail view.
 *
 * Renders the chain of atoms downstream of dispatch-stage as a
 * single coherent surface so the operator sees the full
 * intent-to-merge picture without bouncing across atom-detail views:
 *
 *   1. Dispatch outcome (scanned / dispatched / failed)
 *   2. Code-author invocation (silent-skip vs PR opened)
 *   3. PR row (number, title, branch, GitHub link)
 *   4. Review state (CR verdict derived from the latest pr-observation)
 *   5. CI status (per-state check counts)
 *   6. Merge state (mergeStateStatus + merge SHA + merger when MERGED)
 *
 * The component is a self-contained unit: it owns its own TanStack
 * Query hook, has its own polling cadence, and renders independently
 * of the parent stage timeline. PipelineDetailView stacks it below
 * the stage list; future surfaces (a per-plan inspector) can drop the
 * same component in unchanged.
 *
 * Polling: 10s while the pipeline has an open PR with non-CLEAN merge
 * state OR no merge atom yet, because operators expect near-live
 * feedback as CI / CR transitions land. Stops once the
 * plan-merge-settled row is present (terminal). Mirrors the cadence
 * pattern PipelineDetailView uses (5s for stages) but at half the
 * rate because the post-dispatch surface watches GitHub state, which
 * only changes on CI events that fire every minute or two.
 */
export function PipelineLifecycle({ pipelineId }: { pipelineId: string }) {
  const query = useQuery({
    queryKey: ['pipeline', pipelineId, 'lifecycle'],
    queryFn: ({ signal }) => getPipelineLifecycle(pipelineId, signal),
    refetchInterval: (queryState) => {
      // Polling rules:
      //   - On a recoverable 404 (pipeline-not-found from a yet-to-dispatch
      //     pipeline), keep polling. The endpoint will start returning
      //     a populated envelope once a dispatch-record lands.
      //   - On any other error, back off so a transport problem doesn't
      //     hammer the backend.
      //   - On data: stop polling once a merge row of any shape exists
      //     (settled atom OR synthesized from a pr-observation reporting
      //     pr_state=MERGED). Both shapes are terminal for this surface.
      //   - Otherwise poll every 10s while the pipeline is still in flight.
      const err = queryState.state.error;
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('pipeline-not-found')) return 10_000;
        return false;
      }
      const data = queryState.state.data;
      if (!data) return 10_000;
      if (data.merge) return false;
      return 10_000;
    },
    refetchOnWindowFocus: true,
    /*
     * Treat 404 (pipeline-not-found) as a non-error; the section
     * renders an empty placeholder rather than a noisy error block.
     * Same posture the pipeline detail view takes.
     */
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('pipeline-not-found')) return false;
      return failureCount < 2;
    },
  });

  if (query.isPending) {
    return (
      <section className={styles.section} data-testid="pipeline-lifecycle">
        <SectionHead />
        <p className={styles.loading} data-testid="pipeline-lifecycle-loading">
          Loading post-dispatch chain…
        </p>
      </section>
    );
  }

  if (query.isError) {
    const err = query.error instanceof Error ? query.error : null;
    const msg = err?.message ?? String(query.error);
    if (msg.includes('pipeline-not-found')) {
      // No dispatch chain yet for this pipeline. Render the section so
      // the operator knows the surface exists and what it would show
      // once the pipeline crosses dispatch-stage.
      return (
        <section className={styles.section} data-testid="pipeline-lifecycle">
          <SectionHead />
          <p className={styles.empty} data-testid="pipeline-lifecycle-empty">
            No post-dispatch atoms recorded for this pipeline yet.
          </p>
        </section>
      );
    }
    return (
      <section className={styles.section} data-testid="pipeline-lifecycle">
        <SectionHead />
        <p className={styles.error} data-testid="pipeline-lifecycle-error">
          Could not load lifecycle: {msg}
        </p>
      </section>
    );
  }

  return <LifecycleBody data={query.data} />;
}

function SectionHead() {
  return (
    <header className={styles.sectionHead}>
      <span className={styles.sectionIcon} aria-hidden="true">
        <Send size={14} strokeWidth={2} />
      </span>
      <h3 className={styles.sectionTitle}>Post-dispatch lifecycle</h3>
    </header>
  );
}

function LifecycleBody({ data }: { data: PipelineLifecycleData }) {
  return (
    <section className={styles.section} data-testid="pipeline-lifecycle">
      <SectionHead />
      <ol className={styles.rows}>
        <DispatchRow data={data} />
        <CodeAuthorRow data={data} />
        <PrRow data={data} />
        <ReviewRow data={data} />
        <CiRow data={data} />
        <MergeRow data={data} />
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------- */
/* Row primitive                                                       */
/* ------------------------------------------------------------------- */

function Row({
  testId,
  icon,
  label,
  value,
  detail,
  tone,
  children,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: 'success' | 'danger' | 'warning' | 'info' | 'muted';
  children?: React.ReactNode;
}) {
  // Honor prefers-reduced-motion per dev-web-interaction-quality-no-jank.
  // useReducedMotion subscribes to the browser preference; when true we
  // mount the row at its final state and skip the entry animation.
  // The visual jump is invisible because the rows render once on mount;
  // operators with motion sensitivity get the static layout immediately.
  const reduceMotion = useReducedMotion();
  const motionProps = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0 } }
    : {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.18 },
    };
  return (
    <motion.li
      className={styles.row}
      data-testid={testId}
      data-tone={tone ?? 'neutral'}
      {...motionProps}
    >
      <span className={styles.rowIcon} aria-hidden="true" data-tone={tone ?? 'neutral'}>
        {icon}
      </span>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabel}>{label}</span>
          <span className={styles.rowValue}>{value}</span>
        </div>
        {detail && <div className={styles.rowDetail}>{detail}</div>}
        {children}
      </div>
    </motion.li>
  );
}

/* ------------------------------------------------------------------- */
/* Dispatch outcome row                                                */
/* ------------------------------------------------------------------- */

function DispatchRow({ data }: { data: PipelineLifecycleData }) {
  const dispatch = data.dispatch_record;
  if (!dispatch) {
    return (
      <Row
        testId="pipeline-lifecycle-dispatch"
        icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="Dispatch outcome"
        value={<span className={styles.muted}>not yet emitted</span>}
        tone="muted"
      />
    );
  }
  const tone: 'success' | 'danger' | 'info' | 'warning' = dispatch.failed > 0
    ? 'danger'
    : dispatch.dispatched > 0
      ? 'success'
      : 'info';
  const summary = `${dispatch.scanned} scanned / ${dispatch.dispatched} dispatched / ${dispatch.failed} failed`;
  return (
    <Row
      testId="pipeline-lifecycle-dispatch"
      icon={<Send size={14} strokeWidth={2} aria-hidden="true" />}
      label="Dispatch outcome"
      value={summary}
      tone={tone}
      detail={
        <>
          <div className={styles.metaLine}>
            <span className={styles.metaLabel}>Status</span>
            <code className={styles.metaCode}>{dispatch.dispatch_status ?? 'unknown'}</code>
            <span className={styles.metaLabel}>At</span>
            <time dateTime={dispatch.at}>{formatRelative(dispatch.at)}</time>
          </div>
          <div className={styles.atomRefRow}>
            <span className={styles.metaLabel}>Atom</span>
            <AtomRef id={dispatch.atom_id} variant="chip" />
          </div>
          {dispatch.failed > 0 && dispatch.error_message && (
            <div className={styles.errorBlock} data-testid="pipeline-lifecycle-dispatch-error">
              <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
              <p>{dispatch.error_message}</p>
            </div>
          )}
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------- */
/* Code-author invocation row                                          */
/* ------------------------------------------------------------------- */

function CodeAuthorRow({ data }: { data: PipelineLifecycleData }) {
  const invoked = data.code_author_invoked;
  if (!invoked) {
    return (
      <Row
        testId="pipeline-lifecycle-code-author"
        icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="Code-author invocation"
        value={<span className={styles.muted}>no invocation atom yet</span>}
        tone="muted"
      />
    );
  }
  if (invoked.kind === 'error') {
    return (
      <Row
        testId="pipeline-lifecycle-code-author"
        icon={<XCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="Code-author invocation"
        value="silent-skip"
        tone="danger"
        detail={
          <>
            {invoked.stage && (
              <div className={styles.metaLine}>
                <span className={styles.metaLabel}>Stage</span>
                <code className={styles.metaCode}>{invoked.stage}</code>
              </div>
            )}
            {invoked.reason && (
              <div className={styles.errorBlock} data-testid="pipeline-lifecycle-code-author-reason">
                <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
                <p>{invoked.reason}</p>
              </div>
            )}
            <div className={styles.atomRefRow}>
              <span className={styles.metaLabel}>Atom</span>
              <AtomRef id={invoked.atom_id} variant="chip" />
            </div>
          </>
        }
      />
    );
  }
  if (invoked.kind === 'dispatched') {
    return (
      <Row
        testId="pipeline-lifecycle-code-author"
        icon={<CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />}
        label="Code-author invocation"
        value={invoked.pr_number ? `PR #${invoked.pr_number} opened` : 'dispatched'}
        tone="success"
        detail={
          <>
            {invoked.commit_sha && (
              <div className={styles.metaLine}>
                <span className={styles.metaLabel}>Commit</span>
                <code className={styles.metaCode}>{invoked.commit_sha.slice(0, 12)}</code>
                <span className={styles.metaLabel}>At</span>
                <time dateTime={invoked.at}>{formatRelative(invoked.at)}</time>
              </div>
            )}
            <div className={styles.atomRefRow}>
              <span className={styles.metaLabel}>Atom</span>
              <AtomRef id={invoked.atom_id} variant="chip" />
            </div>
          </>
        }
      />
    );
  }
  // Unknown kind fallback: a malformed atom (kind === null OR an
  // executor that wrote a kind we don't recognize). Render neutral
  // rather than misleading success. The substrate's own validators
  // should ensure this rarely fires; when it does, the operator gets
  // the atom ref and can drill in to debug.
  return (
    <Row
      testId="pipeline-lifecycle-code-author"
      icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
      label="Code-author invocation"
      value={<span className={styles.muted}>unknown executor result</span>}
      tone="muted"
      detail={
        <div className={styles.atomRefRow}>
          <span className={styles.metaLabel}>Atom</span>
          <AtomRef id={invoked.atom_id} variant="chip" />
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------------- */
/* PR row                                                              */
/* ------------------------------------------------------------------- */

function PrRow({ data }: { data: PipelineLifecycleData }) {
  // Resolve the PR ref from any source that has it. The code-author
  // invocation atom is the earliest-arriving carrier; pr-observation
  // atoms also carry it but show up later. Pick the first non-null.
  const invoked = data.code_author_invoked;
  const obs = data.observation;
  const prNumber = invoked?.pr_number ?? obs?.pr_number ?? null;
  const prUrl = invoked?.pr_html_url ?? null;
  const branch = invoked?.branch_name ?? null;
  const title = obs?.pr_title ?? null;

  if (!prNumber) {
    return (
      <Row
        testId="pipeline-lifecycle-pr"
        icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="Pull request"
        value={<span className={styles.muted}>PR pending</span>}
        tone="muted"
      />
    );
  }

  return (
    <Row
      testId="pipeline-lifecycle-pr"
      icon={<GitPullRequest size={14} strokeWidth={2} aria-hidden="true" />}
      label="Pull request"
      value={
        prUrl
          ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.prLink}
              data-testid="pipeline-lifecycle-pr-link"
            >
              #{prNumber}
              <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
            </a>
          )
          : `#${prNumber}`
      }
      tone="info"
      detail={
        <>
          {title && (
            <p className={styles.prTitle} data-testid="pipeline-lifecycle-pr-title">
              {title}
            </p>
          )}
          {branch && (
            <div className={styles.metaLine}>
              <span className={styles.metaLabel}>
                <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
                Branch
              </span>
              <code className={styles.metaCode}>{branch}</code>
            </div>
          )}
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------- */
/* Review state row                                                    */
/* ------------------------------------------------------------------- */

/**
 * Derive the CR review verdict from a pr-observation snapshot.
 *
 * The substrate's pr-observation atom does NOT currently store CR's
 * specific review decision in metadata; that field is a derived
 * signal. Per canon `dev-multi-surface-review-observation`, ALL
 * surfaces must be queried before deriving a single verdict:
 * submitted reviews, line comments, body nits, legacy statuses
 * (where the `CodeRabbit` legacy status posts), and the merge state.
 * A single-surface read collapses to a misleading verdict.
 *
 * Verdict ladder (ordered by precedence):
 *
 *   - has-findings  : a red legacy status (CodeRabbit failed) OR
 *                     mergeStateStatus is BLOCKED / DIRTY OR
 *                     >= 1 submitted review with line/body comments.
 *                     The multi-surface read says "something is
 *                     blocking the merge gate".
 *   - approved      : >= 1 submitted review AND zero CR comments AND
 *                     no red legacy statuses AND mergeStateStatus
 *                     is CLEAN or UNSTABLE. UNSTABLE alone is not a
 *                     verdict-blocker; a non-required check pending
 *                     does not invalidate the review.
 *   - pending       : everything else (no engagement on any of the
 *                     surfaces above).
 *
 * Imprecision intentionally accepted: the actor that submits a
 * review is not always CodeRabbit (an operator could review the PR
 * personally and the count goes up). Treating any review as "the
 * verdict" is the right indie-floor default; the org-ceiling
 * deployment that needs perfect attribution can (a) read the
 * per-review actor list from the `submittedReviews` array on a
 * future atom shape, or (b) post-process by filtering on the CR
 * principal id. Both are extension paths, not regressions.
 *
 * `missing` covers the case where the surface explicitly partial-read
 * with the review surface failed (the atom's `partial_surfaces`
 * carries the failed-surface name). v0 doesn't propagate that into
 * this projection so we don't return 'missing' here.
 */
function deriveReviewVerdict(obs: PipelineLifecycleObservation): {
  label: string;
  tone: 'success' | 'warning' | 'info' | 'muted';
} {
  // Hard-blocking surfaces first. A red legacy status (CodeRabbit
  // failure is the canonical signal here) or a BLOCKED/DIRTY merge
  // state surfaces "has findings" regardless of submitted-review
  // counts. This is the multi-surface check the canon directive
  // specifically requires before collapsing to a single verdict.
  if (obs.legacy_statuses_red > 0) {
    return { label: 'has findings', tone: 'warning' };
  }
  if (obs.merge_state_status === 'BLOCKED' || obs.merge_state_status === 'DIRTY') {
    return { label: 'has findings', tone: 'warning' };
  }
  if (obs.submitted_reviews === 0) {
    return { label: 'pending', tone: 'info' };
  }
  if (obs.line_comments + obs.body_nits > 0) {
    return { label: 'has findings', tone: 'warning' };
  }
  return { label: 'approved', tone: 'success' };
}

function ReviewRow({ data }: { data: PipelineLifecycleData }) {
  const obs = data.observation;
  if (!obs) {
    return (
      <Row
        testId="pipeline-lifecycle-review"
        icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="Review state"
        value={<span className={styles.muted}>no observation yet</span>}
        tone="muted"
      />
    );
  }
  const verdict = deriveReviewVerdict(obs);
  return (
    <Row
      testId="pipeline-lifecycle-review"
      icon={<FileCheck size={14} strokeWidth={2} aria-hidden="true" />}
      label="Review state"
      value={verdict.label}
      tone={verdict.tone}
      detail={
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Reviews</span>
          <code className={styles.metaCode}>{obs.submitted_reviews}</code>
          <span className={styles.metaLabel}>Line comments</span>
          <code className={styles.metaCode}>{obs.line_comments}</code>
          <span className={styles.metaLabel}>Body nits</span>
          <code className={styles.metaCode}>{obs.body_nits}</code>
          <span className={styles.metaLabel}>Legacy statuses</span>
          <code className={styles.metaCode}>
            {obs.legacy_statuses_red > 0
              ? `${obs.legacy_statuses_red}/${obs.legacy_statuses} red`
              : `${obs.legacy_statuses} ok`}
          </code>
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------------- */
/* CI status row                                                       */
/* ------------------------------------------------------------------- */

function CiRow({ data }: { data: PipelineLifecycleData }) {
  const obs = data.observation;
  if (!obs) {
    return (
      <Row
        testId="pipeline-lifecycle-ci"
        icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="CI status"
        value={<span className={styles.muted}>no observation yet</span>}
        tone="muted"
      />
    );
  }
  const counts = obs.check_counts;
  const tone: 'success' | 'danger' | 'warning' | 'info' = counts.red > 0
    ? 'danger'
    : counts.pending > 0
      ? 'warning'
      : counts.green > 0
        ? 'success'
        : 'info';
  return (
    <Row
      testId="pipeline-lifecycle-ci"
      icon={<ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />}
      label="CI status"
      value={`${counts.green} green / ${counts.red} red / ${counts.pending} pending`}
      tone={tone}
      detail={
        <div className={styles.metaLine}>
          <span className={styles.metaLabel}>Total checks</span>
          <code className={styles.metaCode}>{counts.total}</code>
          <span className={styles.metaLabel}>Observed</span>
          <time dateTime={obs.observed_at}>{formatRelative(obs.observed_at)}</time>
          <span className={styles.metaLabel}>Atom</span>
          <AtomRef id={obs.atom_id} variant="chip" />
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------------- */
/* Merge row                                                           */
/* ------------------------------------------------------------------- */

function MergeRow({ data }: { data: PipelineLifecycleData }) {
  const merge = data.merge;
  const obs = data.observation;
  if (!merge && !obs) {
    return (
      <Row
        testId="pipeline-lifecycle-merge"
        icon={<MinusCircle size={14} strokeWidth={2} aria-hidden="true" />}
        label="Merge state"
        value={<span className={styles.muted}>no observation yet</span>}
        tone="muted"
      />
    );
  }
  if (!merge && obs) {
    // Pre-merge: surface mergeStateStatus + mergeable from the latest
    // pr-observation so the operator knows where the PR is in the
    // gate ladder.
    const mss = obs.merge_state_status;
    const tone: 'success' | 'warning' | 'danger' | 'info' = mss === 'CLEAN'
      ? 'success'
      : mss === 'BEHIND' || mss === 'BLOCKED' || mss === 'UNSTABLE'
        ? 'warning'
        : mss === 'DIRTY'
          ? 'danger'
          : 'info';
    return (
      <Row
        testId="pipeline-lifecycle-merge"
        icon={<GitMerge size={14} strokeWidth={2} aria-hidden="true" />}
        label="Merge state"
        value={mss ?? 'unknown'}
        tone={tone}
        detail={
          <div className={styles.metaLine}>
            <span className={styles.metaLabel}>PR state</span>
            <code className={styles.metaCode}>{obs.pr_state ?? 'unknown'}</code>
            <span className={styles.metaLabel}>Mergeable</span>
            <code className={styles.metaCode}>{obs.mergeable === null ? 'unknown' : String(obs.mergeable)}</code>
          </div>
        }
      />
    );
  }
  if (!merge) {
    // Defensive path -- guarded above. Keeps the type narrowing happy.
    return null;
  }
  return (
    <Row
      testId="pipeline-lifecycle-merge"
      icon={<GitMerge size={14} strokeWidth={2} aria-hidden="true" />}
      label="Merge state"
      value="MERGED"
      tone="success"
      detail={
        <>
          <div className={styles.metaLine}>
            <span className={styles.metaLabel}>Plan</span>
            <code className={styles.metaCode}>{merge.target_plan_state ?? 'settled'}</code>
            <span className={styles.metaLabel}>At</span>
            <time dateTime={merge.settled_at}>{formatRelative(merge.settled_at)}</time>
          </div>
          {merge.merge_commit_sha && (
            <div className={styles.metaLine}>
              <span className={styles.metaLabel}>Commit</span>
              <code className={styles.metaCode}>{merge.merge_commit_sha.slice(0, 12)}</code>
              {merge.merger_principal_id && (
                <>
                  <span className={styles.metaLabel}>Merger</span>
                  <code className={styles.metaCode}>{merge.merger_principal_id}</code>
                </>
              )}
            </div>
          )}
          {merge.atom_id && (
            <div className={styles.atomRefRow}>
              <span className={styles.metaLabel}>Atom</span>
              <AtomRef id={merge.atom_id} variant="chip" />
            </div>
          )}
        </>
      }
    />
  );
}
