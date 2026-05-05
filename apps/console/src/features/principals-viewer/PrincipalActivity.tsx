import { useQuery } from '@tanstack/react-query';
import { fetchActorActivity, type ActorActivityEntry } from '@/services/actor-activity.service';
import { toErrorMessage } from '@/services/errors';
import { ErrorState } from '@/components/state-display/StateDisplay';
import { routeForAtomId, setRoute } from '@/state/router.store';
import styles from './PrincipalActivity.module.css';

/**
 * Recent-activity feed for the focused principal. Mounts on the
 * principal-detail surface (/principals/<id>) alongside the skill
 * panel, so the operator gets BOTH "soul" content (skill prose)
 * AND "what they did recently" (atom timeline) in one place.
 *
 * Server-side: actor-activity.stream filters live atoms by
 * principal_id, sorts created_at desc, slices top N. The wire
 * payload is bounded by ACTOR_ACTIVITY_MAX_LIMIT regardless of
 * client-passed limit -- DoS defense at the edge.
 *
 * Client side: query is keyed by principalId so navigating between
 * principals re-fetches; refetchInterval=15s keeps the feed
 * roughly-fresh without hammering. Three states:
 *   - loading: skeleton-style placeholder
 *   - empty: friendly "no recent activity" prompt
 *   - has-entries: list of (verb, type, time, excerpt)
 */
interface Props {
  readonly principalId: string;
  /** Bound on number of entries surfaced. Defaults to 25. */
  readonly limit?: number;
}

export function PrincipalActivity({ principalId, limit = 25 }: Props) {
  const query = useQuery({
    queryKey: ['principal-activity', principalId, limit],
    queryFn: ({ signal }) => fetchActorActivity({ principal_id: principalId, limit }, signal),
    refetchInterval: 15_000,
  });

  if (query.isPending) {
    return (
      <section className={styles.section} data-testid="principal-activity-loading">
        <h3 className={styles.heading}>Recent activity</h3>
        <div className={styles.skeleton} aria-hidden="true" />
      </section>
    );
  }

  if (query.isError) {
    /*
     * ErrorState is the canonical primitive for query failures
     * (per dev-web-state-tones equivalent). Earlier this rendered a
     * bespoke <p className={styles.error}> that drifted from the
     * shared design - a flat "Could not load activity: <message>"
     * paragraph instead of the title + monospace-detail card every
     * other view uses.
     */
    return (
      <section className={styles.section} data-testid="principal-activity-error">
        <h3 className={styles.heading}>Recent activity</h3>
        <ErrorState
          title="Failed to load activity"
          message={toErrorMessage(query.error)}
          testId="principal-activity-error-state"
        />
      </section>
    );
  }

  /*
   * The server groups consecutive runs by principal but a per-principal
   * filtered query collapses every entry into one principal-keyed
   * group. Just flatten the entries and render the timeline.
   */
  const entries: ReadonlyArray<ActorActivityEntry> = query.data?.groups.flatMap((g) => g.entries) ?? [];

  if (entries.length === 0) {
    return (
      <section className={styles.section} data-testid="principal-activity-empty">
        <h3 className={styles.heading}>Recent activity</h3>
        <p className={styles.empty}>
          No recent atoms authored by <code>{principalId}</code>. Activity appears here when this principal
          writes plans, decisions, or observations.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.section} data-testid="principal-activity-content">
      <h3 className={styles.heading}>
        Recent activity <span className={styles.count}>({entries.length})</span>
      </h3>
      <ul className={styles.list} data-testid="principal-activity-list">
        {entries.map((entry) => (
          <li key={entry.id} className={styles.item} data-testid="principal-activity-item">
            <button
              type="button"
              className={styles.entryButton}
              onClick={() => {
                const route = routeForAtomId(entry.id);
                setRoute(route, entry.id);
              }}
              data-atom-id={entry.id}
              data-atom-type={entry.type}
            >
              <div className={styles.entryHeader}>
                <span className={styles.verb}>{entry.verb}</span>
                <span className={styles.type}>{entry.type}</span>
                <time className={styles.time} dateTime={entry.created_at}>
                  {formatRelativeTime(entry.created_at)}
                </time>
              </div>
              <p className={styles.excerpt}>{entry.excerpt}</p>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Compact relative-time formatter. Avoids pulling in date-fns since
 * we render only seconds/minutes/hours/days; anything older renders
 * as the absolute date so the operator sees explicit context for
 * old atoms instead of "47d ago" which loses precision.
 */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const deltaMs = Date.now() - ts;
  const absMs = Math.abs(deltaMs);
  if (absMs < 60_000) return 'just now';
  const min = Math.round(absMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(absMs / 3_600_000);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(absMs / 86_400_000);
  if (day < 14) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
