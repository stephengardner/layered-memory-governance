import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listActivities, type Activity } from '@/services/activities.service';
import { useRouteId, setRoute } from '@/state/router.store';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { ActivityHeatmap } from '@/components/heatmap/ActivityHeatmap';
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
    queryKey: ['activities', 500],
    // 500 covers the heatmap's 12-week window comfortably. Poll every
    // 15s so the feed and the heatmap feel live without a WebSocket.
    queryFn: ({ signal }) => listActivities({ limit: 500 }, signal),
    refetchInterval: 15_000,
  });
  const focusId = useRouteId();
  const focusRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!focusId || !query.isSuccess) return;
    const el = focusRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, query.isSuccess]);

  const grouped = useMemo(() => groupByDay(query.data ?? []), [query.data]);

  return (
    <section className={styles.view}>
      {query.isPending && <LoadingState label="Loading activity…" testId="activities-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load activity"
          message={(query.error as Error).message}
          testId="activities-error"
        />
      )}
      {query.isSuccess && grouped.length === 0 && (
        <EmptyState
          title="No atoms with activity yet"
          detail="The atom store is empty for the current filter window."
          testId="activities-empty"
        />
      )}
      {query.isSuccess && grouped.length > 0 && (
        <>
          {focusId && (
            <FocusBanner label="Focused on atom" id={focusId} onClear={() => setRoute('activities')} />
          )}
          <StatsHeader
            total={query.data?.length ?? 0}
            label="recent atoms"
            detail={`across ${grouped.length} day${grouped.length === 1 ? '' : 's'}`}
          />
          <ActivityHeatmap atoms={query.data ?? []} weeks={14} />
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
