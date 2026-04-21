import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, X } from 'lucide-react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type Simulation } from 'd3-force';
import { listCanonAtoms, type CanonAtom } from '@/services/canon.service';
import { listActivities } from '@/services/activities.service';
import { listPlans } from '@/services/plans.service';
import { routeForAtomId, setRoute } from '@/state/router.store';
import { LoadingState, ErrorState } from '@/components/state-display/StateDisplay';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import styles from './GraphView.module.css';

type NodeData = {
  id: string;
  type: string;
  layer: string;
  content: string;
  principal: string;
  confidence: number;
  radius: number;
  fx?: number;
  fy?: number;
} & { x?: number; y?: number; vx?: number; vy?: number };

interface LinkData {
  source: string | NodeData;
  target: string | NodeData;
}

const TYPE_COLORS: Record<string, string> = {
  directive: 'var(--status-danger)',
  decision: 'var(--accent)',
  preference: 'var(--status-warning)',
  reference: 'var(--status-success)',
  plan: 'var(--accent-active)',
  observation: 'var(--text-muted)',
  'actor-message': 'var(--accent-hover)',
};

export function GraphView() {
  const canonQ = useQuery({
    queryKey: ['canon', [], ''],
    queryFn: ({ signal }) => listCanonAtoms({}, signal),
  });
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: ({ signal }) => listPlans(signal) });
  const activitiesQ = useQuery({
    queryKey: ['activities', 500],
    queryFn: ({ signal }) => listActivities({ limit: 500 }, signal),
  });

  const [includeKinds, setIncludeKinds] = useState<Set<string>>(new Set(['directive', 'decision', 'preference', 'reference']));

  const { nodes, links, adjacency } = useMemo(() => {
    const allAtoms = [
      ...(canonQ.data ?? []),
      ...(plansQ.data ?? []),
      ...(activitiesQ.data ?? []),
    ];
    const byId = new Map<string, CanonAtom>();
    for (const a of allAtoms) if (!byId.has(a.id)) byId.set(a.id, a);
    const kept = Array.from(byId.values()).filter((a) => includeKinds.has(a.type));
    const keptIds = new Set(kept.map((a) => a.id));

    const nodeList: NodeData[] = kept.map((a) => ({
      id: a.id,
      type: a.type,
      layer: a.layer,
      content: a.content,
      principal: a.principal_id,
      confidence: a.confidence ?? 0,
      radius: radiusFor(a.type, a.confidence ?? 0),
    }));
    const linkList: LinkData[] = [];
    const adj = new Map<string, Set<string>>();
    const note = (a: string, b: string) => {
      const s = adj.get(a) ?? new Set<string>();
      s.add(b);
      adj.set(a, s);
    };
    for (const a of kept) {
      const derived = (a.provenance?.derived_from ?? []) as ReadonlyArray<string>;
      for (const d of derived) {
        if (keptIds.has(d)) {
          linkList.push({ source: a.id, target: d });
          note(a.id, d);
          note(d, a.id);
        }
      }
    }
    return { nodes: nodeList, links: linkList, adjacency: adj };
  }, [canonQ.data, plansQ.data, activitiesQ.data, includeKinds]);

  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 0.7 });
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const simRef = useRef<Simulation<NodeData, LinkData> | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [, setTick] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (nodes.length === 0) return;
    const width = 1200;
    const height = 800;
    const sim = forceSimulation<NodeData, LinkData>(nodes)
      .force('link', forceLink<NodeData, LinkData>(links).id((d) => d.id).distance(80).strength(0.6))
      .force('charge', forceManyBody().strength(-260))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<NodeData>().radius((d) => d.radius + 4))
      .alphaDecay(0.03)
      .on('tick', () => setTick((t) => t + 1));
    simRef.current = sim;

    /*
     * Zoom-to-fit once the sim settles (alpha < 0.02). Reads the
     * node bounding box and fits it inside the container. Runs only
     * ONCE per layout so subsequent user zooms aren't overridden.
     */
    let didFit = false;
    sim.on('tick.fit', () => {
      if (didFit) return;
      if (sim.alpha() > 0.08) return;
      didFit = true;
      fitToViewport();
    });

    return () => { sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

  const fitToViewport = () => {
    if (nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) return;
    /*
     * Work in viewBox coordinates (1200x800). The SVG's
     * preserveAspectRatio maps viewBox → container automatically,
     * so we only need to:
     *   1. pick `scale` so the bbox fits in the viewBox with pad
     *   2. translate so the bbox center lands at viewBox center
     *      (after scaling).
     */
    const bboxW = maxX - minX || 1;
    const bboxH = maxY - minY || 1;
    const pad = 80;
    const scale = Math.min(1.2, Math.max(0.3, Math.min((1200 - pad * 2) / bboxW, (800 - pad * 2) / bboxH)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setTransform({ x: 600 - cx * scale, y: 400 - cy * scale, scale });
  };

  const toggleKind = (kind: string) => {
    setIncludeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const pending = canonQ.isPending || plansQ.isPending || activitiesQ.isPending;
  const error = canonQ.error ?? plansQ.error ?? activitiesQ.error;

  if (pending) return <LoadingState label="Loading graph…" testId="graph-loading" />;
  if (error) return <ErrorState title="Could not load graph" message={(error as Error).message} testId="graph-error" />;

  // Neighborhood dim: when a node is selected, everything >1 hop away dims.
  const neighbors = selectedId ? (adjacency.get(selectedId) ?? new Set()) : null;
  const isDim = (id: string) => selectedId !== null && id !== selectedId && !(neighbors && neighbors.has(id));

  const selectedAtom = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null;

  return (
    <section className={styles.view}>
      <header className={styles.toolbar}>
        <div>
          <div className={styles.statsTotal}>{nodes.length}</div>
          <div className={styles.statsLabel}>
            node{nodes.length === 1 ? '' : 's'} · {links.length} edge{links.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className={styles.filters}>
          {(['directive', 'decision', 'preference', 'reference', 'plan', 'observation', 'actor-message'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.filter} ${includeKinds.has(k) ? styles.filterActive : ''}`}
              onClick={() => toggleKind(k)}
              data-testid={`graph-filter-${k}`}
            >
              <span className={styles.filterDot} style={{ background: TYPE_COLORS[k] ?? 'var(--text-muted)' }} />
              {k}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.resetBtn}
          onClick={() => { setSelectedId(null); simRef.current?.alpha(0.6).restart(); setTimeout(fitToViewport, 600); }}
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
          // Click-on-canvas (no drag) closes any open node selection.
          if (dragging.current && !dragging.current.moved) setSelectedId(null);
          dragging.current = null;
        }}
        onMouseLeave={() => { dragging.current = null; setHoverId(null); }}
        onWheel={(e) => {
          const delta = -e.deltaY * 0.0015;
          setTransform((t) => ({ ...t, scale: Math.max(0.2, Math.min(4, t.scale + delta)) }));
        }}
      >
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox="0 0 1200 800"
          data-testid="graph-svg"
        >
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            <g className={styles.edges}>
              {links.map((l, i) => {
                const s = typeof l.source === 'string' ? null : l.source;
                const t = typeof l.target === 'string' ? null : l.target;
                if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null;
                const connected = selectedId !== null && (s.id === selectedId || t.id === selectedId);
                const dim = selectedId !== null && !connected;
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
              {nodes.map((n) => (
                <g
                  key={n.id}
                  className={`${styles.node} ${isDim(n.id) ? styles.nodeDim : ''} ${n.id === selectedId ? styles.nodeSelected : ''}`}
                  transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.metaKey || e.ctrlKey) { setRoute(routeForAtomId(n.id), n.id); return; }
                    setSelectedId(n.id);
                  }}
                  onMouseEnter={(e) => {
                    setHoverId(n.id);
                    setHoverPos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseMove={(e) => { setHoverPos({ x: e.clientX, y: e.clientY }); }}
                  onMouseLeave={() => { setHoverId(null); setHoverPos(null); }}
                  data-testid="graph-node"
                  data-node-id={n.id}
                  data-node-type={n.type}
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
        {hoverId && hoverPos && !dragging.current && (
          <GraphHoverTooltip node={nodes.find((n) => n.id === hoverId)!} x={hoverPos.x} y={hoverPos.y} />
        )}
      </div>
      <AnimatePresence>
        {selectedAtom && createPortal(
          <GraphDetailPanel node={selectedAtom} onClose={() => setSelectedId(null)} />,
          document.body,
        )}
      </AnimatePresence>
    </section>
  );
}

function radiusFor(type: string, confidence: number): number {
  const base = type === 'directive' ? 8 : type === 'decision' ? 7 : type === 'plan' ? 6 : 5;
  // Confidence slightly modulates radius so high-conf atoms pop.
  return base + Math.round(confidence * 2);
}

function GraphHoverTooltip({ node, x, y }: { node: NodeData; x: number; y: number }) {
  // Position near cursor with bounds-checking so tooltip doesn't
  // fall off the right edge on wide viewports.
  const width = 320;
  const left = Math.min(x + 16, window.innerWidth - width - 12);
  const top = Math.min(y + 16, window.innerHeight - 180);
  return createPortal(
    <div className={styles.hoverTooltip} style={{ top, left, width }} role="tooltip">
      <div className={styles.hoverHead}>
        <span className={styles.hoverType} data-type={node.type}>{node.type}</span>
        <code className={styles.hoverId}>{node.id}</code>
      </div>
      <p className={styles.hoverContent}>{truncate(node.content, 220)}</p>
      <div className={styles.hoverFoot}>
        <span>by {node.principal}</span>
        <span>·</span>
        <span>layer {node.layer}</span>
        <span>·</span>
        <span>conf {node.confidence.toFixed(2)}</span>
      </div>
      <div className={styles.hoverHint}>click · view · ⌘-click · open full page</div>
    </div>,
    document.body,
  );
}

function GraphDetailPanel({ node, onClose }: { node: NodeData; onClose: () => void }) {
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
        <dt>Principal</dt><dd>{node.principal}</dd>
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

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
