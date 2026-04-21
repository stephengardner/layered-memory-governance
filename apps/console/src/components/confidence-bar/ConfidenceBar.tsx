import styles from './ConfidenceBar.module.css';

interface Props {
  readonly value: number;
  readonly compact?: boolean;
}

/**
 * Tiny visual meter for a 0–1 confidence number. Replaces the bare
 * `CONF 1.00` text that was scattered across cards. Bar fill color
 * shifts with value: <0.5 danger, <0.75 warning, ≥0.75 accent — so a
 * quick glance at a grid of cards surfaces weak atoms without having
 * to read each number.
 */
export function ConfidenceBar({ value, compact = false }: Props) {
  const clamped = Math.max(0, Math.min(1, value));
  const tone = clamped < 0.5 ? 'danger' : clamped < 0.75 ? 'warning' : 'accent';
  const pct = Math.round(clamped * 100);
  return (
    <span
      className={`${styles.wrap} ${compact ? styles.compact : ''}`}
      data-testid="confidence-bar"
      title={`Confidence ${value.toFixed(2)}`}
    >
      <span className={styles.bar} aria-hidden="true">
        <span
          className={styles.fill}
          data-tone={tone}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={styles.value}>{value.toFixed(2)}</span>
    </span>
  );
}
