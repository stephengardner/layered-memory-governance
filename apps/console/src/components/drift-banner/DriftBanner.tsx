import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { TrendingDown, Clock, AlertTriangle, ChevronDown, X } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { getCanonDrift, type CanonAtom } from '@/services/canon.service';
import styles from './DriftBanner.module.css';

/**
 * Canon health banner. Renders a compact health summary at the top
 * of the canon view: stale atoms (not reinforced in 90d), atoms
 * expiring in 30d, atoms with confidence dropped below 0.7. Click
 * to expand the full list; dismiss to hide for the session.
 *
 * This is the "canon needs re-validation" surface — surfaces drift
 * before it becomes a compliance problem.
 */
export function DriftBanner() {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const query = useQuery({
    queryKey: ['canon.drift'],
    queryFn: ({ signal }) => getCanonDrift(signal),
    staleTime: 60_000,
  });

  const drift = query.data;
  if (!drift || dismissed) return null;
  const total = drift.stale.length + drift.expiring.length + drift.lowConfidence.length;
  if (total === 0) return null;

  return (
    <div className={styles.banner} data-testid="drift-banner">
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
      >
        <AlertTriangle size={14} strokeWidth={2} />
        <span className={styles.summary}>
          <strong>{total}</strong> canon atom{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} attention
        </span>
        <span className={styles.chips}>
          {drift.stale.length > 0 && (
            <span className={styles.chip} data-kind="stale">
              <Clock size={10} strokeWidth={2.5} /> {drift.stale.length} stale
            </span>
          )}
          {drift.expiring.length > 0 && (
            <span className={styles.chip} data-kind="expiring">
              <Clock size={10} strokeWidth={2.5} /> {drift.expiring.length} expiring
            </span>
          )}
          {drift.lowConfidence.length > 0 && (
            <span className={styles.chip} data-kind="low-confidence">
              <TrendingDown size={10} strokeWidth={2.5} /> {drift.lowConfidence.length} low-conf
            </span>
          )}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
        />
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => setDismissed(true)}
        aria-label="Dismiss drift banner"
      >
        <X size={12} strokeWidth={2.5} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className={styles.body}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <div className={styles.bodyInner}>
              {drift.stale.length > 0 && (
                <DriftSection title="Stale (90+ days)" atoms={drift.stale} />
              )}
              {drift.expiring.length > 0 && (
                <DriftSection title="Expiring (within 30 days)" atoms={drift.expiring} />
              )}
              {drift.lowConfidence.length > 0 && (
                <DriftSection title="Low confidence (<0.70)" atoms={drift.lowConfidence} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DriftSection({ title, atoms }: { title: string; atoms: ReadonlyArray<CanonAtom> }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      <ul className={styles.list}>
        {atoms.slice(0, 12).map((a) => (
          <li key={a.id}>
            <AtomRef id={a.id} />
          </li>
        ))}
        {atoms.length > 12 && (
          <li className={styles.more}>+{atoms.length - 12} more</li>
        )}
      </ul>
    </div>
  );
}
