import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { listActivities, type Activity } from '@/services/activities.service';
import { useRouteQuery, setRoute } from '@/state/router.store';
import styles from './ActivitiesView.module.css';

const TYPE_DOT_COLORS: Record<string, string> = {
  directive: 'var(--status-danger)',
  decision: 'var(--accent)',
  preference: 'var(--status-warning)',
  reference: 'var(--status-success)',
  observation: 'var(--text-muted)',
  'actor-message': 'var(--accent-hover)',
  plan: 'var(--accent-active)',
  question: 'var(--text-tertiary)',
};

export function ActivitiesView() {
  const query = useQuery({
    queryKey: ['activities', 200],
    queryFn: ({ signal }) => listActivities({ limit: 200 }, signal),
  });
  const routeQuery = useRouteQuery();
  const focusId = routeQuery.get('focus');
  const focusRef = useRef<HTMLLIElement | null>(null);

  // When `?focus=<id>` is in the URL and the atom lands in the list,
  // scroll the matching item into view and pulse-highlight it so the
  // user immediately sees where the reference resolved.
  useEffect(() => {
    if (!focusId || !query.isSuccess) return;
    const el = focusRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, query.isSuccess]);

  const grouped = useMemo(() => groupByDay(query.data ?? []), [query.data]);

  return (
    <section className={styles.view}>
      {query.isPending && (
        <div className={styles.state} data-testid="activities-loading">
          <div className={styles.spinner} aria-hidden="true" />
          <p>Loading activity…</p>
        </div>
      )}
      {query.isError && (
        <div className={styles.state} data-testid="activities-error">
          <p className={styles.errorTitle}>Could not load activity</p>
          <code className={styles.errorDetail}>{(query.error as Error).message}</code>
        </div>
      )}
      {query.isSuccess && grouped.length === 0 && (
        <div className={styles.state} data-testid="activities-empty">
          <p>No atoms with activity yet.</p>
        </div>
      )}
      {query.isSuccess && grouped.length > 0 && (
        <>
          {focusId && (
            <div className={styles.focusBanner}>
              <span className={styles.focusLabel}>Focused on atom</span>
              <code className={styles.focusId}>{focusId}</code>
              <button
                type="button"
                className={styles.focusClear}
                onClick={() => setRoute('activities')}
                aria-label="Clear focus"
              >
                <X size={12} strokeWidth={2.5} /> clear
              </button>
            </div>
          )}
          <div className={styles.stats}>
            <span className={styles.statsTotal}>{query.data?.length ?? 0}</span>
            <span className={styles.statsLabel}>recent atoms</span>
            <span className={styles.statsDetail}>across {grouped.length} days</span>
          </div>
          <ol className={styles.timeline}>
            {grouped.map(({ day, items }) => (
              <li key={day} className={styles.dayGroup}>
                <div className={styles.dayLabel}>{day}</div>
                <ol className={styles.items}>
                  {items.map((a) => (
                    <li
                      key={a.id}
                      ref={focusId === a.id ? focusRef : undefined}
                      className={`${styles.item} ${focusId === a.id ? styles.itemFocused : ''}`}
                      data-testid="activity-item"
                      data-atom-id={a.id}
                      data-atom-type={a.type}
                    >
                      <span
                        className={styles.dot}
                        style={{ background: TYPE_DOT_COLORS[a.type] ?? 'var(--text-muted)' }}
                        aria-hidden="true"
                      />
                      <div className={styles.itemHead}>
                        <span className={styles.itemType}>{a.type}</span>
                        <code className={styles.itemId}>{a.id}</code>
                        <span className={styles.itemTime}>{formatTime(a.created_at)}</span>
                      </div>
                      <p className={styles.itemContent}>{truncate(a.content, 220)}</p>
                      <div className={styles.itemMeta}>
                        <span>by {a.principal_id}</span>
                        <span>•</span>
                        <span>layer {a.layer}</span>
                        {typeof a.confidence === 'number' && (
                          <>
                            <span>•</span>
                            <span>conf {a.confidence.toFixed(2)}</span>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function groupByDay(
  items: ReadonlyArray<Activity>,
): ReadonlyArray<{ day: string; items: ReadonlyArray<Activity> }> {
  const buckets = new Map<string, Activity[]>();
  for (const a of items) {
    const d = dayKey(a.created_at);
    const bucket = buckets.get(d);
    if (bucket) bucket.push(a);
    else buckets.set(d, [a]);
  }
  return Array.from(buckets.entries()).map(([day, items]) => ({ day, items }));
}

function dayKey(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return 'Unknown';
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}
