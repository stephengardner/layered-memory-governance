import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Shield, AlertOctagon } from 'lucide-react';
import type { Principal } from '@/services/principals.service';
import styles from './PrincipalCard.module.css';

interface Props {
  readonly principal: Principal;
}

export function PrincipalCard({ principal }: Props) {
  const [expanded, setExpanded] = useState(false);
  const compromised = Boolean(principal.compromised_at);
  const root = !principal.signed_by;
  const initials = initialsOf(principal.name || principal.id);

  return (
    <article
      className={`${styles.card} ${!principal.active ? styles.cardInactive : ''} ${compromised ? styles.cardCompromised : ''}`}
      data-testid="principal-card"
      data-principal-id={principal.id}
    >
      <header className={styles.header}>
        <div className={styles.avatar} aria-hidden="true">{initials}</div>
        <div className={styles.headerText}>
          <h3 className={styles.name}>{principal.name}</h3>
          <code className={styles.id}>{principal.id}</code>
        </div>
        {root && (
          <span className={styles.statusPill} data-variant="root" title="Root principal">
            <Shield size={12} strokeWidth={2.25} aria-hidden="true" />
            root
          </span>
        )}
        {compromised && (
          <span className={styles.statusPill} data-variant="danger" title="Compromised">
            <AlertOctagon size={12} strokeWidth={2.25} aria-hidden="true" />
            compromised
          </span>
        )}
      </header>

      <div className={styles.chips}>
        <span className={styles.chip}>role: {principal.role}</span>
        <span className={styles.chip}>{principal.active ? 'active' : 'inactive'}</span>
        {principal.signed_by && (
          <span className={styles.chip}>signed by: {principal.signed_by}</span>
        )}
      </div>

      <button
        type="button"
        className={`${styles.expand} ${expanded ? styles.expandOpen : ''}`}
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        data-testid={`principal-expand-${principal.id}`}
      >
        <ChevronDown size={14} strokeWidth={2} />
        {expanded ? 'Hide permissions' : 'Show permissions'}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className={styles.expanded}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          >
            <div className={styles.expandedInner}>
              <ScopeSection
                title="Permitted scopes"
                read={principal.permitted_scopes?.read}
                write={principal.permitted_scopes?.write}
              />
              <ScopeSection
                title="Permitted layers"
                read={principal.permitted_layers?.read}
                write={principal.permitted_layers?.write}
              />
              {principal.goals && principal.goals.length > 0 && (
                <ListSection title="Goals" items={principal.goals} />
              )}
              {principal.constraints && principal.constraints.length > 0 && (
                <ListSection title="Constraints" items={principal.constraints} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function ScopeSection({
  title,
  read,
  write,
}: {
  title: string;
  read?: ReadonlyArray<string> | undefined;
  write?: ReadonlyArray<string> | undefined;
}) {
  if (!read?.length && !write?.length) return null;
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      <dl className={styles.scopes}>
        {read && read.length > 0 && (
          <>
            <dt className={styles.scopeLabel}>read</dt>
            <dd className={styles.scopeValue}>{read.join(', ')}</dd>
          </>
        )}
        {write && write.length > 0 && (
          <>
            <dt className={styles.scopeLabel}>write</dt>
            <dd className={styles.scopeValue}>{write.join(', ')}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: ReadonlyArray<string> }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      <ul className={styles.list}>
        {items.map((it, i) => (
          <li key={i} className={styles.listItem}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function initialsOf(s: string): string {
  const parts = s.split(/[\s\-_]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
