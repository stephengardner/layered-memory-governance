import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { listCanonAtoms, type AtomType, type CanonAtom } from '@/services/canon.service';
import {
  useRouteId,
  useRouteQuery,
  setRoute,
  setRouteQuery,
  routeForAtomId,
  routeHref,
  type Route,
} from '@/state/router.store';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { DriftBanner } from '@/components/drift-banner/DriftBanner';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { SkeletonGrid } from '@/components/skeleton/Skeleton';
import { CanonCard } from './CanonCard';
import { TypeFilter, type TypeOption } from './TypeFilter';
import styles from './CanonViewer.module.css';

const TYPE_OPTIONS: ReadonlyArray<TypeOption> = [
  { id: 'all', label: 'All', types: [] },
  { id: 'directive', label: 'Directives', types: ['directive'] },
  { id: 'decision', label: 'Decisions', types: ['decision'] },
  { id: 'preference', label: 'Preferences', types: ['preference'] },
  { id: 'reference', label: 'References', types: ['reference'] },
];

const VALID_FILTER_IDS = new Set(TYPE_OPTIONS.map((o) => o.id));

/*
 * Read the active type filter from the URL query (?type=directive
 * etc). The URL is the source of truth so the filter survives
 * refresh, is shareable as a deep link, and stays in sync with
 * back/forward navigation. An invalid or missing value falls back to
 * 'all' so a typo can't render the canon view empty.
 */
function readFilterFromUrl(query: URLSearchParams): string {
  const raw = query.get('type');
  return raw && VALID_FILTER_IDS.has(raw) ? raw : 'all';
}

export function CanonViewer() {
  const [localSearch, setLocalSearch] = useState<string>('');
  const focusId = useRouteId();
  const query = useRouteQuery();
  const activeFilterId = readFilterFromUrl(query);

  /*
   * Click handler for type chips: write the filter to the URL query
   * (no path change, no scroll). 'all' clears the param entirely so
   * the URL stays clean (no `?type=all` noise on the default view).
   */
  const handleFilterSelect = (next: string) => {
    setRouteQuery({ type: next === 'all' ? null : next });
  };

  /*
   * When /canon/<id> is in the URL, the search text derives from the
   * route id — NOT mirrored via useEffect. Mirroring caused a visible
   * flash: first render used search='' (fetching all canon), then the
   * effect fired setSearch(focusId) and re-fetched. Between the two
   * fetches, the unfiltered result briefly rendered. Deriving on the
   * same render eliminates that class of flash.
   *
   * `localSearch` still backs the typing UI when no focus is active.
   */
  const search = focusId ?? localSearch;
  const effectiveFilterId = focusId ? 'all' : activeFilterId;
  const activeFilter = TYPE_OPTIONS.find((o) => o.id === effectiveFilterId) ?? TYPE_OPTIONS[0]!;

  const dataQuery = useQuery({
    queryKey: ['canon', activeFilter.types, search],
    queryFn: async ({ signal }) => {
      const trimmed = search.trim();
      const params: Parameters<typeof listCanonAtoms>[0] = {
        ...(activeFilter.types.length > 0 ? { types: activeFilter.types } : {}),
        ...(trimmed.length > 0 ? { search: trimmed } : {}),
      };
      return listCanonAtoms(params, signal);
    },
  });

  const atoms = dataQuery.data ?? [];
  const counts = useMemo(() => countByType(atoms), [atoms]);

  return (
    <section className={styles.viewer} aria-busy={dataQuery.isFetching}>
      {!focusId && <DriftBanner />}
      {focusId && (
        <FocusBanner
          label="Focused on atom"
          id={focusId}
          onClear={() => {
            setLocalSearch('');
            setRoute('canon');
          }}
        />
      )}

      <div className={styles.toolbar}>
        <div className={styles.searchGroup}>
          <Search size={16} strokeWidth={1.75} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search canon... (/)"
            value={search}
            onChange={(e) => {
              // If a route focus is active and the user starts typing,
              // clear the route focus so typing behaves normally.
              if (focusId) setRoute('canon');
              setLocalSearch(e.target.value);
            }}
            data-testid="canon-search"
            data-global-search=""
            aria-label="Search canon"
          />
        </div>
        <TypeFilter
          options={TYPE_OPTIONS}
          activeId={activeFilterId}
          onSelect={handleFilterSelect}
        />
      </div>

      {dataQuery.isPending && <SkeletonGrid count={6} />}
      {dataQuery.isError && (
        <ErrorState title="Could not load canon" message={(dataQuery.error as Error).message} testId="canon-error" />
      )}
      {dataQuery.isSuccess && atoms.length === 0 && <FocusOrEmpty focusId={focusId} />}

      {dataQuery.isSuccess && atoms.length > 0 && (
        <StatsHeader
          total={atoms.length}
          label={`atom${atoms.length === 1 ? '' : 's'}`}
          detail={summarizeCounts(counts)}
        />
      )}

      <motion.div className={styles.grid} layout>
        <AnimatePresence mode="popLayout">
          {atoms.map((atom) => (
            <motion.div
              key={atom.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            >
              <CanonCard atom={atom} />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    </section>
  );
}

function FocusOrEmpty({ focusId }: { focusId: string | null }) {
  // Focus-aware empty state. When the user landed here via an
  // atom-ref that isn't an L3 canon atom, hint at where to find it
  // (plans or activities). AtomRef already routes plan-* and
  // op-action-*/ama-* refs to the right view at click-time, so this
  // only triggers when someone manually opens a canon URL with a
  // non-canon focus id (copy-pasted permalink, etc.).
  if (!focusId) {
    return (
      <EmptyState
        title="No atoms match the current filter."
        detail="Try clearing the search or selecting a different type."
        testId="canon-empty"
      />
    );
  }
  const target: Route = routeForAtomId(focusId);
  if (target === 'canon') {
    return (
      <EmptyState
        title="Atom not found in canon"
        detail={<><code>{focusId}</code> is not in the current canon set.</>}
        testId="canon-empty"
      />
    );
  }
  const label = target === 'plans' ? 'Plans' : 'Activities';
  return (
    <EmptyState
      title="Not in canon"
      detail={<><code>{focusId}</code> is a non-canon atom. Open it in its native view.</>}
      testId="canon-empty"
      action={
        <a
          className={styles.emptyAction}
          href={routeHref(target, focusId)}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute(target, focusId);
          }}
        >
          Open in {label} →
        </a>
      }
    />
  );
}

function countByType(atoms: ReadonlyArray<CanonAtom>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of atoms) out[a.type] = (out[a.type] ?? 0) + 1;
  return out;
}

function summarizeCounts(counts: Record<string, number>): string {
  const order: AtomType[] = ['directive', 'decision', 'preference', 'reference'];
  const parts: string[] = [];
  for (const t of order) {
    if (counts[t]) parts.push(`${counts[t]} ${t}${counts[t] === 1 ? '' : 's'}`);
  }
  for (const [t, n] of Object.entries(counts)) {
    if (!order.includes(t as AtomType)) parts.push(`${n} ${t}`);
  }
  return parts.join(' • ');
}
