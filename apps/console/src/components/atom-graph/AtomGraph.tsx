import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAtomChain, listReferencers, type CanonAtom } from '@/services/canon.service';
import { routeForAtomId, setRoute } from '@/state/router.store';
import styles from './AtomGraph.module.css';

interface Props {
  readonly atom: CanonAtom;
}

/**
 * Local neighborhood graph: center = this atom, left = direct
 * derived_from ancestors (it DEPENDS ON these), right = direct
 * reverse-refs (these depend on IT). Rendered as pure SVG with
 * manual 3-column layout — no d3, no force sim, no external dep.
 *
 * Each node is clickable and routes via AtomRef logic. Hovering a
 * node highlights its connecting edge; the center always stays
 * bold. The viz is a "where does this atom sit in the graph" quick-
 * read, not a full knowledge-graph explorer.
 */
export function AtomGraph({ atom }: Props) {
  const ancestorsQ = useQuery({
    queryKey: ['atoms.chain.direct', atom.id],
    queryFn: ({ signal }) => listAtomChain(atom.id, 1, signal),
    staleTime: 30_000,
  });
  const referencersQ = useQuery({
    queryKey: ['atoms.references', atom.id],
    queryFn: ({ signal }) => listReferencers(atom.id, signal),
    staleTime: 30_000,
  });

  const ancestors = ancestorsQ.data ?? [];
  const referencers = referencersQ.data ?? [];

  const layout = useMemo(() => computeLayout(atom, ancestors, referencers), [atom, ancestors, referencers]);

  if (ancestorsQ.isPending && referencersQ.isPending) return null;
  if (ancestors.length === 0 && referencers.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.legend}>
        <span><span className={styles.legendDot} data-role="ancestor" /> depends on</span>
        <span><span className={styles.legendDot} data-role="center" /> this atom</span>
        <span><span className={styles.legendDot} data-role="referencer" /> depended on by</span>
      </div>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className={styles.svg}
        role="img"
        aria-label="Local atom graph"
        data-testid="atom-graph"
      >
        <g className={styles.edges}>
          {layout.edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              className={styles.edge}
            />
          ))}
        </g>
        <g className={styles.nodes}>
          {layout.nodes.map((n) => (
            <g
              key={n.id}
              className={styles.node}
              data-role={n.role}
              transform={`translate(${n.x}, ${n.y})`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                setRoute(routeForAtomId(n.id), n.id);
              }}
            >
              <circle r={n.role === 'center' ? 8 : 6} className={styles.dot} data-role={n.role} data-type={n.type} />
              <text
                className={styles.label}
                data-anchor={n.role === 'ancestor' ? 'end' : n.role === 'center' ? 'middle' : 'start'}
                x={n.role === 'ancestor' ? -14 : n.role === 'center' ? 0 : 14}
                y={n.role === 'center' ? 22 : 4}
              >
                {truncate(n.id, 26)}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

interface Node {
  id: string;
  type: string;
  role: 'ancestor' | 'center' | 'referencer';
  x: number;
  y: number;
}

interface Edge { x1: number; y1: number; x2: number; y2: number; }

function computeLayout(
  center: CanonAtom,
  ancestors: ReadonlyArray<CanonAtom>,
  referencers: ReadonlyArray<CanonAtom>,
): { width: number; height: number; nodes: Node[]; edges: Edge[] } {
  // Cap each side to 6 nodes so the graph stays readable.
  const A = ancestors.slice(0, 6);
  const R = referencers.slice(0, 6);
  const width = 600;
  const col = { left: 120, center: 300, right: 480 };
  const rowHeight = 38;
  const rowsNeeded = Math.max(1, A.length, R.length);
  const height = Math.max(180, rowsNeeded * rowHeight + 40);
  const midY = height / 2;

  const stack = (n: number) => {
    const total = (n - 1) * rowHeight;
    const startY = midY - total / 2;
    return Array.from({ length: n }, (_, i) => startY + i * rowHeight);
  };

  const ancestorYs = stack(A.length);
  const referencerYs = stack(R.length);

  const nodes: Node[] = [
    { id: center.id, type: center.type, role: 'center', x: col.center, y: midY },
    ...A.map<Node>((a, i) => ({ id: a.id, type: a.type, role: 'ancestor', x: col.left, y: ancestorYs[i]! })),
    ...R.map<Node>((r, i) => ({ id: r.id, type: r.type, role: 'referencer', x: col.right, y: referencerYs[i]! })),
  ];

  const edges: Edge[] = [
    ...A.map<Edge>((_, i) => ({ x1: col.left + 8, y1: ancestorYs[i]!, x2: col.center - 10, y2: midY })),
    ...R.map<Edge>((_, i) => ({ x1: col.center + 10, y1: midY, x2: col.right - 8, y2: referencerYs[i]! })),
  ];

  return { width, height, nodes, edges };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
