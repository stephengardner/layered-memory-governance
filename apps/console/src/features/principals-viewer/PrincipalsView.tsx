import { useQuery } from '@tanstack/react-query';
import { listPrincipals } from '@/services/principals.service';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { PrincipalCard } from './PrincipalCard';
import styles from './PrincipalsView.module.css';

export function PrincipalsView() {
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
          <StatsHeader
            total={principals.length}
            label={`principal${principals.length === 1 ? '' : 's'}`}
          />
          <div className={styles.grid}>
            {principals.map((p) => (
              <PrincipalCard key={p.id} principal={p} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
