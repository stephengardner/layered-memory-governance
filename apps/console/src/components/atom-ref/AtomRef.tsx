import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { getAtomById } from '@/services/atoms.service';
import {
  AtomHoverCard,
  AtomHoverCardLoading,
  AtomHoverCardNotFound,
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
 *   - resolved (any layer) -> AtomHoverCard with real metadata
 *   - query pending         -> AtomHoverCardLoading with skeleton metadata
 *   - settled null          -> AtomHoverCardNotFound (id + message only;
 *                              no metadata strip, so no placeholder
 *                              principal / confidence / created_at
 *                              can be read as ground truth)
 *
 * The resolver calls `getAtomById` (which hits `/api/atoms.get`) so
 * the hover-card surfaces full envelope for ANY layer (L0 plans,
 * observations, agent-sessions, pipeline outputs, dispatch records,
 * etc.) -- not just L3 canon. Operators previously saw a useless
 * 'Atom not in canon' placeholder for the majority of atoms in the
 * substrate; this routes to the real data instead. The "not found"
 * branch is reserved for the genuinely unreachable case where the
 * backend cannot find the id at all (atom-not-found 404).
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
  // hovers are instant. getAtomById hits /api/atoms.get which
  // returns AnyAtom for any layer (not just L3 canon); the resolver
  // returns null on the substrate's atom-not-found 404 so the
  // not-found branch is reached only when the id genuinely does not
  // resolve.
  const query = useQuery({
    queryKey: ['atoms.get', id],
    queryFn: ({ signal }) => getAtomById(id, signal),
    enabled: hover.open,
    staleTime: 60_000,
  });
  const match = query.data ?? undefined;

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
            <AtomHoverCardNotFound
              id={id}
              message="Atom not found in the substrate. It may have been reaped, never written, or the id is malformed."
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
