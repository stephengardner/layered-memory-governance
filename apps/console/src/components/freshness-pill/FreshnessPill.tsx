import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import styles from './FreshnessPill.module.css';

/**
 * Live freshness indicator for a polled surface.
 *
 * Source: a client-side timestamp that the parent updates whenever a
 * successful poll completes. The pill renders a dot + relative phrase
 * ("Updated 5s ago"), recomputed on a 1s ticker so the operator sees
 * the surface aging in real time. After
 * `STALE_THRESHOLD_MS` (15s) without a successful poll, the pill
 * crosses to the warning token style and switches the copy to
 * "Stale - last update Ns ago" (using a regular hyphen-minus, not an
 * em/en dash, per the canon `inv-no-private-terms` package-hygiene
 * lint).
 *
 * On a hard poll failure we keep ticking against the last good
 * timestamp rather than silently retrying with no signal, per the
 * spec's "never silently retry" requirement.
 *
 * Mobile: the pill ships a coarse-pointer touch-target floor of 44px
 * per `dev-web-mobile-first-required`.
 */

const STALE_THRESHOLD_MS = 15_000;

interface FreshnessPillProps {
  /**
   * Last successful poll completion timestamp in ms (Date.now() shape).
   * `null` is rendered as "waiting for first poll" so a freshly loaded
   * page never claims stale before the first request returns.
   */
  readonly lastSuccessAt: number | null;
  /** Test-id forwarded to the root element. */
  readonly testId?: string;
}

export function FreshnessPill({ lastSuccessAt, testId }: FreshnessPillProps) {
  /*
   * `now` ticks once per second so the relative phrase recomputes
   * without re-rendering the parent. The interval clears on unmount
   * so detail-view tab teardown doesn't leak.
   */
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (lastSuccessAt === null) {
    return (
      <span
        className={styles.pill}
        data-state="waiting"
        data-testid={testId}
      >
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.label}>Waiting for first update</span>
      </span>
    );
  }

  const ageMs = Math.max(0, now - lastSuccessAt);
  const ageSeconds = Math.floor(ageMs / 1000);
  const stale = ageMs > STALE_THRESHOLD_MS;
  const label = stale
    ? `Stale - last update ${formatAge(ageSeconds)} ago`
    : `Updated ${formatAge(ageSeconds)} ago`;

  return (
    <motion.span
      className={styles.pill}
      data-state={stale ? 'stale' : 'fresh'}
      data-testid={testId}
      /*
       * Color cross-fade on the fresh -> stale transition. animate
       * keys on data-state via layout id changes so framer drives
       * the opacity bridge instead of a CSS transition that would
       * jank when the dot color flips.
       */
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
    >
      <motion.span
        className={styles.dot}
        aria-hidden="true"
        data-state={stale ? 'stale' : 'fresh'}
        animate={{ scale: stale ? 1 : [1, 1.18, 1] }}
        transition={{
          duration: stale ? 0 : 1.6,
          repeat: stale ? 0 : Infinity,
          ease: 'easeInOut',
        }}
      />
      <span className={styles.label}>{label}</span>
    </motion.span>
  );
}

/**
 * Compact relative-age formatter: "0s", "59s", "2m 03s", "1h 02m".
 * Mirrors the `formatRelative` shape in PipelinesView.tsx but without
 * the absolute-fallback case (this surface is always "now-ish").
 */
function formatAge(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m`;
}
