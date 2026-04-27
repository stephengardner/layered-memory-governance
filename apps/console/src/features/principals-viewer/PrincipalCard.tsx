import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Shield, AlertOctagon } from 'lucide-react';
import type { Principal, PrincipalStats } from '@/services/principals.service';
import { setRoute, routeHref } from '@/state/router.store';
import styles from './PrincipalCard.module.css';

interface Props {
  readonly principal: Principal;
  /**
   * Focus mode: when true, the card renders full-width with
   * permissions pre-expanded and click-navigation disabled (the user
   * already opened this principal explicitly). When false, clicks +
   * the title link route to /principals/<id> for the detail surface.
   */
  readonly focused?: boolean;
  /**
   * Optional per-principal atom counts. When present, the card
   * renders a stat-strip ("12 plans, 8 observations, 3 decisions")
   * under the chip row. Absent or zero-total stats render no strip
   * so a fresh-install never shows a misleading "0 plans" line.
   */
  readonly stats?: PrincipalStats;
}

/*
 * The atom types the chip strip surfaces, in operator-priority order.
 * Plans + observations + decisions are the three load-bearing kinds
 * of governance work; everything else (questions, ack, ephemeral)
 * lives in the activity feed.
 */
const SURFACED_TYPES: ReadonlyArray<{ key: string; singular: string; plural: string }> = [
  { key: 'plan', singular: 'plan', plural: 'plans' },
  { key: 'observation', singular: 'observation', plural: 'observations' },
  { key: 'decision', singular: 'decision', plural: 'decisions' },
];

function formatStatLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function PrincipalCard({ principal, focused = false, stats }: Props) {
  // In focus mode, expand permissions automatically so the operator
  // doesn't have to hunt for the second click.
  const [expanded, setExpanded] = useState(focused);
  const compromised = Boolean(principal.compromised_at);
  const root = !principal.signed_by;
  const initials = initialsOf(principal.name || principal.id);

  /*
   * Per-principal atom-count chips. flatMap collapses the
   * "compute count -> filter zeros" into one pass without producing
   * the null-padded map + type-predicate filter dance. Render gate
   * lives on the resulting array length so an empty <div> can never
   * leak into the DOM.
   */
  const visibleStatChips = stats
    ? SURFACED_TYPES.flatMap(({ key, singular, plural }) => {
      const count = stats.by_type[key] ?? 0;
      return count === 0
        ? []
        : [{ key, label: formatStatLabel(count, singular, plural) }];
    })
    : [];

  /*
   * Delegated click: clicking whitespace/text in the card navigates to
   * focus mode. Clicks on interactive descendants (buttons, links,
   * code in pre, form controls) fall through. Text selection is
   * preserved - drag-selected text skips navigation. Only fires when
   * NOT already focused.
   */
  const handleCardClick = (e: React.MouseEvent<HTMLElement>) => {
    if (focused) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, textarea, select, pre')) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    setRoute('principals', principal.id);
  };

  return (
    <article
      className={`${styles.card} ${!principal.active ? styles.cardInactive : ''} ${compromised ? styles.cardCompromised : ''} ${!focused ? styles.cardClickable : ''}`}
      data-testid="principal-card"
      data-principal-id={principal.id}
      onClick={handleCardClick}
    >
      <header className={styles.header}>
        <div className={styles.avatar} aria-hidden="true">{initials}</div>
        <div className={styles.headerText}>
          {focused ? (
            <h3 className={styles.name}>{principal.name}</h3>
          ) : (
            <h3 className={styles.name}>
              <a
                className={styles.nameLink}
                href={routeHref('principals', principal.id)}
                data-testid="principal-card-link"
                onClick={(e) => {
                  if (e.defaultPrevented || e.button !== 0) return;
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  setRoute('principals', principal.id);
                }}
              >
                {principal.name}
              </a>
            </h3>
          )}
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

      <div className={styles.chips} data-testid="principal-card-chips">
        <span className={styles.chip}>role: {principal.role}</span>
        <span className={styles.chip}>{principal.active ? 'active' : 'inactive'}</span>
        {principal.signed_by && (
          <span className={styles.chip}>signed by: {principal.signed_by}</span>
        )}
      </div>

      {visibleStatChips.length > 0 && (
        <div className={styles.stats} data-testid="principal-card-stats">
          {visibleStatChips.map(({ key, label }) => (
            <span key={key} className={styles.statChip} data-stat-type={key}>
              {label}
            </span>
          ))}
        </div>
      )}

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
