import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { listCanonAtoms, type CanonAtom } from '@/services/canon.service';
import {
  AtomHoverCard,
  AtomHoverCardLoading,
  AtomHoverCardNotInCanon,
} from '@/components/hover-card/AtomHoverCard';
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
 * language) and the same stay-open hover model: move the cursor from
 * the ref onto the tooltip and it persists.
 *
 * Hover-card render branches three ways so the metadata strip never
 * shows fabricated values:
 *   - resolved match  -> AtomHoverCard with real metadata
 *   - query pending   -> AtomHoverCardLoading with skeleton metadata
 *   - settled empty   -> AtomHoverCardNotInCanon (id + message only;
 *                        no metadata strip, so no placeholder principal
 *                        / confidence / created_at can be read as
 *                        ground truth)
 */
export function AtomRef({ id, variant = 'chip' }: Props) {
  const target: Route = routeForAtomId(id);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  // The hover state itself does not need to carry the atom payload --
  // we derive the rendered card from `match` + `query.isPending` below.
  // Parameterized as <void> so useHoverCard's API is preserved without
  // a fabricated atom flowing through `hover.show`.
  const hover = useHoverCard<void>();

  // Fetch only while hovering -- TanStack caches per-id so repeat
  // hovers are instant.
  const query = useQuery({
    queryKey: ['canon.list-search', id],
    queryFn: ({ signal }) => listCanonAtoms({ search: id }, signal),
    enabled: hover.open,
    staleTime: 60_000,
  });
  const match = (query.data ?? []).find((a) => a.id === id) as CanonAtom | undefined;

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
            <AtomHoverCardNotInCanon
              id={id}
              message="Atom not in canon (may be a plan, observation, or other non-canon artifact)"
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
