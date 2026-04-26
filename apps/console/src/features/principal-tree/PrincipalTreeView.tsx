import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, Shield, User, Bot, AlertOctagon, AlertTriangle } from 'lucide-react';
import {
  getPrincipalsTree,
  type PrincipalTreeNode,
} from '@/services/principals.service';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import styles from './PrincipalTreeView.module.css';

/**
 * Principal Hierarchy view.
 *
 * Renders the signed_by chain as an indented, collapsible tree. Each
 * node shows the principal id, role, depth, and (when relevant) a
 * taint badge ('compromised' for self, 'inherited' for descendants
 * of a compromised ancestor).
 *
 * Why a dedicated view alongside /principals:
 *   - /principals answers "who is in this org?". The grid + flat
 *     tree-tab there is correct for that question.
 *   - /hierarchy answers "if compromise X happens, what is the blast
 *     radius?". That demands collapse-to-summary, depth indicators,
 *     and inherited-taint visibility -- a different rendering than a
 *     directory listing.
 *
 * The nested tree shape is computed server-side (POST
 * /api/principals.tree). The client recurses without normalising;
 * cycle detection happens once on the server with a clear error if
 * the principal store has a back-edge.
 *
 * Read-only by design: clicking a leaf surfaces a visual selection
 * (and could later filter the activity feed); no mutations from this
 * view, ever.
 */
export function PrincipalTreeView() {
  const query = useQuery({
    queryKey: ['principals', 'tree'],
    queryFn: ({ signal }) => getPrincipalsTree(signal),
  });
  // Selected leaf id (visual indication only in v1; would later wire
  // a filter to ActivitiesView). Lives at view scope rather than in
  // the router so the indication doesn't survive a route change.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (!query.data) return null;
    let total = 0;
    let compromised = 0;
    let inherited = 0;
    let maxDepth = 0;
    const walk = (n: PrincipalTreeNode) => {
      total += 1;
      if (n.taint_state === 'compromised') compromised += 1;
      if (n.taint_state === 'inherited') inherited += 1;
      if (n.depth > maxDepth) maxDepth = n.depth;
      for (const c of n.children) walk(c);
    };
    for (const r of query.data.roots) walk(r);
    return { total, compromised, inherited, maxDepth };
  }, [query.data]);

  return (
    <section className={styles.view}>
      {query.isPending && (
        <LoadingState label="Loading principal hierarchy..." testId="principal-tree-loading" />
      )}
      {query.isError && (
        <ErrorState
          title="Could not load hierarchy"
          message={(query.error as Error).message}
          testId="principal-tree-error"
        />
      )}
      {query.isSuccess && query.data.roots.length === 0 && (
        <EmptyState
          title="No principals yet"
          detail="The signed-by tree is empty until at least one principal is registered in .lag/principals/."
          testId="principal-tree-empty"
        />
      )}
      {query.isSuccess && summary && query.data.roots.length > 0 && (
        <>
          <header className={styles.intro}>
            <h2 className={styles.heroTitle}>Principal Hierarchy</h2>
            <p className={styles.heroSubtitle}>
              The signed-by chain IS the trust model. Compromise of an upstream principal
              taints every descendant -- this view shows the cascade visually so blast
              radius is one glance, not one query.
            </p>
          </header>
          <StatsHeader
            total={summary.total}
            label={`principal${summary.total === 1 ? '' : 's'}`}
            detail={`max depth ${summary.maxDepth}, ${summary.compromised} compromised, ${summary.inherited} inherited`}
          />
          {query.data.orphans.length > 0 && (
            <div className={styles.orphanWarn} data-testid="principal-tree-orphans">
              <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
              <span>
                {query.data.orphans.length} orphan principal{query.data.orphans.length === 1 ? '' : 's'} (signed_by points at a missing id):{' '}
                <code>{query.data.orphans.join(', ')}</code>
              </span>
            </div>
          )}
          <div
            className={styles.tree}
            role="tree"
            aria-label="Principal hierarchy"
            data-testid="principal-tree"
          >
            {query.data.roots.map((root) => (
              <TreeBranch
                key={root.id}
                node={root}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function TreeBranch({
  node,
  selectedId,
  onSelect,
}: {
  node: PrincipalTreeNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const hasChildren = node.children.length > 0;
  // Default-expanded: roots and depth-1 nodes are open, deeper levels
  // start collapsed so an org-scale tree (50+ principals) lands
  // skimmable rather than wall-of-text on first paint.
  const [open, setOpen] = useState(node.depth <= 1);
  const isLeaf = !hasChildren;
  const selected = selectedId === node.id;

  return (
    <div className={styles.branch} role="none" data-depth={node.depth}>
      <div
        className={[
          styles.row,
          node.taint_state === 'compromised' ? styles.rowCompromised : '',
          node.taint_state === 'inherited' ? styles.rowInherited : '',
          !node.active ? styles.rowInactive : '',
          selected ? styles.rowSelected : '',
        ].filter(Boolean).join(' ')}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={selected || undefined}
        data-testid="principal-tree-node"
        data-principal-id={node.id}
        data-depth={node.depth}
        data-taint-state={node.taint_state}
        data-kind={node.kind}
      >
        {hasChildren ? (
          <button
            type="button"
            className={styles.chevron}
            aria-label={open ? `Collapse ${node.id}` : `Expand ${node.id}`}
            data-testid="principal-tree-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            <motion.span
              animate={{ rotate: open ? 90 : 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              className={styles.chevronInner}
            >
              <ChevronRight size={14} strokeWidth={2} />
            </motion.span>
          </button>
        ) : (
          <span className={styles.chevronSpacer} aria-hidden="true" />
        )}
        <button
          type="button"
          className={styles.bodyButton}
          onClick={() => {
            // Leaf: select / toggle selection. Branch: clicking the
            // body also toggles open so the whole row is interactive.
            if (isLeaf) {
              onSelect(selected ? null : node.id);
            } else {
              setOpen((v) => !v);
            }
          }}
          data-testid="principal-tree-row-body"
        >
          <span className={styles.icon} aria-hidden="true">
            <KindIcon kind={node.kind} />
          </span>
          <div className={styles.body}>
            <div className={styles.headRow}>
              <span className={styles.name}>{node.name}</span>
              <span className={styles.id}>{node.id}</span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.role}>{node.role}</span>
              <span className={styles.dot} aria-hidden="true">|</span>
              <span
                className={styles.depthBadge}
                data-testid="principal-tree-depth"
                aria-label={`depth ${node.depth}`}
              >
                depth {node.depth}
              </span>
              {node.taint_state !== 'clean' && (
                <span
                  className={`${styles.taintBadge} ${node.taint_state === 'compromised' ? styles.taintCompromised : styles.taintInherited}`}
                  data-testid="principal-tree-taint-badge"
                  data-taint-state={node.taint_state}
                  aria-label={`taint ${node.taint_state}`}
                >
                  <AlertOctagon size={11} strokeWidth={2.5} aria-hidden="true" />
                  {node.taint_state}
                </span>
              )}
              {!node.active && (
                <span className={styles.inactiveBadge} aria-label="inactive">
                  inactive
                </span>
              )}
            </div>
          </div>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {hasChildren && open && (
          <motion.div
            key="children"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className={styles.children}
            role="group"
          >
            {node.children.map((child) => (
              <TreeBranch
                key={child.id}
                node={child}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function KindIcon({ kind }: { kind: PrincipalTreeNode['kind'] }) {
  switch (kind) {
    case 'root': return <Shield size={14} strokeWidth={2} />;
    case 'human': return <User size={14} strokeWidth={1.75} />;
    case 'agent': return <Bot size={14} strokeWidth={1.75} />;
    default: return <User size={14} strokeWidth={1.75} />;
  }
}
