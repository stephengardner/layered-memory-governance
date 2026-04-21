import { useMemo } from 'react';
import { AlertOctagon, Shield, User } from 'lucide-react';
import type { Principal } from '@/services/principals.service';
import { routeHref, setRoute } from '@/state/router.store';
import styles from './PrincipalTree.module.css';

interface Props {
  readonly principals: ReadonlyArray<Principal>;
}

/**
 * Org-chart style tree of the signed_by hierarchy. Roots are
 * principals with signed_by === null; every other principal is a
 * child of the principal whose id matches its signed_by. Renders
 * recursively with connector lines drawn via CSS pseudo-elements —
 * no SVG, no external tree lib.
 *
 * Each node links to the principal's focus page at /principals/:id.
 */
export function PrincipalTree({ principals }: Props) {
  const { roots, childrenOf } = useMemo(() => buildTree(principals), [principals]);
  return (
    <div className={styles.tree} role="tree" aria-label="Principal hierarchy" data-testid="principal-tree">
      {roots.map((p) => (
        <Branch key={p.id} principal={p} childrenOf={childrenOf} depth={0} />
      ))}
    </div>
  );
}

function Branch({
  principal,
  childrenOf,
  depth,
}: {
  principal: Principal;
  childrenOf: ReadonlyMap<string, ReadonlyArray<Principal>>;
  depth: number;
}) {
  const kids = childrenOf.get(principal.id) ?? [];
  const compromised = Boolean(principal.compromised_at);
  const root = !principal.signed_by;

  return (
    <div className={styles.branch} data-depth={depth}>
      <a
        className={`${styles.node} ${compromised ? styles.nodeCompromised : ''} ${!principal.active ? styles.nodeInactive : ''}`}
        href={routeHref('principals', principal.id)}
        role="treeitem"
        data-testid="tree-node"
        data-principal-id={principal.id}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('principals', principal.id);
        }}
      >
        <span className={styles.icon}>
          {root ? <Shield size={14} strokeWidth={2} />
            : compromised ? <AlertOctagon size={14} strokeWidth={2} />
              : <User size={14} strokeWidth={1.75} />}
        </span>
        <div className={styles.body}>
          <span className={styles.name}>{principal.name ?? principal.id}</span>
          <span className={styles.meta}>{principal.role}{root ? ' · root' : ''}</span>
        </div>
      </a>
      {kids.length > 0 && (
        <div className={styles.children}>
          {kids.map((k) => (
            <Branch key={k.id} principal={k} childrenOf={childrenOf} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function buildTree(principals: ReadonlyArray<Principal>): {
  roots: ReadonlyArray<Principal>;
  childrenOf: ReadonlyMap<string, ReadonlyArray<Principal>>;
} {
  const roots: Principal[] = [];
  const by = new Map<string, Principal[]>();
  for (const p of principals) {
    if (!p.signed_by) {
      roots.push(p);
    } else {
      const bucket = by.get(p.signed_by);
      if (bucket) bucket.push(p);
      else by.set(p.signed_by, [p]);
    }
  }
  for (const bucket of by.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  roots.sort((a, b) => a.id.localeCompare(b.id));
  return { roots, childrenOf: by };
}
