import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Lightbulb,
  CheckCircle2,
  Send,
  Eye,
  GitMerge,
  Sparkles,
  AlertCircle,
} from 'lucide-react';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '@/components/state-display/StateDisplay';
import { listPlans, type PlanAtom } from '@/services/plans.service';
import { planStateTone } from '@/features/plan-state/tones';
import {
  getPlanLifecycle,
  type PlanLifecycle,
  type PlanLifecycleFailure,
  type PlanLifecyclePhase,
  type PlanLifecycleTransition,
} from '@/services/plan-lifecycle.service';
import {
  routeForAtomId,
  routeHref,
  setRoute,
  useRouteId,
} from '@/state/router.store';
import styles from './PlanLifecycleView.module.css';

/**
 * Plan Lifecycle: end-to-end timeline of a single plan's autonomous-loop
 * chain. Each phase (deliberation → approval → dispatch → observation
 * → merge → settled) shows up as a node on a vertical timeline with
 * the signing principal, the atom id (clickable), and the timestamp.
 *
 * The view has two modes:
 *
 *   1. Without a route id (`/plan-lifecycle`) → renders a list of all
 *      plans, sorted by recency, each showing its final state. The
 *      operator picks one and clicks through.
 *
 *   2. With a route id (`/plan-lifecycle/<plan-id>`) → renders the
 *      full timeline for that plan. Empty transitions (e.g. a plan
 *      that was never dispatched) simply don't render — the
 *      governance story is "what actually happened", not "what
 *      could have happened".
 *
 * Why a separate view instead of folding into PlansView:
 *
 *   - PlansView is the read-the-plan-body view. The lifecycle is a
 *     different question ("what happened to this plan?") that demands
 *     a chronological narrative renderer, not a markdown-card grid.
 *   - The atom-stitching is server-side; the client is dumb. That
 *     keeps PlansView from caring about derived state.
 *   - At org-ceiling scale (50+ actors writing thousands of plans),
 *     a dedicated view earns its keep — operators investigating an
 *     incident want THE ONE view that shows the whole chain.
 */
const PHASE_ICON: Record<PlanLifecyclePhase, typeof Lightbulb> = {
  deliberation: Lightbulb,
  approval: CheckCircle2,
  dispatch: Send,
  observation: Eye,
  merge: GitMerge,
  settled: Sparkles,
  failure: AlertCircle,
};

const PHASE_TONE: Record<PlanLifecyclePhase, string> = {
  deliberation: 'var(--accent)',
  approval: 'var(--status-success)',
  dispatch: 'var(--accent)',
  observation: 'var(--text-tertiary)',
  merge: 'var(--status-success)',
  settled: 'var(--status-success)',
  failure: 'var(--status-danger)',
};

// Plan-state tones live in `@/features/plan-state/tones.ts`: single
// source of truth across PlansView, this view, and the e2e specs.

export function PlanLifecycleView() {
  const focusId = useRouteId();
  if (focusId) {
    return <PlanLifecycleDetail planId={focusId} />;
  }
  return <PlanLifecycleList />;
}

function PlanLifecycleList() {
  const query = useQuery({
    queryKey: ['plans'],
    queryFn: ({ signal }) => listPlans(signal),
  });

  const plans = useMemo(() => {
    const all = query.data ?? [];
    // Most recent first. plans.list already sorts but we redo it to
    // be defensive against transport variations.
    return [...all].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [query.data]);

  return (
    <section className={styles.view}>
      {query.isPending && <LoadingState label="Loading plans..." testId="plan-lifecycle-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load plans"
          message={(query.error as Error).message}
          testId="plan-lifecycle-error"
        />
      )}
      {query.isSuccess && plans.length === 0 && (
        <EmptyState
          title="No plans yet"
          detail="Plans show up here once a CTO actor proposes one and it lands as an atom."
          testId="plan-lifecycle-empty"
        />
      )}
      {query.isSuccess && plans.length > 0 && (
        <>
          <header className={styles.intro}>
            <h2 className={styles.heroTitle}>Plan Lifecycle</h2>
            <p className={styles.heroSubtitle}>
              End-to-end view of every plan's autonomous-loop chain — from operator intent
              through deliberation, approval, dispatch, PR observation, and merge.
            </p>
          </header>
          <StatsHeader
            total={plans.length}
            label={`plan${plans.length === 1 ? '' : 's'}`}
            detail="select one to view its full chain"
          />
          <ol className={styles.planList}>
            {plans.map((plan, idx) => (
              <PlanRow key={plan.id} plan={plan} index={idx} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function PlanRow({ plan, index }: { plan: PlanAtom; index: number }) {
  const state = plan.plan_state ?? 'unknown';
  const title = extractTitle(plan.content);
  return (
    <motion.li
      className={styles.planRow}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
    >
      <a
        className={styles.planRowLink}
        href={routeHref('plan-lifecycle', plan.id)}
        data-testid="plan-lifecycle-row"
        data-plan-id={plan.id}
        data-plan-state={state}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('plan-lifecycle', plan.id);
        }}
      >
        <span
          className={styles.statePill}
          data-testid="plan-lifecycle-row-state"
          data-plan-state={state}
          style={{
            borderColor: planStateTone(state),
            color: planStateTone(state),
          }}
        >
          {state}
        </span>
        <span className={styles.planRowTitle}>{title || plan.id}</span>
        <code className={styles.planRowId}>{plan.id}</code>
        <time className={styles.planRowTime} dateTime={plan.created_at}>
          {new Date(plan.created_at).toLocaleString()}
        </time>
      </a>
    </motion.li>
  );
}

function PlanLifecycleDetail({ planId }: { planId: string }) {
  const query = useQuery({
    queryKey: ['plan-lifecycle', planId],
    queryFn: ({ signal }) => getPlanLifecycle(planId, signal),
  });

  if (query.isPending) {
    return <LoadingState label="Loading plan lifecycle..." testId="plan-lifecycle-detail-loading" />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load lifecycle"
        message={(query.error as Error).message}
        testId="plan-lifecycle-detail-error"
      />
    );
  }
  const data: PlanLifecycle = query.data;
  if (!data.plan) {
    return (
      <EmptyState
        title="Plan not found"
        detail={
          <>
            <code>{planId}</code> is not in the atom store.
          </>
        }
        action={
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => setRoute('plan-lifecycle')}
          >
            Back to plan list
          </button>
        }
        testId="plan-lifecycle-detail-empty"
      />
    );
  }
  return <PlanLifecycleTimeline data={data} />;
}

function PlanLifecycleTimeline({ data }: { data: PlanLifecycle }) {
  const { plan, dispatch, observation, settled, failure, transitions } = data;
  if (!plan) return null;
  const title = extractTitle(plan.content);
  const state = plan.plan_state ?? 'unknown';

  return (
    <section className={styles.view}>
      <FocusBanner
        label="Plan lifecycle"
        id={plan.id}
        onClear={() => setRoute('plan-lifecycle')}
      />

      <header className={styles.detailHead}>
        <span
          className={styles.statePill}
          style={{
            borderColor: planStateTone(state),
            color: planStateTone(state),
          }}
          data-testid="plan-lifecycle-state"
          data-plan-state={state}
        >
          {state}
        </span>
        <h2 className={styles.detailTitle}>{title || plan.id}</h2>
        <div className={styles.detailMeta}>
          <span>by {plan.principal_id}</span>
          <span aria-hidden="true">·</span>
          <span>layer {plan.layer}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={plan.created_at}>{new Date(plan.created_at).toLocaleString()}</time>
        </div>
      </header>

      {dispatch?.pr_html_url && (
        <aside className={styles.summaryGrid}>
          <SummaryCell
            label="PR"
            value={
              <a
                className={styles.summaryLink}
                href={dispatch.pr_html_url}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="plan-lifecycle-pr-link"
              >
                #{dispatch.pr_number}
              </a>
            }
          />
          {dispatch.commit_sha && (
            <SummaryCell
              label="Commit"
              value={<code className={styles.summaryMono}>{dispatch.commit_sha.slice(0, 7)}</code>}
            />
          )}
          {dispatch.model && <SummaryCell label="Model" value={dispatch.model} />}
          {typeof dispatch.total_cost_usd === 'number' && (
            <SummaryCell
              label="Cost"
              value={`$${dispatch.total_cost_usd.toFixed(4)}`}
            />
          )}
          {observation?.pr_state && (
            <SummaryCell
              label="PR state"
              value={observation.pr_state}
            />
          )}
          {settled?.target_plan_state && (
            <SummaryCell
              label="Settled"
              value={settled.target_plan_state}
            />
          )}
        </aside>
      )}

      {failure && <FailureCard failure={failure} />}

      {transitions.length === 0 ? (
        <EmptyState
          title="No transitions yet"
          detail="The plan exists but no downstream events (intent, approval, dispatch, observation) reference it."
          testId="plan-lifecycle-transitions-empty"
        />
      ) : (
        <ol
          className={styles.timeline}
          data-testid="plan-lifecycle-timeline"
          aria-label="Plan lifecycle transitions"
        >
          {transitions.map((t, i) => (
            <TransitionNode
              key={`${t.atom_id}-${t.phase}-${i}`}
              transition={t}
              index={i}
              isLast={i === transitions.length - 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.summaryCell}>
      <span className={styles.summaryLabel}>{label}</span>
      <span className={styles.summaryValue}>{value}</span>
    </div>
  );
}

/*
 * Failure card: red-bordered surface that surfaces the dispatcher's
 * halt reason without requiring the operator to grep the atom file.
 * Three rows: stage pill, full message in a <pre> for whitespace
 * preservation, and an optional fix hint callout. When `fix_hint` is
 * null we still show the slot ("no automated hint") so the e2e test
 * can assert presence regardless of the heuristic outcome — and so
 * the operator knows the absence is deliberate.
 */
function FailureCard({ failure }: { failure: PlanLifecycleFailure }) {
  const validIso = !Number.isNaN(Date.parse(failure.at));
  return (
    <motion.aside
      className={styles.failureCard}
      data-testid="plan-lifecycle-failure"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
      aria-label="Plan failure detail"
    >
      <header className={styles.failureHeader}>
        <span className={styles.failureIcon} aria-hidden="true">
          <AlertCircle size={16} strokeWidth={2} />
        </span>
        <span className={styles.failureTitle}>Plan failed</span>
        <span
          className={styles.failureStage}
          data-testid="plan-lifecycle-failure-stage"
        >
          stage={failure.stage}
        </span>
        {validIso && (
          <time className={styles.failureTime} dateTime={failure.at}>
            {new Date(failure.at).toLocaleString()}
          </time>
        )}
      </header>
      <pre
        className={styles.failureMessage}
        data-testid="plan-lifecycle-failure-message"
      >
        {failure.message}
      </pre>
      <div
        className={styles.failureHint}
        data-testid="plan-lifecycle-failure-hint"
      >
        {failure.fix_hint ?? 'No automated hint for this stage.'}
      </div>
    </motion.aside>
  );
}

function TransitionNode({
  transition,
  index,
  isLast,
}: {
  transition: PlanLifecycleTransition;
  index: number;
  isLast: boolean;
}) {
  const Icon = PHASE_ICON[transition.phase];
  const tone = PHASE_TONE[transition.phase];
  const targetRoute = routeForAtomId(transition.atom_id);
  const validIso = !Number.isNaN(Date.parse(transition.at));

  return (
    <motion.li
      className={styles.node}
      data-testid="plan-lifecycle-transition"
      data-phase={transition.phase}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{
        duration: 0.24,
        delay: Math.min(index * 0.06, 0.36),
        ease: [0.2, 0, 0, 1],
      }}
    >
      <span
        className={styles.nodeIcon}
        style={{ color: tone, borderColor: tone }}
        aria-hidden="true"
      >
        <Icon size={14} strokeWidth={2} />
      </span>
      {!isLast && <span className={styles.nodeRail} aria-hidden="true" />}
      <div className={styles.nodeBody}>
        <div className={styles.nodeHeader}>
          <span className={styles.nodeLabel}>{transition.label}</span>
          {validIso && (
            <time className={styles.nodeTime} dateTime={transition.at}>
              {new Date(transition.at).toLocaleString()}
            </time>
          )}
        </div>
        <div className={styles.nodeMeta}>
          <span className={styles.principalPill}>{transition.by}</span>
          <a
            className={styles.atomLink}
            href={routeHref(targetRoute, transition.atom_id)}
            data-testid="plan-lifecycle-transition-atom"
            data-atom-id={transition.atom_id}
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0) return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setRoute(targetRoute, transition.atom_id);
            }}
          >
            {transition.atom_id}
          </a>
        </div>
      </div>
    </motion.li>
  );
}

/*
 * Plans usually start with a `# Title` heading on the first non-empty
 * line. Pull it for the row label so the operator sees a human title
 * instead of the slugged atom id.
 */
function extractTitle(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m && m[1]) return m[1].trim();
    if (line.trim().length > 0) return null;
  }
  return null;
}
