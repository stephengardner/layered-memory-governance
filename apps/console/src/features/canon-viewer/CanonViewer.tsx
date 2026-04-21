import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { listCanonAtoms, type AtomType, type CanonAtom } from '@/services/canon.service';
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

export function CanonViewer() {
  const [activeFilterId, setActiveFilterId] = useState<string>('all');
  const [search, setSearch] = useState<string>('');

  const activeFilter = TYPE_OPTIONS.find((o) => o.id === activeFilterId) ?? TYPE_OPTIONS[0]!;

  const query = useQuery({
    queryKey: ['canon', activeFilter.types, search],
    queryFn: async ({ signal }) => {
      const trimmed = search.trim();
      // Build the params object all-at-once because ListCanonParams
      // uses readonly fields (exactOptionalPropertyTypes forbids
      // post-construction assignment of undefined-valued optionals).
      const params: Parameters<typeof listCanonAtoms>[0] = {
        ...(activeFilter.types.length > 0 ? { types: activeFilter.types } : {}),
        ...(trimmed.length > 0 ? { search: trimmed } : {}),
      };
      return listCanonAtoms(params, signal);
    },
  });

  const atoms = query.data ?? [];
  const counts = useMemo(() => countByType(atoms), [atoms]);

  return (
    <section className={styles.viewer} aria-busy={query.isFetching}>
      <div className={styles.toolbar}>
        <div className={styles.searchGroup}>
          <Search size={16} strokeWidth={1.75} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search canon..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="canon-search"
            aria-label="Search canon"
          />
        </div>
        <TypeFilter
          options={TYPE_OPTIONS}
          activeId={activeFilterId}
          onSelect={setActiveFilterId}
        />
      </div>

      {query.isPending && <LoadingState />}
      {query.isError && <ErrorState message={(query.error as Error).message} />}
      {query.isSuccess && atoms.length === 0 && <EmptyState />}

      {query.isSuccess && atoms.length > 0 && (
        <div className={styles.stats}>
          <span className={styles.statsTotal}>{atoms.length}</span>
          <span className={styles.statsLabel}>
            atom{atoms.length === 1 ? '' : 's'}
          </span>
          <span className={styles.statsDetail}>
            {summarizeCounts(counts)}
          </span>
        </div>
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

function LoadingState() {
  return (
    <div className={styles.state} data-testid="canon-loading">
      <div className={styles.spinner} aria-hidden="true" />
      <p>Loading canon…</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className={styles.state} data-testid="canon-error">
      <p className={styles.errorTitle}>Could not load canon</p>
      <code className={styles.errorDetail}>{message}</code>
    </div>
  );
}

function EmptyState() {
  return (
    <div className={styles.state} data-testid="canon-empty">
      <p className={styles.emptyTitle}>No atoms match the current filter.</p>
      <p className={styles.emptyDetail}>
        Try clearing the search or selecting a different type.
      </p>
    </div>
  );
}
