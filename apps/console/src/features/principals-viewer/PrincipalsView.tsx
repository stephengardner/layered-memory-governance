import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, GitBranch } from 'lucide-react';
import { listPrincipals } from '@/services/principals.service';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { useRouteId, setRoute } from '@/state/router.store';
import { PrincipalCard } from './PrincipalCard';
import { PrincipalSkill } from './PrincipalSkill';
import { PrincipalTree } from './PrincipalTree';
import styles from './PrincipalsView.module.css';

type Layout = 'grid' | 'tree';

export function PrincipalsView() {
  const [layout, setLayout] = useState<Layout>('grid');
  const focusId = useRouteId();
  const query = useQuery({
    queryKey: ['principals'],
    queryFn: ({ signal }) => listPrincipals(signal),
  });

  const principals = query.data ?? [];
  /*
   * Focus mode: when /principals/<id> is in the URL, render only the
   * matched principal in a full-width detail card with permissions
   * pre-expanded. Operators land on this URL by clicking a card in
   * the grid OR by deep-linking. If the id doesn't resolve, render an
   * explicit "Principal not found" empty state with a clear-focus
   * action so the operator never sees a silent blank.
   */
  const focused = focusId ? principals.find((p) => p.id === focusId) ?? null : null;
  const focusMissing = Boolean(focusId) && query.isSuccess && focused === null;

  return (
    <section className={styles.view}>
      {query.isPending && <LoadingState label="Loading principals…" testId="principals-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load principals"
          message={(query.error as Error).message}
          testId="principals-error"
        />
      )}
      {/*
       * Gate the no-principals empty state on `!focusId` so it does NOT
       * stack with the focusMissing state when the store is empty AND
       * the URL deep-links to a specific id. Without this gate both
       * states render with the same testId, the UI shows duplicate
       * empty cards, and getByTestId becomes ambiguous.
       */}
      {query.isSuccess && principals.length === 0 && !focusId && (
        <EmptyState
          title="No principals found"
          detail="Nothing in .lag/principals/."
          testId="principals-empty"
        />
      )}
      {focusMissing && (
        <EmptyState
          title="Principal not found"
          detail={<><code>{focusId}</code> is not in the current principal set.</>}
          action={
            <button
              type="button"
              className={styles.clearButton}
              onClick={() => setRoute('principals')}
              data-testid="principals-focus-clear"
            >
              Clear focus
            </button>
          }
          testId="principals-empty"
        />
      )}
      {query.isSuccess && principals.length > 0 && !focusMissing && (
        <>
          {focusId && focused && (
            <FocusBanner
              label="Focused on principal"
              id={focusId}
              onClear={() => setRoute('principals')}
            />
          )}
          {!focusId && (
            <div className={styles.toolbar}>
              <StatsHeader
                total={principals.length}
                label={`principal${principals.length === 1 ? '' : 's'}`}
              />
              <div className={styles.layoutToggle} role="tablist" aria-label="Layout">
                <button
                  type="button"
                  role="tab"
                  aria-selected={layout === 'grid'}
                  className={`${styles.layoutBtn} ${layout === 'grid' ? styles.layoutBtnActive : ''}`}
                  onClick={() => setLayout('grid')}
                  data-testid="layout-grid"
                >
                  <LayoutGrid size={14} strokeWidth={1.75} /> grid
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={layout === 'tree'}
                  className={`${styles.layoutBtn} ${layout === 'tree' ? styles.layoutBtnActive : ''}`}
                  onClick={() => setLayout('tree')}
                  data-testid="layout-tree"
                >
                  <GitBranch size={14} strokeWidth={1.75} /> tree
                </button>
              </div>
            </div>
          )}
          {focusId && focused ? (
            <div className={`${styles.grid} ${styles.gridFocused}`}>
              <PrincipalCard principal={focused} focused={true} />
              <PrincipalSkill principalId={focused.id} />
            </div>
          ) : layout === 'grid' ? (
            <div className={styles.grid}>
              {principals.map((p) => (
                <PrincipalCard key={p.id} principal={p} focused={false} />
              ))}
            </div>
          ) : (
            <PrincipalTree principals={principals} />
          )}
        </>
      )}
    </section>
  );
}
