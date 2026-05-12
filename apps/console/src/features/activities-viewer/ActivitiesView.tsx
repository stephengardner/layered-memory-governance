import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listActivities, type Activity } from '@/services/activities.service';
import { storage } from '@/services/storage.service';
import { useRouteId, setRoute } from '@/state/router.store';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import { PrincipalLink } from '@/components/principal-link/PrincipalLink';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { ActivityHeatmap } from '@/components/heatmap/ActivityHeatmap';
import { atomTypeTone } from '@/features/atom-type-tones/tones';
import {
  normalizeIncludeReaped,
  REAPED_TOGGLE_STORAGE_KEY,
} from './reapedToggle';
import styles from './ActivitiesView.module.css';

export function ActivitiesView() {
  /*
   * Reaped-atoms toggle state. Default-hide mirrors the server's
   * default-hide posture (`apps/console/server/reaped-filter.ts`);
   * the operator opts in to the historical view by clicking the
   * toggle. Persisted via storage.service so a triage session that
   * flipped the toggle survives reloads. `normalizeIncludeReaped`
   * coerces the persisted value back to a boolean (returning the
   * DEFAULT_INCLUDE_REAPED constant when nothing is stored or when
   * the stored value is malformed) so version skew never throws.
   */
  const [includeReaped, setIncludeReaped] = useState<boolean>(() =>
    normalizeIncludeReaped(storage.get<unknown>(REAPED_TOGGLE_STORAGE_KEY)),
  );

  const handleToggle = () => {
    setIncludeReaped((prev) => {
      const next = !prev;
      storage.set(REAPED_TOGGLE_STORAGE_KEY, next);
      return next;
    });
  };

  const query = useQuery({
    /*
     * 20000 covers ~84 days (12 weeks) at the observed ~238 atoms/day
     * mean. At sustained mean throughput the full 14-week (98-day)
     * window would total ~23,324 atoms, so dense weeks at the tail
     * can graze the cap; when that becomes the steady state we move
     * to time-windowing rather than raising a fixed cap further. Cap
     * raised from 500 so the feed + heatmap reflect a representative
     * ~12-week window. Poll every 60s -- the heatmap is a 14-week
     * aggregate that doesn't need sub-minute freshness, and refetching
     * 20k atoms on a 15s tick is a bandwidth/CPU regression on the
     * request path. The ActorActivity stream already covers fast-moving
     * sub-second visibility for the operator-critical "what is the
     * org doing now" question.
     *
     * The include_reaped flag is part of the queryKey so flipping the
     * toggle surgically refetches with the new posture and TanStack
     * cache holds both variants concurrently (no flicker on toggle
     * after the first fetch of each).
     */
    queryKey: ['activities', 20000, includeReaped ? 'include-reaped' : 'hide-reaped'],
    queryFn: ({ signal }) =>
      listActivities({ limit: 20000, include_reaped: includeReaped }, signal),
    refetchInterval: 60_000,
  });
  const focusId = useRouteId();
  const focusRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!focusId || !query.isSuccess) return;
    const el = focusRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, query.isSuccess]);

  const atoms = query.data?.atoms ?? [];
  const reapedCount = query.data?.reaped_count ?? 0;
  const grouped = useMemo(() => groupByDay(atoms), [atoms]);

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
      {query.isSuccess && grouped.length === 0 && reapedCount === 0 && (
        <EmptyState
          title="No atoms with activity yet"
          detail="The atom store is empty for the current filter window."
          testId="activities-empty"
        />
      )}
      {query.isSuccess && (grouped.length > 0 || reapedCount > 0) && (
        <>
          {focusId && (
            <FocusBanner label="Focused on atom" id={focusId} onClear={() => setRoute('activities')} />
          )}
          <StatsHeader
            total={atoms.length}
            label="recent atoms"
            detail={`across ${grouped.length} day${grouped.length === 1 ? '' : 's'}`}
          />
          {/*
            Reaped-atoms toggle. Always renders so the operator can flip
            it even when the count is zero (a fresh deployment or a
            window where no reaper has run); count of 0 still reads
            cleanly as "Show reaped (0)" so the toggle is discoverable.
            When toggled ON, label becomes "Hide reaped (N)" so the
            press-state is unambiguous.
          */}
          <ReapedToggle
            includeReaped={includeReaped}
            reapedCount={reapedCount}
            onToggle={handleToggle}
          />
          {grouped.length > 0 ? (
            <>
              <ActivityHeatmap atoms={atoms} weeks={14} />
              <ol className={styles.timeline}>
                {grouped.map(({ day, items }) => (
                  <li key={day} className={styles.dayGroup}>
                    <div className={styles.dayLabel}>{day}</div>
                    <ol className={styles.items}>
                      {items.map((a) => {
                        const reaped = isReapedAtom(a);
                        return (
                          <li
                            key={a.id}
                            ref={focusId === a.id ? focusRef : undefined}
                            className={`${styles.item} ${focusId === a.id ? styles.itemFocused : ''} ${reaped ? styles.itemReaped : ''}`}
                            data-testid="activity-item"
                            data-atom-id={a.id}
                            data-atom-type={a.type}
                            {...(reaped ? { 'data-reaped': 'true' } : {})}
                          >
                            <span
                              className={styles.dot}
                              style={{ background: atomTypeTone(a.type) }}
                              aria-hidden="true"
                            />
                            <div className={styles.itemHead}>
                              <span className={styles.itemType}>{a.type}</span>
                              <code className={styles.itemId}>{a.id}</code>
                              <span className={styles.itemTime}>{formatTime(a.created_at)}</span>
                              {reaped && (
                                <span
                                  className={styles.reapedBadge}
                                  data-testid="activity-item-reaped-badge"
                                  title="This atom was reaped by the pipeline GC"
                                >
                                  reaped
                                </span>
                              )}
                            </div>
                            <p className={styles.itemContent}>{truncate(a.content, 220)}</p>
                            <div className={styles.itemMeta}>
                              <span>
                                by{' '}
                                <PrincipalLink
                                  id={a.principal_id}
                                  testId="activity-item-principal-link"
                                />
                              </span>
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
                        );
                      })}
                    </ol>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            /*
             * Filter-empty state: the only items in the slice were
             * reaped, and the toggle is off. Mirrors plans-filter-empty
             * in shape so the surface is consistent.
             */
            <EmptyState
              title="All recent atoms are reaped"
              detail={
                <>
                  The current window has {reapedCount} reaped atom{reapedCount === 1 ? '' : 's'} and none live.{' '}
                  <button
                    type="button"
                    className={styles.inlineLink}
                    onClick={handleToggle}
                    data-testid="activities-show-reaped-link"
                  >
                    Show reaped
                  </button>
                </>
              }
              testId="activities-filter-empty"
            />
          )}
        </>
      )}
    </section>
  );
}

/*
 * Reaped-atoms toggle button. Pill-shaped, sits under StatsHeader
 * above the heatmap so the operator sees the count without scrolling.
 * `aria-pressed` reflects the on/off state; press-state and label
 * change in lockstep so screen-reader semantics + visible text agree.
 */
function ReapedToggle({
  includeReaped,
  reapedCount,
  onToggle,
}: {
  includeReaped: boolean;
  reapedCount: number;
  onToggle: () => void;
}) {
  const label = includeReaped ? 'Hide reaped' : 'Show reaped';
  return (
    <div className={styles.reapedToggleRow}>
      <button
        type="button"
        className={`${styles.reapedToggle} ${includeReaped ? styles.reapedToggleOn : ''}`}
        aria-pressed={includeReaped}
        data-testid="activities-reaped-toggle"
        onClick={onToggle}
      >
        <span className={styles.reapedToggleLabel}>{label}</span>
        <span className={styles.reapedToggleCount} data-testid="activities-reaped-count">
          {reapedCount}
        </span>
      </button>
    </div>
  );
}

/*
 * Pure helper: does this atom carry the reaped marker? Mirrors the
 * server-side `isReaped` predicate (apps/console/server/reaped-filter.ts)
 * so when the toggle is ON, the visual badge fires on the same atoms
 * the server treated as reaped.
 */
function isReapedAtom(atom: Activity): boolean {
  const meta = atom.metadata;
  if (!meta) return false;
  const v = (meta as Record<string, unknown>)['reaped_at'];
  return typeof v === 'string' && v.length > 0;
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
