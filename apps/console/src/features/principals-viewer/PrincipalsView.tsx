import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, GitBranch } from 'lucide-react';
import { listPrincipals } from '@/services/principals.service';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { PrincipalCard } from './PrincipalCard';
import { PrincipalTree } from './PrincipalTree';
import styles from './PrincipalsView.module.css';

type Layout = 'grid' | 'tree';

export function PrincipalsView() {
  const [layout, setLayout] = useState<Layout>('grid');
  const query = useQuery({
    queryKey: ['principals'],
    queryFn: ({ signal }) => listPrincipals(signal),
  });

  const principals = query.data ?? [];

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
      {query.isSuccess && principals.length === 0 && (
        <EmptyState
          title="No principals found"
          detail="Nothing in .lag/principals/."
          testId="principals-empty"
        />
      )}
      {query.isSuccess && principals.length > 0 && (
        <>
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
          {layout === 'grid' ? (
            <div className={styles.grid}>
              {principals.map((p) => (
                <PrincipalCard key={p.id} principal={p} />
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
