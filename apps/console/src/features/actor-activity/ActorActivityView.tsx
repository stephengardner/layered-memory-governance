import { useQuery } from '@tanstack/react-query';
import { Radio } from 'lucide-react';
import {
  fetchActorActivity,
  type ActorActivityEntry,
  type ActorActivityGroup,
  type ActorActivityResponse,
} from '@/services/actor-activity.service';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import { routeForAtomId, routeHref, setRoute } from '@/state/router.store';
import styles from './ActorActivityView.module.css';

/*
 * Actor Activity Stream
 *
 * Read-only "control tower" feed: which principals are currently
 * writing atoms, what they're doing, and what artifacts they're
 * producing. Groups consecutive runs by principal so the timeline
 * reads as "X did A, B, C; then Y took over" rather than a flat type
 * stream.
 *
 * Auto-refresh every 5s via TanStack refetchInterval; the wire shape
 * is forward-compatible with SSE so v2 can swap to push without the
 * component changing.
 *
 * Token discipline: every visual hue resolves to a semantic token in
 * src/tokens/tokens.css. No hardcoded hex; styling lives in the CSS
 * module (tokens-only per dev-web-no-hardcoded-px-or-hex).
 */

const REFRESH_INTERVAL_MS = 5_000;

export function ActorActivityView() {
  const query = useQuery({
    queryKey: ['actor-activity', 100],
    queryFn: ({ signal }) => fetchActorActivity({ limit: 100 }, signal),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  return (
    <section className={styles.view} data-testid="actor-activity-view">
      {query.isPending && (
        <LoadingState label="Loading actor activity…" testId="actor-activity-loading" />
      )}
      {query.isError && (
        <ErrorState
          title="Could not load actor activity"
          message={(query.error as Error).message}
          testId="actor-activity-error"
        />
      )}
      {query.isSuccess && (query.data.entry_count === 0 ? (
        <EmptyState
          title="No actor activity yet"
          detail="The atom store is empty for the current window. As actors write atoms, they will appear here grouped by principal."
          testId="actor-activity-empty"
        />
      ) : (
        <ActivityFeed data={query.data} fetching={query.isFetching} />
      ))}
    </section>
  );
}

function ActivityFeed({ data, fetching }: { data: ActorActivityResponse; fetching: boolean }) {
  return (
    <>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <Radio
            size={18}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`${styles.liveDot} ${fetching ? styles.liveDotPulse : ''}`}
          />
          <h2 className={styles.title}>Actor Activity</h2>
          <span className={styles.live} data-testid="actor-activity-live">
            <span className={styles.liveLabel}>LIVE</span>
            <span className={styles.refreshHint}>refresh 5s</span>
          </span>
        </div>
        <StatsHeader
          total={data.entry_count}
          label={`recent atom${data.entry_count === 1 ? '' : 's'}`}
          detail={`across ${data.principal_count} principal${data.principal_count === 1 ? '' : 's'}`}
        />
      </header>
      <ol className={styles.feed} data-testid="actor-activity-feed">
        {data.groups.map((g) => (
          <PrincipalChunk key={g.key} group={g} />
        ))}
      </ol>
    </>
  );
}

function PrincipalChunk({ group }: { group: ActorActivityGroup }) {
  return (
    <li
      className={styles.chunk}
      data-testid="actor-activity-chunk"
      data-principal-id={group.principal_id}
    >
      <div className={styles.chunkHeader}>
        <a
          className={styles.principalPill}
          href={routeHref('principals', group.principal_id)}
          data-testid="actor-activity-principal-pill"
          data-principal-id={group.principal_id}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute('principals', group.principal_id);
          }}
        >
          <span className={styles.principalDot} aria-hidden="true" />
          <span className={styles.principalName}>{group.principal_id}</span>
        </a>
        <span className={styles.chunkCount}>
          {group.entries.length} atom{group.entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <ol className={styles.entries}>
        {group.entries.map((entry) => (
          <ActivityEntry key={entry.id} entry={entry} />
        ))}
      </ol>
    </li>
  );
}

function ActivityEntry({ entry }: { entry: ActorActivityEntry }) {
  const target = routeForAtomId(entry.id);
  return (
    <li
      className={styles.entry}
      data-testid="actor-activity-entry"
      data-atom-id={entry.id}
      data-atom-type={entry.type}
    >
      <span className={styles.entryDot} aria-hidden="true" />
      <div className={styles.entryHead}>
        <span className={styles.entryVerb}>{entry.verb}</span>
        <a
          className={styles.entryAtomLink}
          href={routeHref(target, entry.id)}
          data-testid="actor-activity-atom-link"
          data-atom-ref-id={entry.id}
          data-atom-ref-target={target}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute(target, entry.id);
          }}
        >
          <code>{entry.id}</code>
        </a>
        <time
          className={styles.entryTime}
          dateTime={entry.created_at}
          data-testid="actor-activity-time"
        >
          {formatTime(entry.created_at)}
        </time>
      </div>
      {entry.excerpt && (
        <p className={styles.entryExcerpt}>{entry.excerpt}</p>
      )}
    </li>
  );
}

function formatTime(iso: string): string {
  // `new Date(...)` and `toLocaleTimeString()` do not throw on bad input
  // (the Date is just `Invalid Date` with NaN getTime), so the only
  // guard we need is the NaN check. Second resolution matters here
  // because the feed refreshes every 5s and minute-precision timestamps
  // collapse multiple bursts into a single visible row.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
