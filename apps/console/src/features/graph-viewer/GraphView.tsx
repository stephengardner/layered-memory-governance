import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, X } from 'lucide-react';
import { listCanonAtoms } from '@/services/canon.service';
import { listActivities } from '@/services/activities.service';
import { listPlans } from '@/services/plans.service';
import { routeForAtomId, setRoute } from '@/state/router.store';
import { LoadingState, ErrorState } from '@/components/state-display/StateDisplay';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { AtomHoverCard } from '@/components/hover-card/AtomHoverCard';
import { useHoverCard } from '@/components/hover-card/useHoverCard';
import { useGraphService } from '@/services/graph/useGraphService';
import type { GraphNode } from '@/services/graph/GraphService';
import styles from './GraphView.module.css';

const TYPE_COLORS: Record<string, string> = {
  directive: 'var(--status-danger)',
  decision: 'var(--accent)',
  preference: 'var(--status-warning)',
  reference: 'var(--status-success)',
  plan: 'var(--accent-active)',
  observation: 'var(--text-muted)',
  'actor-message': 'var(--accent-hover)',
};

const ALL_KINDS = ['directive', 'decision', 'preference', 'reference', 'plan', 'observation', 'actor-message'] as const;

/*
 * GraphView — pure presentational consumer of GraphService.
 *
 * The service owns: the atom set, the filter, the selection, the
 * force simulation, the positions, the bounds. Re-renders of THIS
 * component don't recompute any of that; they just re-read the
 * latest snapshot.
 *
 * This component owns only: pan/zoom transform, hover-card state.
 * Both are purely visual; neither affects the graph state machine.
 */
export function GraphView() {
  const canonQ = useQuery({ queryKey: ['canon', [], ''], queryFn: ({ signal }) => listCanonAtoms({}, signal) });
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: ({ signal }) => listPlans(signal) });
  const activitiesQ = useQuery({
    queryKey: ['activities', 500],
    queryFn: ({ signal }) => listActivities({ limit: 500 }, signal),
  });

  // Dedupe atoms across the three queries. Memoized on the three
  // data arrays; identity-stable when nothing changes so the service
  // signature check short-circuits.
  const atoms = useMemo(() => {
    const all = [
      ...(canonQ.data ?? []),
      ...(plansQ.data ?? []),
      ...(activitiesQ.data ?? []),
    ];
    const seen = new Map<string, typeof all[number]>();
    for (const a of all) if (!seen.has(a.id)) seen.set(a.id, a);
    return Array.from(seen.values());
  }, [canonQ.data, plansQ.data, activitiesQ.data]);

  const { snapshot, service } = useGraphService(atoms, { width: 1200, height: 800 });
  const hoverCard = useHoverCard<GraphNode>();

  // Pan/zoom transform — presentational only, doesn't belong in the
  // service. initialScale fits below 1 so the whole graph is visible
  // on first render before the auto-fit runs.
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 0.7 });
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoFitDoneRef = useRef(false);

  // Zoom-to-fit: runs once after the sim settles. Subsequent filter
  // changes don't re-run autofit; user pan/zoom is preserved.
  useEffect(() => {
    if (!snapshot.settled || autoFitDoneRef.current || !snapshot.bounds) return;
    autoFitDoneRef.current = true;
    fitToBounds(snapshot.bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.settled, snapshot.bounds]);

  const fitToBounds = (b: { minX: number; minY: number; maxX: number; maxY: number }) => {
    const bboxW = Math.max(1, b.maxX - b.minX);
    const bboxH = Math.max(1, b.maxY - b.minY);
    const pad = 80;
    const scale = Math.min(
      1.2,
      Math.max(0.3, Math.min((1200 - pad * 2) / bboxW, (800 - pad * 2) / bboxH)),
    );
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    setTransform({ x: 600 - cx * scale, y: 400 - cy * scale, scale });
  };

  const pending = canonQ.isPending || plansQ.isPending || activitiesQ.isPending;
  const error = canonQ.error ?? plansQ.error ?? activitiesQ.error;

  if (pending) return <LoadingState label="Loading graph…" testId="graph-loading" />;
  if (error) return <ErrorState title="Could not load graph" message={(error as Error).message} testId="graph-error" />;

  const isDim = (id: string) =>
    snapshot.selection.nodeId !== null
    && id !== snapshot.selection.nodeId
    && !snapshot.selection.neighbors.has(id);

  const selectedAtom = snapshot.selection.nodeId
    ? snapshot.nodes.find((n) => n.id === snapshot.selection.nodeId) ?? null
    : null;

  return (
    <section className={styles.view}>
      <header className={styles.toolbar}>
        <div>
          <div className={styles.statsTotal}>{snapshot.nodes.length}</div>
          <div className={styles.statsLabel}>
            node{snapshot.nodes.length === 1 ? '' : 's'} · {snapshot.edges.length} edge{snapshot.edges.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className={styles.filters}>
          {ALL_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.filter} ${snapshot.kinds.has(k) ? styles.filterActive : ''}`}
              onClick={() => service.toggleKind(k)}
              data-testid={`graph-filter-${k}`}
              data-active={snapshot.kinds.has(k)}
            >
              <span className={styles.filterDot} style={{ background: TYPE_COLORS[k] ?? 'var(--text-muted)' }} />
              {k}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.resetBtn}
          onClick={() => {
            service.select(null);
            autoFitDoneRef.current = false;
            if (snapshot.bounds) fitToBounds(snapshot.bounds);
          }}
          data-testid="graph-reset"
        >
          fit
        </button>
      </header>
      <div
        ref={containerRef}
        className={styles.canvas}
        onMouseDown={(e) => {
          dragging.current = { startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y, moved: false };
        }}
        onMouseMove={(e) => {
          if (!dragging.current) return;
          const dx = e.clientX - dragging.current.startX;
          const dy = e.clientY - dragging.current.startY;
          if (Math.abs(dx) + Math.abs(dy) > 4) dragging.current.moved = true;
          setTransform((t) => ({ ...t, x: dragging.current!.origX + dx, y: dragging.current!.origY + dy }));
        }}
        onMouseUp={() => {
          if (dragging.current && !dragging.current.moved) service.select(null);
          dragging.current = null;
        }}
        onMouseLeave={() => { dragging.current = null; hoverCard.scheduleHide(); }}
        onWheel={(e) => {
          const delta = -e.deltaY * 0.0015;
          setTransform((t) => ({ ...t, scale: Math.max(0.2, Math.min(4, t.scale + delta)) }));
        }}
      >
        <svg
          className={styles.svg}
          viewBox="0 0 1200 800"
          data-testid="graph-svg"
          data-settled={snapshot.settled}
          data-version={snapshot.version}
        >
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            <g className={styles.edges}>
              {snapshot.edges.map((e, i) => {
                const s = typeof e.source === 'string' ? null : e.source;
                const t = typeof e.target === 'string' ? null : e.target;
                if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null;
                const sId = s.id;
                const tId = t.id;
                const connected = snapshot.selection.nodeId !== null
                  && (sId === snapshot.selection.nodeId || tId === snapshot.selection.nodeId);
                const dim = snapshot.selection.nodeId !== null && !connected;
                return (
                  <line
                    key={i}
                    x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                    className={`${styles.edge} ${dim ? styles.edgeDim : ''} ${connected ? styles.edgeActive : ''}`}
                  />
                );
              })}
            </g>
            <g className={styles.nodes}>
              {snapshot.nodes.map((n) => (
                <g
                  key={n.id}
                  className={`${styles.node} ${isDim(n.id) ? styles.nodeDim : ''} ${n.id === snapshot.selection.nodeId ? styles.nodeSelected : ''}`}
                  transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.metaKey || e.ctrlKey) { setRoute(routeForAtomId(n.id), n.id); return; }
                    service.select(n.id);
                  }}
                  onMouseEnter={(e) => hoverCard.show(n, e.clientX, e.clientY)}
                  onMouseMove={(e) => hoverCard.updatePos(e.clientX, e.clientY)}
                  onMouseLeave={hoverCard.scheduleHide}
                  data-testid="graph-node"
                  data-node-id={n.id}
                  data-node-type={n.type}
                  data-selected={n.id === snapshot.selection.nodeId}
                >
                  <circle
                    r={n.radius}
                    style={{ fill: TYPE_COLORS[n.type] ?? 'var(--text-muted)' }}
                  />
                </g>
              ))}
            </g>
          </g>
        </svg>
        {hoverCard.open && hoverCard.data && hoverCard.pos && !dragging.current && createPortal(
          <GraphHoverPortal
            node={hoverCard.data}
            x={hoverCard.pos.x}
            y={hoverCard.pos.y}
            onEnter={hoverCard.cancelHide}
            onLeave={hoverCard.scheduleHide}
          />,
          document.body,
        )}
      </div>
      {createPortal(
        <AnimatePresence>
          {selectedAtom && (
            <GraphDetailPanel
              key={selectedAtom.id}
              node={selectedAtom}
              onClose={() => service.select(null)}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </section>
  );
}

function GraphHoverPortal({
  node,
  x,
  y,
  onEnter,
  onLeave,
}: {
  node: GraphNode;
  x: number;
  y: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const width = 360;
  const left = Math.min(x + 16, window.innerWidth - width - 12);
  const top = Math.min(y + 16, window.innerHeight - 220);
  return (
    <div
      className={styles.hoverWrap}
      style={{ top, left, width }}
      data-testid="graph-hover-card"
    >
      <AtomHoverCard
        atom={{
          id: node.id,
          type: node.type,
          layer: node.layer as 'L0' | 'L1' | 'L2' | 'L3',
          content: node.content,
          principal_id: node.principal_id,
          confidence: node.confidence,
          created_at: node.created_at,
        }}
        hint="click · focus neighborhood · ⌘-click · open full page"
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
      />
    </div>
  );
}

function GraphDetailPanel({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const route = routeForAtomId(node.id);
  return (
    <motion.aside
      className={styles.detailPanel}
      initial={{ x: '110%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '110%', opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      data-testid="graph-detail-panel"
    >
      <header className={styles.detailHead}>
        <span className={styles.detailType} data-type={node.type}>{node.type}</span>
        <button
          type="button"
          className={styles.detailClose}
          onClick={onClose}
          aria-label="Close detail panel"
          data-testid="graph-detail-close"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>
      <code className={styles.detailId}>{node.id}</code>
      <p className={styles.detailContent}>{node.content}</p>
      <dl className={styles.detailAttrs}>
        <dt>Principal</dt><dd>{node.principal_id}</dd>
        <dt>Layer</dt><dd>{node.layer}</dd>
        <dt>Confidence</dt><dd>{node.confidence.toFixed(2)}</dd>
      </dl>
      <div className={styles.detailActions}>
        <button
          type="button"
          className={styles.detailOpen}
          onClick={() => setRoute(route, node.id)}
          data-testid="graph-detail-open"
        >
          <ExternalLink size={14} strokeWidth={2} /> Open in {route}
        </button>
        <AtomRef id={node.id} variant="chip" />
      </div>
    </motion.aside>
  );
}
