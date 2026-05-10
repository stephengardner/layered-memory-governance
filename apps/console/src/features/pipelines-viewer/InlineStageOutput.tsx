import { useQuery } from '@tanstack/react-query';
import { getAtomById } from '@/services/atoms.service';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { pickRenderer } from '@/features/atom-detail-viewer/renderers/dispatch';
import styles from './InlineStageOutput.module.css';

/**
 * Inline stage-output panel.
 *
 * Mounted by StageCard when the operator clicks Expand on a stage. Pulls
 * the stage's output atom (`stage.output_atom_id`) via /api/atoms.get and
 * delegates to the existing renderer dispatch-table from
 * `@/features/atom-detail-viewer/renderers/dispatch` so the per-type
 * formatting (brainstorm Open questions / Alternatives, spec Goal+Body,
 * plan markdown, review findings, dispatch counters) is shared with the
 * /atom/<id> drill-in view rather than duplicated.
 *
 * Per `arch-atomstore-source-of-truth` the projection layer (the API +
 * the in-memory atomIndex) is the single read path; we never reach into
 * .lag/atoms/. Per `dev-web-no-useeffect-for-data` (apps/console
 * principle 4) data flow is TanStack Query, not useEffect.
 *
 * Per `dev-web-mobile-first-required` the panel scrolls horizontally
 * inside its own container when content overflows (large JSON tree,
 * long markdown line) instead of forcing the page to scroll.
 */
export function InlineStageOutput({ atomId }: { atomId: string }) {
  const query = useQuery({
    queryKey: ['atoms.get', atomId],
    queryFn: ({ signal }) => getAtomById(atomId, signal),
    /*
     * Stage-output atoms are immutable once the stage exits; 30s
     * staleness mirrors the AtomDetailView pattern. The TanStack Query
     * cache key is shared so opening the same atom on /atom/<id>
     * later hits the warm cache.
     */
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div
        className={styles.panel}
        data-testid="pipeline-stage-output-loading"
        data-stage-output-atom-id={atomId}
      >
        <LoadingState label="Loading stage output..." testId="pipeline-stage-output-loading-state" />
      </div>
    );
  }

  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <div
        className={styles.panel}
        data-testid="pipeline-stage-output-error"
        data-stage-output-atom-id={atomId}
      >
        <ErrorState
          title="Could not load stage output"
          message={message}
          testId="pipeline-stage-output-error-state"
        />
      </div>
    );
  }

  if (!query.data) {
    return (
      <div
        className={styles.panel}
        data-testid="pipeline-stage-output-empty"
        data-stage-output-atom-id={atomId}
      >
        <EmptyState
          title="Stage output not in store"
          detail={<><code>{atomId}</code> is not in the atom store.</>}
          testId="pipeline-stage-output-empty-state"
        />
      </div>
    );
  }

  const Renderer = pickRenderer(query.data.type, query.data.metadata);

  return (
    <div
      className={styles.panel}
      data-testid="pipeline-stage-output"
      data-stage-output-atom-id={atomId}
      data-stage-output-atom-type={query.data.type}
    >
      <Renderer atom={query.data} />
    </div>
  );
}
