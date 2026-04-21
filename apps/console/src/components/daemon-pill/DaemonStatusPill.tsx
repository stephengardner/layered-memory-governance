import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { getDaemonStatus, type DaemonStatus } from '@/services/daemon.service';
import styles from './DaemonStatusPill.module.css';

/**
 * Compact live/quiet health pill. Polls daemon.status every 20s and
 * surfaces atom count + activity-in-last-hour. The dot color shifts
 * with freshness — green if something happened in the last hour,
 * amber if in the last day, dim otherwise.
 */
export function DaemonStatusPill() {
  const query = useQuery({
    queryKey: ['daemon.status'],
    queryFn: ({ signal }) => getDaemonStatus(signal),
    refetchInterval: 20_000,
  });

  if (!query.data) {
    return (
      <span className={styles.pill} data-tone="loading" data-testid="daemon-pill">
        <span className={styles.dot} />
        <span className={styles.label}>—</span>
      </span>
    );
  }

  const { tone, label } = summarize(query.data);
  return (
    <span
      className={styles.pill}
      data-tone={tone}
      data-testid="daemon-pill"
      title={detailTitle(query.data)}
    >
      <span className={styles.dot} aria-hidden="true" />
      <Activity size={12} strokeWidth={2} className={styles.icon} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </span>
  );
}

function summarize(s: DaemonStatus): { tone: 'live' | 'warm' | 'idle'; label: string } {
  if (s.atomsInLastHour > 0) return { tone: 'live', label: `${s.atomsInLastHour}/h` };
  if (s.atomsInLastDay > 0) return { tone: 'warm', label: `${s.atomsInLastDay}/d` };
  return { tone: 'idle', label: `${s.atomCount}` };
}

function detailTitle(s: DaemonStatus): string {
  const last = s.secondsSinceLastAtom !== null ? humanSince(s.secondsSinceLastAtom) : 'never';
  return [
    `${s.atomCount} atoms total`,
    `last write ${last} ago`,
    `${s.atomsInLastHour} in last hour · ${s.atomsInLastDay} in last day`,
    `reading from ${s.lagDir}`,
  ].join('\n');
}

function humanSince(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
