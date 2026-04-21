import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

interface Props {
  readonly width?: string | number;
  readonly height?: string | number;
  readonly radius?: string;
  readonly className?: string;
}

/**
 * Low-key pulsing placeholder. Replaces bare spinners with
 * same-shape ghosts so the transition from loading → loaded is a
 * re-skin, not a pop-in — removes the mini layout shift that would
 * violate dev-web-interaction-quality-no-jank.
 */
export function Skeleton({ width, height = '1rem', radius, className }: Props) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;
  if (radius !== undefined) style.borderRadius = radius;
  return <span className={`${styles.skeleton}${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />;
}

export function SkeletonCard() {
  return (
    <div className={styles.card} aria-hidden="true">
      <div className={styles.row}>
        <Skeleton width="4rem" height="1.2rem" radius="var(--radius-sm)" />
        <Skeleton width="12rem" height="1rem" />
      </div>
      <Skeleton width="100%" height="0.8rem" />
      <Skeleton width="95%" height="0.8rem" />
      <Skeleton width="85%" height="0.8rem" />
      <div className={styles.row}>
        <Skeleton width="6rem" height="0.7rem" />
        <Skeleton width="4rem" height="0.7rem" />
        <Skeleton width="5rem" height="0.7rem" />
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className={styles.grid}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
