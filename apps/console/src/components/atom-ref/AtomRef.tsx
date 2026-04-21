import { routeForAtomId, routeHref, setRoute, type Route } from '@/state/router.store';
import styles from './AtomRef.module.css';

interface Props {
  readonly id: string;
  readonly variant?: 'inline' | 'chip';
}

/**
 * Clickable reference to another atom by id. The link's target view
 * is inferred from the atom-id prefix (plan-* → Plans, op-action-* /
 * ama-* / pr-observation-* → Activities, everything else → Canon),
 * so a plan reference lands in the Plans view with the plan expanded
 * instead of hitting a canon empty-state.
 *
 * Renders as an anchor so middle-click / Cmd+click work like any
 * other link. Left-click is intercepted and routed via pushState so
 * we don't reload the app.
 */
export function AtomRef({ id, variant = 'chip' }: Props) {
  const target: Route = routeForAtomId(id);
  return (
    <a
      className={variant === 'chip' ? styles.chip : styles.inline}
      href={routeHref(target, { focus: id })}
      data-testid="atom-ref"
      data-atom-ref-id={id}
      data-atom-ref-target={target}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        setRoute(target, { focus: id });
      }}
      title={`Open ${id} in ${target}`}
    >
      {id}
    </a>
  );
}
