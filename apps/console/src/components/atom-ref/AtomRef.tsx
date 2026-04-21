import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { listCanonAtoms, type CanonAtom } from '@/services/canon.service';
import { routeForAtomId, routeHref, setRoute, type Route } from '@/state/router.store';
import styles from './AtomRef.module.css';

interface Props {
  readonly id: string;
  readonly variant?: 'inline' | 'chip';
}

/**
 * Clickable reference to another atom by id. The link's target view
 * is inferred from the atom-id prefix.
 *
 * Hover-preview: on mouseenter we fetch the target atom (search by
 * id) and render a floating popover with the atom's type, principal,
 * and a content snippet. Reveals the reference's content without
 * navigating — big quality-of-life win when scanning a plan body
 * full of atom-refs.
 */
export function AtomRef({ id, variant = 'chip' }: Props) {
  const target: Route = routeForAtomId(id);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const [hovering, setHovering] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Fetch only while hovering — TanStack caches per-id so repeat
  // hovers are instant.
  const query = useQuery({
    queryKey: ['canon.list-search', id],
    queryFn: ({ signal }) => listCanonAtoms({ search: id }, signal),
    enabled: hovering,
    staleTime: 60_000,
  });
  const match = (query.data ?? []).find((a) => a.id === id) as CanonAtom | undefined;

  const showPreview: React.MouseEventHandler & React.FocusEventHandler = (e) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ top: rect.bottom + 8, left: Math.max(12, rect.left) });
    setHovering(true);
  };
  const hidePreview = () => { setHovering(false); setPos(null); };

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
          hidePreview();
          setRoute(target, id);
        }}
        onMouseEnter={showPreview}
        onMouseLeave={hidePreview}
        onFocus={showPreview}
        onBlur={hidePreview}
        title={`Open ${id} in ${target}`}
      >
        {id}
      </a>
      {hovering && pos && match && createPortal(
        <div className={styles.preview} style={{ top: pos.top, left: pos.left }} role="tooltip">
          <div className={styles.previewHead}>
            <span className={styles.previewType} data-type={match.type}>{match.type}</span>
            <code className={styles.previewId}>{match.id}</code>
          </div>
          <p className={styles.previewContent}>{truncate(match.content, 260)}</p>
          <div className={styles.previewFoot}>
            <span>by {match.principal_id}</span>
            <span>•</span>
            <span>layer {match.layer}</span>
            <span>•</span>
            <span>conf {match.confidence.toFixed(2)}</span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
