import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { listCanonAtoms, type CanonAtom } from '@/services/canon.service';
import { AtomHoverCard, AtomHoverCardLoading } from '@/components/hover-card/AtomHoverCard';
import { useHoverCard } from '@/components/hover-card/useHoverCard';
import { routeForAtomId, routeHref, setRoute, type Route } from '@/state/router.store';
import styles from './AtomRef.module.css';

interface Props {
  readonly id: string;
  readonly variant?: 'inline' | 'chip';
}

/**
 * Clickable reference to another atom. Shares the same hover-card
 * visual with the graph and timeline views (one tooltip, one visual
 * language) and the same stay-open hover model — move the cursor
 * from the ref onto the tooltip and it persists.
 *
 * Hover-card render branches three ways so the metadata strip never
 * shows fabricated values:
 *   - resolved match  → <AtomHoverCard atom={match}>
 *   - query pending   → <AtomHoverCardLoading id={id}> (skeleton meta)
 *   - settled empty   → <AtomHoverCard atom={notInCanonFallback}>
 *     (legitimate "this id resolves to a plan / observation / non-canon
 *     atom" sentinel — only after we know the query terminated empty)
 */
export function AtomRef({ id, variant = 'chip' }: Props) {
  const target: Route = routeForAtomId(id);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  // The hover state itself does not need to carry the atom payload —
  // we derive the rendered card from `match` + `query.isPending` below.
  // Parameterized as <void> so useHoverCard's API is preserved without
  // a fabricated atom flowing through `hover.show`.
  const hover = useHoverCard<void>();

  // Fetch only while hovering — TanStack caches per-id so repeat
  // hovers are instant.
  const query = useQuery({
    queryKey: ['canon.list-search', id],
    queryFn: ({ signal }) => listCanonAtoms({ search: id }, signal),
    enabled: hover.open,
    staleTime: 60_000,
  });
  const match = (query.data ?? []).find((a) => a.id === id) as CanonAtom | undefined;

  /*
   * Sentinel for the genuine "atom not in canon" terminal state — used
   * ONLY after the query has settled with no match. Until then we
   * render <AtomHoverCardLoading> so no fabricated principal /
   * confidence / created_at is ever shown to the user.
   */
  const notInCanonFallback: CanonAtom = {
    id,
    type: 'reference',
    layer: 'L3',
    content: 'Atom not in canon (may be a plan or observation)',
    principal_id: '—',
    confidence: 0,
    created_at: new Date().toISOString(),
  };

  return (
    <>
      <a
        ref={anchorRef}
        className={variant === 'chip' ? styles.chip : styles.inline}
        href={routeHref(target, id)}
        data-testid="atom-ref"
        data-atom-ref-id={id}
        data-atom-ref-target={target}
        onClick={(e) => {
          if (e.defaultPrevented) return;
          if (e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          hover.close();
          setRoute(target, id);
        }}
        onMouseEnter={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          // Position the card just below the ref, not at cursor, so
          // it's predictable and doesn't jitter as the pointer moves
          // across the anchor's baseline underline.
          hover.show(undefined, rect.left, rect.bottom + 4);
        }}
        onMouseLeave={hover.scheduleHide}
        onFocus={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          hover.show(undefined, rect.left, rect.bottom + 4);
        }}
        onBlur={hover.scheduleHide}
        title={`Open ${id} in ${target}`}
      >
        {id}
      </a>
      {hover.open && hover.pos && createPortal(
        <div
          className={styles.hoverWrap}
          style={{
            top: Math.min(hover.pos.y, window.innerHeight - 220),
            left: Math.max(12, Math.min(hover.pos.x, window.innerWidth - 380)),
          }}
        >
          {match ? (
            <AtomHoverCard
              atom={match}
              hint={`click · open in ${target}`}
              onPointerEnter={hover.cancelHide}
              onPointerLeave={hover.scheduleHide}
            />
          ) : query.isPending ? (
            <AtomHoverCardLoading
              id={id}
              hint={`click · open in ${target}`}
              onPointerEnter={hover.cancelHide}
              onPointerLeave={hover.scheduleHide}
            />
          ) : (
            <AtomHoverCard
              atom={notInCanonFallback}
              hint={`click · open in ${target}`}
              onPointerEnter={hover.cancelHide}
              onPointerLeave={hover.scheduleHide}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
