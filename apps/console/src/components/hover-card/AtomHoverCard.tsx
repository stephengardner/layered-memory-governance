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
      data-testid="atom-hover-card"
      data-loading="false"
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

/**
 * Loading variant — same outer shell + id chip as <AtomHoverCard>, but
 * the metadata strip (principal / layer / confidence / age) is replaced
 * by skeleton bars rather than fabricated zero-values. Used while the
 * atom is being fetched so the user sees the id they hovered without a
 * "wrong-atom flashed first" transition when real data swaps in.
 *
 * Once the query resolves, the consumer renders <AtomHoverCard> with
 * real data; the id and outer shape stay visually anchored across the
 * swap. No fabricated principal_id / confidence / created_at appears
 * at any point.
 */
export function AtomHoverCardLoading({
  id,
  hint,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  hint?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div
      className={styles.card}
      role="tooltip"
      aria-busy="true"
      data-testid="atom-hover-card"
      data-loading="true"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className={styles.head}>
        <span className={styles.skeletonChip} aria-hidden="true" />
        <code className={styles.id}>{id}</code>
      </div>
      <div className={styles.skeletonContent} aria-hidden="true">
        <span className={styles.skeletonLine} />
        <span className={styles.skeletonLineShort} />
      </div>
      <div className={styles.meta} role="status" aria-label="loading atom metadata">
        <span className={styles.skeletonMeta} aria-hidden="true" />
        <span className={styles.skeletonMetaShort} aria-hidden="true" />
      </div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

/*
 * Not-in-canon variant: rendered only after the canon-search query has
 * settled with no match, signalling that the atom-id resolves to a
 * non-canon artifact (a plan, observation, agent-session, etc.) rather
 * than a canon atom. Drops the metadata strip entirely so we never
 * paint placeholder principal / confidence / layer / created_at values
 * the user could read as ground truth. The id chip and explanatory
 * content carry all the information that's actually available.
 */
export function AtomHoverCardNotInCanon({
  id,
  message,
  hint,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  message: string;
  hint?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div
      className={styles.card}
      role="tooltip"
      data-testid="atom-hover-card"
      data-loading="false"
      data-not-in-canon="true"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className={styles.head}>
        <span className={styles.type} data-type="non-canon">non-canon</span>
        <code className={styles.id}>{id}</code>
      </div>
      <p className={styles.content}>{truncate(message, 240)}</p>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
