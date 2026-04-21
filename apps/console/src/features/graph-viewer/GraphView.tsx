import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, X } from 'lucide-react';
import {
  zoom as d3Zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3-zoom';
import { select } from 'd3-selection';
import { listCanonAtoms } from '@/services/canon.service';
import { listActivities } from '@/services/activities.service';
import { listPlans } from '@/services/plans.service';
import { routeForAtomId, setRoute } from '@/state/router.store';
import { LoadingState, ErrorState } from '@/components/state-display/StateDisplay';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { AtomHoverCard } from '@/components/hover-card/AtomHoverCard';
import { useHoverCard } from '@/components/hover-card/useHoverCard';
import { useGraphService } from '@/services/graph/useGraphService';
import type { GraphBounds, GraphNode } from '@/services/graph/GraphService';
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

const ALL_KINDS = [
  'directive', 'decision', 'preference', 'reference',
  'plan', 'observation', 'actor-message',
] as const;

const SCALE_MIN = 0.2;
const SCALE_MAX = 4;
const FIT_PADDING = 60;
const CLICK_DISTANCE_PX = 3;

/*
 * GraphView — service-backed, d3-zoom-driven graph viewer.
 *
 * State ownership:
 *   - GraphService (via useGraphService) owns nodes, edges, filter,
 *     selection, positions, bounds, simulation.
 *   - d3-zoom owns the pan/zoom transform. Its transform applies
 *     directly to the inner <g> as translate+scale in CSS pixels.
 *   - This component owns only the zoom behavior's React-mirrored
 *     transform state and the hover-card trigger state.
 *
 * Key correctness properties:
 *   - The SVG has no viewBox. Its internal coordinate system is CSS
 *     pixels, so d3-zoom's transforms (which come from clientX
 *     deltas) map 1:1 to child translations. Drag-distance math and
 *     zoom-at-cursor behavior are correct regardless of container
 *     size.
 *   - d3-zoom attaches wheel/mousedown to the SVG and mousemove/
 *     mouseup to the window (pointer-capture equivalent), so a
 *     mouseup outside the canvas ends the drag cleanly.
 *   - d3-zoom calls preventDefault on wheel, so scroll-wheel over
 *     the graph zooms without scrolling the outer page. React's
 *     onWheel synthetic handler is passive and can't preventDefault;
 *     d3-zoom attaches natively via non-passive addEventListener.
 *   - Initial fit is applied in useLayoutEffect before the first
 *     paint, using the real svg getBoundingClientRect size. The
 *     service pre-settles on its first populated rebuild so bounds
 *     are already available by the time this effect runs.
 */
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

  /*
   * Dedupe atoms across the three queries. Memoized on the three
   * data arrays; identity-stable when nothing changes so the service
   * signature check short-circuits.
   */
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

  const { snapshot, service } = useGraphService(atoms);
  const hoverCard = useHoverCard<GraphNode>();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const autoFitDoneRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [svgSize, setSvgSize] = useState<{ w: number; h: number } | null>(null);

  /*
   * Attach d3-zoom + measure + ResizeObserver via a callback ref.
   * This is intentionally NOT a useEffect because the <svg> is
   * conditionally rendered (we return early with <LoadingState /> on
   * pending). An empty-deps useEffect fires on the FIRST render,
   * sees svgRef.current=null (svg not mounted), and never re-fires
   * on subsequent renders — so d3-zoom would never attach.
   * Callback refs, by contrast, run every time React attaches or
   * detaches the DOM element, which is exactly the lifecycle we need.
   */
  const setupSvg = useCallback((el: SVGSVGElement | null) => {
    if (!el) {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      zoomBehaviorRef.current = null;
      svgRef.current = null;
      return;
    }
    svgRef.current = el;

    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([SCALE_MIN, SCALE_MAX])
      .filter((event: Event) => {
        /*
         * Default filter excludes right-button and ctrl/meta-click
         * so modifier-click on a node for "open in view" still works.
         * Primary-button mousedown, wheel, and touch gestures pass.
         */
        const me = event as MouseEvent;
        if (event.type === 'mousedown') {
          return me.button === 0 && !me.ctrlKey && !me.metaKey;
        }
        // Wheel / touchstart etc.
        return !(event as { button?: number }).button;
      })
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setTransform(event.transform);
      });
    select(el).call(behavior);
    zoomBehaviorRef.current = behavior;

    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSvgSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    resizeObserverRef.current = ro;
  }, []);

  // Initial fit. Runs before paint as soon as bounds + size are
  // available. Uses the real SVG pixel size so the fit math is
  // correct regardless of container size / viewBox drift.
  useLayoutEffect(() => {
    if (autoFitDoneRef.current) return;
    const el = svgRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!el || !behavior) return;
    if (!snapshot.settled || !snapshot.bounds || !svgSize) return;
    const fit = computeFitTransform(snapshot.bounds, svgSize.w, svgSize.h);
    /*
     * Call behavior.transform on a d3 selection — this updates the
     * internal zoom state AND fires the 'zoom' event, which flows
     * through to setTransform. If we only called setTransform, the
     * next user drag would start from an out-of-sync d3-zoom state
     * and "jump" back to identity on first move.
     */
    select(el).call(behavior.transform, fit);
    autoFitDoneRef.current = true;
  }, [snapshot.settled, snapshot.bounds, svgSize]);

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

  /*
   * Background click deselects, but only if no drag happened. We
   * track the mousedown point and compare on click — if the cursor
   * traveled > CLICK_DISTANCE_PX, it was a pan via d3-zoom and we
   * suppress the deselect. Clicks on child nodes stopPropagation so
   * this handler is only invoked for true background clicks.
   */
  const handleSvgMouseDown = (e: React.MouseEvent) => {
    pressRef.current = { x: e.clientX, y: e.clientY };
  };
  const handleSvgClick = (e: React.MouseEvent) => {
    const start = pressRef.current;
    pressRef.current = null;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > CLICK_DISTANCE_PX) return;
    service.select(null);
  };

  const handleFitClick = () => {
    const el = svgRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!el || !behavior || !snapshot.bounds || !svgSize) return;
    const fit = computeFitTransform(snapshot.bounds, svgSize.w, svgSize.h);
    select(el).call(behavior.transform, fit);
  };

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
          onClick={handleFitClick}
          data-testid="graph-reset"
        >
          fit
        </button>
      </header>
      <div className={styles.canvas} onMouseLeave={() => hoverCard.scheduleHide()}>
        <svg
          ref={setupSvg}
          className={styles.svg}
          data-testid="graph-svg"
          data-settled={snapshot.settled}
          data-version={snapshot.version}
          data-transform-k={transform.k.toFixed(4)}
          data-transform-x={transform.x.toFixed(2)}
          data-transform-y={transform.y.toFixed(2)}
          onMouseDown={handleSvgMouseDown}
          onClick={handleSvgClick}
        >
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
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
                    /*
                     * stopPropagation prevents the svg onClick (which
                     * deselects on background-click) from also firing.
                     * Note this only stops REACT propagation — the
                     * native event still bubbles and d3-zoom sees
                     * mousedown/mouseup on the svg. That's fine.
                     */
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
        {hoverCard.open && hoverCard.data && hoverCard.pos && createPortal(
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

/*
 * Fit bounds to the rendered SVG size. Scales to fit the bounding
 * box with FIT_PADDING on every side, never exceeding SCALE_MAX.
 * Returns a d3-zoom ZoomTransform that d3-zoom applies as
 * translate+scale on the inner <g>.
 */
function computeFitTransform(bounds: GraphBounds, svgW: number, svgH: number): ZoomTransform {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const rawScale = Math.min(
    (svgW - FIT_PADDING * 2) / w,
    (svgH - FIT_PADDING * 2) / h,
  );
  const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, rawScale));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const tx = svgW / 2 - cx * scale;
  const ty = svgH / 2 - cy * scale;
  return zoomIdentity.translate(tx, ty).scale(scale);
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
