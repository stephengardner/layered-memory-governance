import { useEffect, useState } from 'react';
import styles from './TimeAgo.module.css';

interface Props {
  readonly iso: string;
  readonly prefix?: string;
}

/**
 * Compact relative-time display with a title-tooltip carrying the
 * exact timestamp. Re-renders every minute so "3m ago" doesn't stay
 * frozen while the page is open for hours.
 *
 * Format ladder (approximate human scan):
 *   <45s       → "just now"
 *   <90s       → "1m"
 *   <60m       → "Nm"
 *   <24h       → "Nh"
 *   <7d        → "Nd"
 *   else       → "Mon DD"  (monthly scan) or "Mon YYYY" if past year
 */
export function TimeAgo({ iso, prefix }: Props) {
  // Tick once a minute to keep the relative label fresh.
  const [, force] = useState(0);
  useEffect(() => {
    const i = setInterval(() => force((x) => x + 1), 60_000);
    return () => clearInterval(i);
  }, []);

  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return <span className={styles.time}>{iso}</span>;

  const full = formatFull(new Date(ts));
  const rel = formatRelative(ts);
  return (
    <time className={styles.time} dateTime={iso} title={full}>
      {prefix ? `${prefix} ` : ''}{rel}
    </time>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'in the future';
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1m ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const dt = new Date(ts);
  const now = new Date();
  if (dt.getFullYear() === now.getFullYear()) {
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return dt.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function formatFull(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
