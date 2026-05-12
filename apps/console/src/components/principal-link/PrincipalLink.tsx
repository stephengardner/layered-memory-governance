import { routeHref, setRoute } from '@/state/router.store';
import styles from './PrincipalLink.module.css';

/**
 * Clickable reference to a principal by id. Navigates to
 * `/principals/<id>` via the SPA's pushState router so the operator
 * lands on the principal-detail focus surface (cards + skill prose
 * + recent-activity feed).
 *
 * Why a dedicated primitive rather than reusing AtomRef:
 *   - principals are NOT atoms in the substrate; they live in
 *     `.lag/principals/<id>.json` not `.lag/atoms/<id>.json`. Routing
 *     a principal id through AtomRef would mis-fire the hover card
 *     against `/api/atoms.get` which 404s for principal ids.
 *   - The detail-view surface is different: principals route to
 *     `/principals/<id>`, atoms route to a per-type bucket. Sharing
 *     one component would force a branch on shape inside every
 *     call-site.
 *
 * Two variants matching the AtomRef family:
 *   - `inline` (default): underlined dashed link for prose
 *     ("by lag-cto", "resumed by operator-principal").
 *   - `chip`: pill-style block for stat strips and chip rows.
 *
 * Click semantics match AtomRef: middle/ctrl/meta clicks open in a
 * new tab through the browser's default <a href> behaviour; primary
 * left-click is intercepted and routed through `setRoute` to keep
 * the SPA history coherent without a full reload.
 */
export interface PrincipalLinkProps {
  readonly id: string;
  readonly variant?: 'inline' | 'chip';
  readonly testId?: string;
}

export function PrincipalLink({
  id,
  variant = 'inline',
  testId = 'principal-link',
}: PrincipalLinkProps) {
  return (
    <a
      className={variant === 'chip' ? styles.chip : styles.inline}
      href={routeHref('principals', id)}
      data-testid={testId}
      data-principal-id={id}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        setRoute('principals', id);
      }}
      title={`Open principal ${id}`}
    >
      {id}
    </a>
  );
}
