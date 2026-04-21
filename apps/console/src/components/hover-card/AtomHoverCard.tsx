import type { CanonAtom } from '@/services/canon.service';
import { TimeAgo } from '@/components/time-ago/TimeAgo';
import styles from './AtomHoverCard.module.css';

/**
 * Shared visual for every atom-hover tooltip across the app (graph
 * nodes, timeline dots, inline atom-refs in plan bodies). One card,
 * one set of styles, one visual language.
 *
 * Rendered via portal by the consuming hover controller so z-index
 * and positioning are consumer concerns. This component is pure
 * presentational — no mouseenter / mouseleave logic lives here.
 */
export function AtomHoverCard({
  atom,
  hint,
  onPointerEnter,
  onPointerLeave,
}: {
  atom: Pick<CanonAtom, 'id' | 'type' | 'layer' | 'content' | 'principal_id' | 'confidence' | 'created_at'>;
  hint?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div
      className={styles.card}
      role="tooltip"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className={styles.head}>
        <span className={styles.type} data-type={atom.type}>{atom.type}</span>
        <code className={styles.id}>{atom.id}</code>
      </div>
      <p className={styles.content}>{truncate(atom.content, 240)}</p>
      <div className={styles.meta}>
        <span>by {atom.principal_id}</span>
        <span className={styles.dot} aria-hidden="true">·</span>
        <span>layer {atom.layer}</span>
        <span className={styles.dot} aria-hidden="true">·</span>
        <span>conf {atom.confidence.toFixed(2)}</span>
        <span className={styles.dot} aria-hidden="true">·</span>
        <TimeAgo iso={atom.created_at} />
      </div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
