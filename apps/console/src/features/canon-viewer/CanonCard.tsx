import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import type { CanonAtom } from '@/services/canon.service';
import styles from './CanonCard.module.css';

interface Props {
  readonly atom: CanonAtom;
}

export function CanonCard({ atom }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasAlternatives = (atom.metadata?.alternatives_rejected?.length ?? 0) > 0;
  const hasWhatBreaks = Boolean(atom.metadata?.what_breaks_if_revisited);
  const hasDetails = hasAlternatives || hasWhatBreaks;

  return (
    <article
      className={`${styles.card} ${styles[`typeTheme_${atom.type}`] ?? ''}`}
      data-testid="canon-card"
      data-atom-id={atom.id}
      data-atom-type={atom.type}
    >
      <header className={styles.header}>
        <span className={styles.typeBadge} data-type={atom.type}>
          {atom.type}
        </span>
        <code className={styles.id}>{atom.id}</code>
      </header>

      <p className={styles.content}>{atom.content}</p>

      <footer className={styles.footer}>
        <span className={styles.meta}>
          <span className={styles.metaLabel}>by</span> {atom.principal_id}
        </span>
        <span className={styles.metaDot} aria-hidden="true">•</span>
        <span className={styles.meta}>
          <span className={styles.metaLabel}>layer</span> {atom.layer}
        </span>
        {hasDetails && (
          <button
            type="button"
            className={`${styles.expand} ${expanded ? styles.expandOpen : ''}`}
            onClick={() => setExpanded((x) => !x)}
            aria-expanded={expanded}
            data-testid={`card-expand-${atom.id}`}
          >
            <ChevronDown size={14} strokeWidth={2} />
            {expanded ? 'Hide rationale' : 'Show rationale'}
          </button>
        )}
      </footer>

      <AnimatePresence initial={false}>
        {expanded && hasDetails && (
          <motion.div
            className={styles.expanded}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          >
            <div className={styles.expandedInner}>
              {hasAlternatives && (
                <div className={styles.section}>
                  <h4 className={styles.sectionTitle}>Alternatives rejected</h4>
                  <ul className={styles.list}>
                    {atom.metadata!.alternatives_rejected!.map((alt, i) => (
                      <li key={i} className={styles.listItem}>
                        <strong className={styles.listItemTitle}>{alt.option}</strong>
                        <span className={styles.listItemReason}>{alt.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {hasWhatBreaks && (
                <div className={styles.section}>
                  <h4 className={styles.sectionTitle}>What breaks if revisited</h4>
                  <p className={styles.sectionBody}>
                    {atom.metadata!.what_breaks_if_revisited}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
