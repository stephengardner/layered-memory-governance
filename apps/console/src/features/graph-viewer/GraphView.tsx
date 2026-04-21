import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type Simulation } from 'd3-force';
import { listCanonAtoms, type CanonAtom } from '@/services/canon.service';
import { listActivities } from '@/services/activities.service';
import { listPlans } from '@/services/plans.service';
import { routeForAtomId, setRoute } from '@/state/router.store';
import { LoadingState, ErrorState } from '@/components/state-display/StateDisplay';
import styles from './GraphView.module.css';

type NodeData = {
  id: string;
  type: string;
  layer: string;
  content: string;
  radius: number;
  fx?: number;
  fy?: number;
} & d3Node;

/*
 * d3-force mutates `x, y, vx, vy` on each tick. Declare them
 * optional so our initial seed values satisfy the typechecker,
 * and so our render code can access them without non-null casts.
 */
interface d3Node {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

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

  const { nodes, links } = useMemo(() => {
    const allAtoms = [
      ...(canonQ.data ?? []),
      ...(plansQ.data ?? []),
      ...(activitiesQ.data ?? []),
    ];
    // Dedupe by id (plans + activities may overlap with canon).
    const byId = new Map<string, CanonAtom>();
    for (const a of allAtoms) if (!byId.has(a.id)) byId.set(a.id, a);
    const kept = Array.from(byId.values()).filter((a) => includeKinds.has(a.type));
    const keptIds = new Set(kept.map((a) => a.id));

    const nodeList: NodeData[] = kept.map((a) => ({
      id: a.id,
      type: a.type,
      layer: a.layer,
      content: a.content,
      radius: radiusFor(a.type),
    }));
    const linkList: LinkData[] = [];
    for (const a of kept) {
      const derived = (a.provenance?.derived_from ?? []) as ReadonlyArray<string>;
      for (const d of derived) {
        if (keptIds.has(d)) linkList.push({ source: a.id, target: d });
      }
    }
    return { nodes: nodeList, links: linkList };
  }, [canonQ.data, plansQ.data, activitiesQ.data, includeKinds]);

  // Pan + zoom state (purely CSS transform — no SVG viewBox gymnastics).
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Run the sim when nodes change; attach to SVG container so every render
  // after the sim settles reads the latest positions.
  const simRef = useRef<Simulation<NodeData, LinkData> | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (nodes.length === 0) return;
    const width = 1200;
    const height = 800;
    const sim = forceSimulation<NodeData, LinkData>(nodes)
      .force('link', forceLink<NodeData, LinkData>(links).id((d) => d.id).distance(80).strength(0.6))
      .force('charge', forceManyBody().strength(-240))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<NodeData>().radius((d) => d.radius + 4))
      .alphaDecay(0.03)
      .on('tick', () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => { sim.stop(); };
    // Re-run when node identity changes; tick updates drive renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

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
          onClick={() => { setTransform({ x: 0, y: 0, scale: 1 }); simRef.current?.alpha(0.4).restart(); }}
          data-testid="graph-reset"
        >
          reset
        </button>
      </header>
      <div
        className={styles.canvas}
        onMouseDown={(e) => {
          dragging.current = { startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
        }}
        onMouseMove={(e) => {
          if (!dragging.current) return;
          const dx = e.clientX - dragging.current.startX;
          const dy = e.clientY - dragging.current.startY;
          setTransform((t) => ({ ...t, x: dragging.current!.origX + dx, y: dragging.current!.origY + dy }));
        }}
        onMouseUp={() => { dragging.current = null; }}
        onMouseLeave={() => { dragging.current = null; }}
        onWheel={(e) => {
          const delta = -e.deltaY * 0.0015;
          setTransform((t) => ({ ...t, scale: Math.max(0.3, Math.min(4, t.scale + delta)) }));
        }}
      >
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox="0 0 1200 800"
          data-testid="graph-svg"
          data-tick={tick}
        >
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            <g className={styles.edges}>
              {links.map((l, i) => {
                const s = typeof l.source === 'string' ? null : l.source;
                const t = typeof l.target === 'string' ? null : l.target;
                if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null;
                return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} className={styles.edge} />;
              })}
            </g>
            <g className={styles.nodes}>
              {nodes.map((n) => (
                <g
                  key={n.id}
                  className={styles.node}
                  transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    setRoute(routeForAtomId(n.id), n.id);
                  }}
                  data-testid="graph-node"
                  data-node-id={n.id}
                  data-node-type={n.type}
                >
                  <circle
                    r={n.radius}
                    style={{ fill: TYPE_COLORS[n.type] ?? 'var(--text-muted)' }}
                  />
                  <title>{n.id} — {n.content.slice(0, 80)}</title>
                </g>
              ))}
            </g>
          </g>
        </svg>
      </div>
    </section>
  );
}

function radiusFor(type: string): number {
  if (type === 'directive') return 8;
  if (type === 'decision') return 7;
  if (type === 'plan') return 6;
  return 5;
}
