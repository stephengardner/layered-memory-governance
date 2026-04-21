import type { ReactNode } from 'react';
import styles from './StatsHeader.module.css';

interface Props {
  readonly total: number | string;
  readonly label: string;
  readonly detail?: ReactNode;
}

/**
 * Oversized display-font count + lowercase label + optional meta
 * detail. Reused by every list-like view header. Keeps the big-number
 * treatment consistent and means a future tweak (animation, tabular-
 * nums, icon) lands once.
 */
export function StatsHeader({ total, label, detail }: Props) {
  return (
    <div className={styles.stats}>
      <span className={styles.total}>{total}</span>
      <span className={styles.label}>{label}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </div>
  );
}
