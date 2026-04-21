import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { listPlans, type PlanAtom } from '@/services/plans.service';
import { useRouteId, setRoute, routeHref } from '@/state/router.store';
import styles from './PlansView.module.css';

const STATE_TONE: Record<string, string> = {
  approved: 'var(--status-success)',
  pending: 'var(--status-warning)',
  rejected: 'var(--status-danger)',
  proposed: 'var(--accent)',
  draft: 'var(--text-tertiary)',
};

const ATOM_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){3,}$/;

/*
 * Custom markdown renderer: inline `code` that matches an atom-id
 * pattern gets promoted to a clickable AtomRef. Block code is left
 * alone. Lets references inside plan bodies cross-navigate to canon
 * / plans / activities just like structured refs in a CanonCard.
 */
const MARKDOWN_COMPONENTS = {
  code({ children, ...props }: { children?: ReactNode; className?: string | undefined }) {
    const text = String(children ?? '');
    const isBlock = Boolean(props.className) || text.includes('\n');
    if (!isBlock && text.length <= 120 && ATOM_ID_RE.test(text)) {
      return <AtomRef id={text} variant="inline" />;
    }
    return <code {...props}>{children}</code>;
  },
};

export function PlansView() {
  const query = useQuery({
    queryKey: ['plans'],
    queryFn: ({ signal }) => listPlans(signal),
  });
  const focusId = useRouteId();

  const allPlans = query.data ?? [];
  const plans = useMemo(() => {
    if (!focusId) return allPlans;
    return allPlans.filter((p) => p.id === focusId);
  }, [allPlans, focusId]);

  return (
    <section className={styles.view}>
      {query.isPending && <LoadingState label="Loading plans…" testId="plans-loading" />}
      {query.isError && (
        <ErrorState title="Could not load plans" message={(query.error as Error).message} testId="plans-error" />
      )}
      {query.isSuccess && plans.length === 0 && (
        focusId ? (
          <EmptyState
            title="Plan not found"
            detail={<><code>{focusId}</code> is not in the current plan set.</>}
            action={
              <button type="button" className={styles.clearButton} onClick={() => setRoute('plans')}>
                Clear focus
              </button>
            }
            testId="plans-empty"
          />
        ) : (
          <EmptyState
            title="No plan atoms found"
            detail="Plans appear here when an atom has type=plan or a top-level plan_state field. The repo currently has neither."
            testId="plans-empty"
          />
        )
      )}
      {query.isSuccess && plans.length > 0 && (
        <>
          {focusId && (
            <FocusBanner label="Focused on plan" id={focusId} onClear={() => setRoute('plans')} />
          )}
          <StatsHeader
            total={plans.length}
            label={`plan${plans.length === 1 ? '' : 's'}`}
            detail={focusId ? '(filtered to focus)' : undefined}
          />
          {focusId ? (
            <div className={`${styles.grid} ${styles.gridFocused}`}>
              {plans.map((p) => (
                <PlanCard key={p.id} plan={p} focused={true} />
              ))}
            </div>
          ) : (
            /*
             * Two-stack masonry: plans distributed by index parity
             * into left/right stacks. Expanding a card only grows
             * its own stack — CSS-columns would re-balance and jump
             * cards between columns, which violates the
             * interaction-quality canon (no visible jank).
             */
            <div className={styles.grid}>
              <div className={styles.stack}>
                {plans.filter((_, i) => i % 2 === 0).map((p) => (
                  <PlanCard key={p.id} plan={p} focused={false} />
                ))}
              </div>
              <div className={styles.stack}>
                {plans.filter((_, i) => i % 2 === 1).map((p) => (
                  <PlanCard key={p.id} plan={p} focused={false} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PlanCard({ plan, focused }: { plan: PlanAtom; focused: boolean }) {
  /*
   * Focus mode starts EXPANDED — the user opened /plans/<id>
   * explicitly to read this plan, so defaulting to clamped would
   * make them click Read more as a second step. Grid view starts
   * clamped with the accordion; user expands individually.
   * The "Collapse" button still works in focus mode for re-folding.
   */
  const [expanded, setExpanded] = useState(focused);

  const state = plan.plan_state ?? 'unknown';
  const { title, body } = splitTitleAndBody(plan.content);

  /*
   * Delegated click: clicking whitespace/text in the card navigates to
   * focus mode. Clicks on interactive descendants (a, button, code in
   * pre, form controls) fall through. Text selection is preserved —
   * if the user drag-selected text, skip navigation. Only fires when
   * NOT already focused (no-op if we're already on /plans/:id).
   */
  const handleCardClick = (e: React.MouseEvent<HTMLElement>) => {
    if (focused) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, textarea, select, pre')) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    setRoute('plans', plan.id);
  };

  return (
    <article
      className={`${styles.card} ${!focused ? styles.cardClickable : ''}`}
      data-testid="plan-card"
      data-atom-id={plan.id}
      onClick={handleCardClick}
    >
      <header className={styles.header}>
        <span
          className={styles.statePill}
          style={{ borderColor: STATE_TONE[state] ?? 'var(--border-subtle)', color: STATE_TONE[state] ?? 'var(--text-secondary)' }}
        >
          {state}
        </span>
        <code className={styles.id}>{plan.id}</code>
      </header>

      {title && (
        focused ? (
          <h3 className={styles.title}>{title}</h3>
        ) : (
          <h3 className={styles.title}>
            <a
              className={styles.titleLink}
              href={routeHref('plans', plan.id)}
              data-testid="plan-card-link"
              onClick={(e) => {
                if (e.defaultPrevented || e.button !== 0) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                setRoute('plans', plan.id);
              }}
            >
              {title}
            </a>
          </h3>
        )
      )}

      {/*
        initial={false} makes framer-motion render the first frame
        already in the target state (clamped 12rem), no mount-time
        animation. Without it, the card briefly renders at natural
        height then animates down to the clamp — visible flash on
        page load that violates dev-web-interaction-quality-no-jank.
      */}
      <motion.div
        className={`${styles.content} ${expanded ? styles.contentExpanded : styles.contentClamped}`}
        initial={false}
        animate={{ height: expanded ? 'auto' : '12rem' }}
        transition={{ duration: 0.32, ease: [0.2, 0, 0, 1] }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{body}</ReactMarkdown>
      </motion.div>

      <button
        type="button"
        className={`${styles.expand} ${expanded ? styles.expandOpen : ''}`}
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        data-testid={`plan-expand-${plan.id}`}
      >
        <ChevronDown size={14} strokeWidth={2} />
        {expanded ? 'Collapse' : 'Read more'}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.footer
            className={styles.footer}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <span>by {plan.principal_id}</span>
            <span>•</span>
            <span>layer {plan.layer}</span>
            <span>•</span>
            <span>{new Date(plan.created_at).toLocaleString()}</span>
          </motion.footer>
        )}
      </AnimatePresence>
    </article>
  );
}

function splitTitleAndBody(md: string): { title: string | null; body: string } {
  const lines = md.split('\n');
  let firstNonBlank = 0;
  while (firstNonBlank < lines.length && lines[firstNonBlank]!.trim().length === 0) {
    firstNonBlank++;
  }
  const candidate = lines[firstNonBlank] ?? '';
  const match = candidate.match(/^#{1,3}\s+(.+)$/);
  if (match && match[1]) {
    const body = lines.slice(firstNonBlank + 1).join('\n').trimStart();
    return { title: match[1].trim(), body };
  }
  return { title: null, body: md };
}
