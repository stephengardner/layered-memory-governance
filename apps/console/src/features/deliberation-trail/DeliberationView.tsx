import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Brain, Library, Compass, GitBranch, ShieldQuestion } from 'lucide-react';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '@/components/state-display/StateDisplay';
import {
  listDeliberations,
  getDeliberation,
  type DeliberationSummary,
  type DeliberationDetail,
} from '@/services/deliberation.service';
import { toErrorMessage } from '@/services/errors';
import { planStateTone } from '@/features/plan-state/tones';
import { StageContextPanel } from '@/features/stage-context/StageContextPanel';
import {
  routeForAtomId,
  routeHref,
  setRoute,
  useRouteId,
} from '@/state/router.store';
import styles from './DeliberationView.module.css';

/**
 * Deliberation Trail: surface the heuristic-thinking process behind
 * every plan atom. The plan atom already carries the reasoning --
 * alternatives_rejected, principles_applied, derived_from citations,
 * what_breaks_if_revisit -- but those fields are buried in the raw
 * atom JSON. This view answers WHY a plan picked the path it did,
 * without leaving the console.
 *
 * Two modes:
 *
 *   1. /deliberation               -> list of recent plans, each card
 *                                     summarising its deliberation
 *                                     (alt count, citation count,
 *                                     principles count) for at-a-glance
 *                                     audit.
 *
 *   2. /deliberation/<plan-id>     -> the full reasoning trail for one
 *                                     plan: every alternative rejected
 *                                     with reason, every principle
 *                                     applied, every cited atom (with
 *                                     route-aware link), and the
 *                                     "what breaks if we revisit"
 *                                     statement.
 *
 * Substrate purity: NO new atom types. The view is a projection over
 * what any planner-shaped actor already writes today. The
 * substrate-side gap, if any, is surfaced by the view rather than
 * widened by it.
 */
export function DeliberationView() {
  const focusId = useRouteId();
  if (focusId) return <DeliberationDetailView planId={focusId} />;
  return <DeliberationList />;
}

function DeliberationList() {
  const query = useQuery({
    queryKey: ['deliberations'],
    queryFn: ({ signal }) => listDeliberations(signal),
  });

  const items = useMemo(() => query.data ?? [], [query.data]);

  return (
    <section className={styles.view}>
      {query.isPending && (
        <LoadingState label="Loading deliberation trail..." testId="deliberation-loading" />
      )}
      {query.isError && (
        <ErrorState
          title="Could not load deliberation trail"
          message={toErrorMessage(query.error)}
          testId="deliberation-error"
        />
      )}
      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No deliberation captured yet"
          detail="Plans show up here once a planner writes one with alternatives_rejected, principles_applied, or derived_from citations."
          testId="deliberation-empty"
        />
      )}
      {query.isSuccess && items.length > 0 && (
        <>
          <header className={styles.intro}>
            <h2 className={styles.heroTitle}>Deliberation Trail</h2>
            <p className={styles.heroSubtitle}>
              Why each plan was picked: alternatives weighed, canon cited, principles applied.
              Every plan-authoring decision a planner logged becomes auditable here.
            </p>
          </header>
          <StatsHeader
            total={items.length}
            label={`plan${items.length === 1 ? '' : 's'} with deliberation`}
            detail="select one to read the full reasoning trail"
          />
          <ol className={styles.cardList}>
            {items.map((item, idx) => (
              <DeliberationCard key={item.plan_id} item={item} index={idx} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function DeliberationCard({ item, index }: { item: DeliberationSummary; index: number }) {
  const state = item.plan_state ?? null;
  const tone = planStateTone(state);
  return (
    <motion.li
      className={styles.card}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
    >
      <a
        className={styles.cardLink}
        href={routeHref('deliberation', item.plan_id)}
        data-testid="deliberation-card"
        data-plan-id={item.plan_id}
        data-alternatives-count={item.alternatives_count}
        data-citations-count={item.citations_count}
        data-principles-count={item.principles_count}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('deliberation', item.plan_id);
        }}
      >
        <header className={styles.cardHeader}>
          <span className={styles.principalPill}>{item.principal_id}</span>
          {state && (
            <span
              className={styles.statePill}
              style={{
                borderColor: tone,
                color: tone,
              }}
            >
              {state}
            </span>
          )}
          <time className={styles.cardTime} dateTime={item.created_at}>
            {new Date(item.created_at).toLocaleString()}
          </time>
        </header>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        <code className={styles.cardId}>{item.plan_id}</code>
        <ul className={styles.metricRow} aria-label="deliberation summary">
          <Metric
            icon={<Compass size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={`${item.alternatives_count} alternative${item.alternatives_count === 1 ? '' : 's'}`}
          />
          <Metric
            icon={<Library size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={`${item.citations_count} citation${item.citations_count === 1 ? '' : 's'}`}
          />
          <Metric
            icon={<Brain size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={`${item.principles_count} principle${item.principles_count === 1 ? '' : 's'}`}
          />
        </ul>
      </a>
    </motion.li>
  );
}

function Metric({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <li className={styles.metric}>
      <span className={styles.metricIcon}>{icon}</span>
      <span>{label}</span>
    </li>
  );
}

function DeliberationDetailView({ planId }: { planId: string }) {
  const query = useQuery({
    queryKey: ['deliberation', planId],
    queryFn: ({ signal }) => getDeliberation(planId, signal),
  });

  if (query.isPending) {
    return <LoadingState label="Loading deliberation..." testId="deliberation-detail-loading" />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load deliberation"
        message={toErrorMessage(query.error)}
        testId="deliberation-detail-error"
      />
    );
  }
  const data = query.data;
  if (!data) {
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
            onClick={() => setRoute('deliberation')}
          >
            Back to deliberation list
          </button>
        }
        testId="deliberation-detail-empty"
      />
    );
  }
  return <DeliberationTrail data={data} />;
}

function DeliberationTrail({ data }: { data: DeliberationDetail }) {
  const { plan, alternatives, principles_applied, citations, what_breaks_if_revisit } = data;
  const stateTone = planStateTone(plan.plan_state);

  return (
    <section className={styles.view}>
      <FocusBanner
        label="Deliberation"
        id={plan.id}
        onClear={() => setRoute('deliberation')}
      />

      <header className={styles.detailHead}>
        {plan.plan_state && (
          <span
            className={styles.statePill}
            style={{ borderColor: stateTone, color: stateTone }}
            data-testid="deliberation-detail-state"
          >
            {plan.plan_state}
          </span>
        )}
        <h2 className={styles.detailTitle}>{plan.title}</h2>
        <div className={styles.detailMeta}>
          <span>by {plan.principal_id}</span>
          <span aria-hidden="true">·</span>
          <span>layer {plan.layer}</span>
          <span aria-hidden="true">·</span>
          <span>conf {plan.confidence.toFixed(2)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={plan.created_at}>{new Date(plan.created_at).toLocaleString()}</time>
        </div>
      </header>

      <Section
        icon={<Compass size={14} strokeWidth={2} />}
        title="Alternatives considered"
        count={alternatives.length}
        testId="deliberation-alternatives"
        empty="No alternatives recorded for this plan."
      >
        <ul className={styles.alternativesList}>
          {alternatives.map((alt, i) => (
            <li
              key={i}
              className={styles.alternativeItem}
              data-testid="deliberation-alternative"
            >
              <div className={styles.alternativeOption}>{alt.option}</div>
              {alt.reason && <div className={styles.alternativeReason}>{alt.reason}</div>}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        icon={<Brain size={14} strokeWidth={2} />}
        title="Principles applied"
        count={principles_applied.length}
        testId="deliberation-principles"
        empty="No principles cited for this plan."
      >
        <ul className={styles.chipList}>
          {principles_applied.map((p) => {
            const r = routeForAtomId(p);
            return (
              <li key={p}>
                <a
                  className={styles.canonChip}
                  href={routeHref(r, p)}
                  data-testid="deliberation-principle"
                  data-atom-id={p}
                  onClick={(e) => {
                    if (e.defaultPrevented || e.button !== 0) return;
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    setRoute(r, p);
                  }}
                >
                  {p}
                </a>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        icon={<Library size={14} strokeWidth={2} />}
        title="Citations"
        count={citations.length}
        testId="deliberation-citations"
        empty="No citations recorded in derived_from."
      >
        <ul className={styles.citationList}>
          {citations.map((c) => {
            const r = routeForAtomId(c.atom_id);
            return (
              <li key={c.atom_id} className={styles.citationItem}>
                <GitBranch
                  size={12}
                  strokeWidth={1.75}
                  className={styles.citationIcon}
                  aria-hidden="true"
                />
                <a
                  className={styles.citationLink}
                  href={routeHref(r, c.atom_id)}
                  data-testid="deliberation-citation"
                  data-atom-id={c.atom_id}
                  onClick={(e) => {
                    if (e.defaultPrevented || e.button !== 0) return;
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    setRoute(r, c.atom_id);
                  }}
                >
                  {c.atom_id}
                </a>
              </li>
            );
          })}
        </ul>
      </Section>

      {what_breaks_if_revisit && (
        <Section
          icon={<ShieldQuestion size={14} strokeWidth={2} />}
          title="What breaks if we revisit"
          testId="deliberation-revisit"
        >
          <p className={styles.revisitText}>{what_breaks_if_revisit}</p>
        </Section>
      )}

      <StageContextPanel atomId={plan.id} />
    </section>
  );
}

interface SectionProps {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly testId?: string;
  readonly empty?: string;
  readonly children: React.ReactNode;
}

function Section({ icon, title, count, testId, empty, children }: SectionProps) {
  // Show the empty fallback only when count is explicitly zero.
  if (typeof count === 'number' && count === 0) {
    return (
      <section className={styles.section} data-testid={testId}>
        <header className={styles.sectionHeader}>
          <span className={styles.sectionIcon} aria-hidden="true">
            {icon}
          </span>
          <h3 className={styles.sectionTitle}>{title}</h3>
          <span className={styles.sectionCount}>{count}</span>
        </header>
        <p className={styles.sectionEmpty}>{empty ?? 'Nothing recorded.'}</p>
      </section>
    );
  }
  return (
    <section className={styles.section} data-testid={testId}>
      <header className={styles.sectionHeader}>
        <span className={styles.sectionIcon} aria-hidden="true">
          {icon}
        </span>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {typeof count === 'number' && <span className={styles.sectionCount}>{count}</span>}
      </header>
      {children}
    </section>
  );
}
