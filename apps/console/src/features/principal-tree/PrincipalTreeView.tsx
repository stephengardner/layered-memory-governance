import { useCallback, useMemo, useState } from 'react';
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

  // Open-state lives at the view level, keyed by node id, so an
  // ancestor collapse-then-expand cycle does NOT lose deeper open
  // state -- AnimatePresence unmounts the children container on exit
  // and a component-local `useState` initialiser would re-seed every
  // time the branch remounts. The Set survives child unmounts because
  // it lives above AnimatePresence. Default-seeded lazily per node
  // (`open` is computed from `node.depth <= 1` only when the node is
  // first encountered); subsequent toggles are explicit.
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [explicitlyToggled, setExplicitlyToggled] = useState<ReadonlySet<string>>(() => new Set<string>());
  const isOpen = useCallback(
    (node: PrincipalTreeNode) => {
      if (explicitlyToggled.has(node.id)) return openIds.has(node.id);
      // Default seed: roots and depth-1 are open so an org-scale tree
      // (50+ principals) lands skimmable rather than wall-of-text on
      // first paint.
      return node.depth <= 1;
    },
    [openIds, explicitlyToggled],
  );
  const toggleOpen = useCallback(
    (node: PrincipalTreeNode) => {
      const currentlyOpen = explicitlyToggled.has(node.id)
        ? openIds.has(node.id)
        : node.depth <= 1;
      const nextOpen = !currentlyOpen;
      setOpenIds((prev) => {
        const next = new Set(prev);
        if (nextOpen) next.add(node.id);
        else next.delete(node.id);
        return next;
      });
      setExplicitlyToggled((prev) => {
        if (prev.has(node.id)) return prev;
        const next = new Set(prev);
        next.add(node.id);
        return next;
      });
    },
    [openIds, explicitlyToggled],
  );

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
          message={query.error instanceof Error ? query.error.message : String(query.error)}
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
          {/*
           * role="tree" was removed deliberately. The WAI-ARIA APG
           * tree pattern mandates roving tabindex + arrow-key
           * navigation + Home/End + typeahead. We don't implement
           * those today; advertising role="tree" with only Tab-based
           * navigation creates a spec-implementation mismatch for
           * AT users. role="list" matches our actual semantics
           * (linear, Tab-stop per node) and removes the contract
           * gap. Full keyboard-tree support is a follow-up: when
           * we add it, restore role="tree" + role="treeitem" +
           * aria-expanded together. aria-expanded now lives on the
           * chevron toggle button where the interactive state owner
           * actually is.
           */}
          <div
            className={styles.tree}
            role="list"
            aria-label="Principal hierarchy"
            data-testid="principal-tree"
          >
            {query.data.roots.map((root) => (
              <TreeBranch
                key={root.id}
                node={root}
                selectedId={selectedId}
                onSelect={setSelectedId}
                isOpen={isOpen}
                onToggleOpen={toggleOpen}
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
  isOpen,
  onToggleOpen,
}: {
  node: PrincipalTreeNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  isOpen: (node: PrincipalTreeNode) => boolean;
  onToggleOpen: (node: PrincipalTreeNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const open = isOpen(node);
  const isLeaf = !hasChildren;
  const selected = selectedId === node.id;
  const childrenId = `principal-tree-children-${node.id}`;

  return (
    <div className={styles.branch} role="listitem" data-depth={node.depth}>
      <div
        className={[
          styles.row,
          node.taint_state === 'compromised' ? styles.rowCompromised : '',
          node.taint_state === 'inherited' ? styles.rowInherited : '',
          !node.active ? styles.rowInactive : '',
          selected ? styles.rowSelected : '',
        ].filter(Boolean).join(' ')}
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
            aria-expanded={open}
            /*
             * Only set aria-controls when the controlled element is
             * actually mounted. AnimatePresence unmounts the children
             * container on collapse, and a dangling aria-controls
             * pointer to a non-existent id is silently dropped by some
             * AT (NVDA, JAWS) and tripped by axe. Emitting it
             * conditionally keeps the relationship valid in both
             * states.
             */
            aria-controls={open ? childrenId : undefined}
            data-testid="principal-tree-toggle"
            onClick={() => onToggleOpen(node)}
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
          /*
           * The body row is the larger click target operators hit most
           * often, so on branches it MUST carry the same disclosure
           * semantics as the chevron button. AT users otherwise hear
           * "button" with no expansion state even though clicking it
           * toggles the children container. aria-controls is mirrored
           * conditionally for the same reason as the chevron above
           * (children container only mounts when open).
           */
          aria-expanded={hasChildren ? open : undefined}
          aria-controls={hasChildren && open ? childrenId : undefined}
          onClick={() => {
            // Leaf: select / toggle selection. Branch: clicking the
            // body also toggles open so the whole row is interactive.
            if (isLeaf) {
              onSelect(selected ? null : node.id);
            } else {
              onToggleOpen(node);
            }
          }}
          data-testid="principal-tree-row-body"
        >
          {/*
           * Inner content uses spans (phrasing content) rather than
           * divs because <button> only accepts phrasing content per
           * HTML5; nesting a <div> emits React hydration warnings and
           * trips a11y validators. CSS modules drive the same layout
           * via display:flex on .body / .headRow / .metaRow so the
           * span-vs-div swap is visually invisible.
           */}
          <span className={styles.icon} aria-hidden="true">
            <KindIcon kind={node.kind} />
          </span>
          <span className={styles.body}>
            <span className={styles.headRow}>
              <span className={styles.name}>{node.name}</span>
              <span className={styles.id}>{node.id}</span>
            </span>
            <span className={styles.metaRow}>
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
            </span>
          </span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {hasChildren && open && (
          <motion.div
            key="children"
            id={childrenId}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className={styles.children}
            role="list"
          >
            {node.children.map((child) => (
              <TreeBranch
                key={child.id}
                node={child}
                selectedId={selectedId}
                onSelect={onSelect}
                isOpen={isOpen}
                onToggleOpen={onToggleOpen}
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
