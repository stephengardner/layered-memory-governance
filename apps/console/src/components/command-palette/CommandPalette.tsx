import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { Search, ArrowRight } from 'lucide-react';
import { listCanonAtoms } from '@/services/canon.service';
import { listPrincipals } from '@/services/principals.service';
import { listPlans } from '@/services/plans.service';
import { listActivities } from '@/services/activities.service';
import { setRoute, type Route } from '@/state/router.store';
import styles from './CommandPalette.module.css';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

interface Entry {
  readonly kind: 'canon' | 'principal' | 'plan' | 'activity' | 'nav';
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly route: Route;
  readonly routeId?: string;
}

const NAV_ENTRIES: ReadonlyArray<Entry> = [
  { kind: 'nav', id: 'nav:canon', title: 'Go to Canon', subtitle: 'directives · decisions · preferences · references', route: 'canon' },
  { kind: 'nav', id: 'nav:principals', title: 'Go to Principals', subtitle: 'identities authoring atoms', route: 'principals' },
  { kind: 'nav', id: 'nav:activities', title: 'Go to Activities', subtitle: 'recent atoms across layers', route: 'activities' },
  { kind: 'nav', id: 'nav:plans', title: 'Go to Plans', subtitle: 'in-flight planning atoms', route: 'plans' },
];

export function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lazy-load all four datasets the first time the palette opens.
  // TanStack caches — subsequent opens are instant.
  const canonQ = useQuery({ queryKey: ['canon', [], ''], queryFn: ({ signal }) => listCanonAtoms({}, signal), enabled: open });
  const principalsQ = useQuery({ queryKey: ['principals'], queryFn: ({ signal }) => listPrincipals(signal), enabled: open });
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: ({ signal }) => listPlans(signal), enabled: open });
  const activitiesQ = useQuery({
    queryKey: ['activities', 500],
    queryFn: ({ signal }) => listActivities({ limit: 500 }, signal),
    enabled: open,
  });

  const entries = useMemo<ReadonlyArray<Entry>>(() => {
    const canon: Entry[] = (canonQ.data ?? []).map((a) => ({
      kind: 'canon', id: `canon:${a.id}`, title: a.id, subtitle: a.content.slice(0, 120), route: 'canon', routeId: a.id,
    }));
    const principals: Entry[] = (principalsQ.data ?? []).map((p) => ({
      kind: 'principal', id: `principal:${p.id}`, title: p.name ?? p.id, subtitle: `${p.role} · ${p.id}`, route: 'principals', routeId: p.id,
    }));
    const plans: Entry[] = (plansQ.data ?? []).map((p) => ({
      kind: 'plan', id: `plan:${p.id}`, title: extractTitle(p.content) ?? p.id, subtitle: p.id, route: 'plans', routeId: p.id,
    }));
    const activities: Entry[] = (activitiesQ.data ?? []).map((a) => ({
      kind: 'activity', id: `activity:${a.id}`, title: a.id, subtitle: `${a.type} · ${a.content.slice(0, 80)}`, route: 'activities', routeId: a.id,
    }));
    return [...NAV_ENTRIES, ...canon, ...principals, ...plans, ...activities];
  }, [canonQ.data, principalsQ.data, plansQ.data, activitiesQ.data]);

  const matches = useMemo(() => filterAndRank(entries, query).slice(0, 30), [entries, query]);

  // Reset cursor + query when the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Clamp cursor into range as results change.
  useEffect(() => {
    if (cursor >= matches.length) setCursor(Math.max(0, matches.length - 1));
  }, [matches.length, cursor]);

  // Keyboard: arrows + enter + escape. Scoped to the palette lifecycle.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(matches.length - 1, c + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const m = matches[cursor];
        if (m) {
          setRoute(m.route, m.routeId);
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, matches, cursor, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={onClose}
            data-testid="command-backdrop"
          />
          <div className={styles.wrap}>
            <motion.div
              className={styles.dialog}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
              role="dialog"
              aria-label="Command palette"
              data-testid="command-palette"
            >
              <div className={styles.inputRow}>
                <Search size={16} strokeWidth={1.75} className={styles.icon} aria-hidden="true" />
                <input
                  ref={inputRef}
                  type="text"
                  className={styles.input}
                  placeholder="Search atoms, principals, plans…"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
                  data-testid="command-input"
                  aria-label="Command search"
                />
                <kbd className={styles.esc}>Esc</kbd>
              </div>
              <ol className={styles.list}>
                {matches.length === 0 && (
                  <li className={styles.empty}>No matches for "{query}"</li>
                )}
                {matches.map((m, i) => (
                  <li
                    key={m.id}
                    className={`${styles.item} ${i === cursor ? styles.itemActive : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => { setRoute(m.route, m.routeId); onClose(); }}
                    data-testid="command-item"
                    data-entry-id={m.id}
                    data-entry-kind={m.kind}
                  >
                    <span className={styles.itemKind} data-kind={m.kind}>{kindLabel(m.kind)}</span>
                    <div className={styles.itemBody}>
                      <div className={styles.itemTitle}>{m.title}</div>
                      {m.subtitle && <div className={styles.itemSub}>{m.subtitle}</div>}
                    </div>
                    <ArrowRight size={14} strokeWidth={2} className={styles.itemArrow} />
                  </li>
                ))}
              </ol>
              <div className={styles.foot}>
                <span><kbd className={styles.hintKbd}>↑</kbd><kbd className={styles.hintKbd}>↓</kbd> navigate</span>
                <span><kbd className={styles.hintKbd}>⏎</kbd> open</span>
                <span><kbd className={styles.hintKbd}>Esc</kbd> close</span>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function kindLabel(k: Entry['kind']): string {
  return k === 'nav' ? 'nav' : k;
}

/*
 * Simple substring + token-order match with rank:
 *   exact id match       → rank 0   (top)
 *   title starts-with    → rank 100
 *   title contains all    → rank 200 + index
 *   subtitle contains all → rank 400 + index
 * Ties break by entry order (stable).
 */
function filterAndRank(entries: ReadonlyArray<Entry>, q: string): ReadonlyArray<Entry> {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return entries.slice(0, 30);
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const ranked: Array<{ e: Entry; r: number }> = [];
  for (const e of entries) {
    const title = e.title.toLowerCase();
    const sub = (e.subtitle ?? '').toLowerCase();
    if (title === trimmed) { ranked.push({ e, r: 0 }); continue; }
    if (title.startsWith(trimmed)) { ranked.push({ e, r: 100 }); continue; }
    if (tokens.every((t) => title.includes(t))) { ranked.push({ e, r: 200 + title.indexOf(tokens[0]!) }); continue; }
    if (tokens.every((t) => sub.includes(t))) { ranked.push({ e, r: 400 + sub.indexOf(tokens[0]!) }); continue; }
  }
  return ranked.sort((a, b) => a.r - b.r).map((x) => x.e);
}

function extractTitle(md: string): string | null {
  const first = md.split('\n').find((l) => l.trim().length > 0) ?? '';
  const m = first.match(/^#{1,3}\s+(.+)$/);
  return m && m[1] ? m[1].trim() : null;
}
