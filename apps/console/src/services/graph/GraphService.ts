import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

/*
 * GraphService — pure state machine for the substrate graph viewer.
 *
 * The viewer had been entangling d3-force, React useState, TanStack
 * Query invalidations, and useSyncExternalStore in ways that caused
 * the simulation to restart on unrelated re-renders (TimeAgo tick,
 * SSE invalidates, hover state). This class is the single source of
 * truth for:
 *   - the node / edge set (derived from an atom list + filter)
 *   - the simulation + its positions
 *   - the selection (with 1-hop neighbor set)
 *   - the bounding box for zoom-to-fit
 *
 * It is intentionally React-free so it can be unit-tested with
 * deterministic inputs:
 *   const svc = new GraphService({ width: 800, height: 600 });
 *   svc.setAtoms([...]);
 *   svc.settle();
 *   expect(svc.getSnapshot().bounds).toEqual(...);
 *
 * React consumers use the useGraphService hook which binds a single
 * long-lived instance to useSyncExternalStore — the service stays
 * alive across re-renders; setAtoms is a no-op when the input
 * signature is unchanged, so the simulation doesn't restart on
 * unrelated parent updates.
 */

export interface GraphAtom {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly provenance?: {
    readonly derived_from?: ReadonlyArray<string>;
  };
}

export interface GraphNode extends SimulationNodeDatum {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly radius: number;
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  readonly source: string | GraphNode;
  readonly target: string | GraphNode;
}

export interface GraphSelection {
  readonly nodeId: string | null;
  readonly neighbors: ReadonlySet<string>;
}

export interface GraphBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface GraphSnapshot {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly selection: GraphSelection;
  readonly kinds: ReadonlySet<string>;
  readonly bounds: GraphBounds | null;
  readonly settled: boolean;
  readonly version: number;
}

export interface GraphServiceOptions {
  readonly width?: number;
  readonly height?: number;
  readonly defaultKinds?: ReadonlyArray<string>;
}

const DEFAULT_KINDS = ['directive', 'decision', 'preference', 'reference'] as const;
const EMPTY_NEIGHBORS: ReadonlySet<string> = new Set();
const EMPTY_SELECTION: GraphSelection = { nodeId: null, neighbors: EMPTY_NEIGHBORS };

export class GraphService {
  private readonly width: number;
  private readonly height: number;
  private atoms: ReadonlyArray<GraphAtom> = [];
  private kinds: Set<string>;
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private adjacency = new Map<string, Set<string>>();
  private selection: GraphSelection = EMPTY_SELECTION;
  private sim: Simulation<GraphNode, GraphEdge> | null = null;
  private settled = false;
  private listeners = new Set<() => void>();
  private lastSignature = '';
  private version = 0;
  private snapshotCache: GraphSnapshot | null = null;

  constructor(opts: GraphServiceOptions = {}) {
    this.width = opts.width ?? 1200;
    this.height = opts.height ?? 800;
    this.kinds = new Set(opts.defaultKinds ?? DEFAULT_KINDS);
  }

  /*
   * Replace the atom set. No-op if the signature (ids + derived_from
   * edges + filter) is unchanged — this is what prevents the
   * simulation from restarting when a parent re-renders with the
   * same data (TimeAgo tick, hover state change, etc).
   */
  setAtoms(atoms: ReadonlyArray<GraphAtom>): void {
    const sig = this.computeSignature(atoms, this.kinds);
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.atoms = atoms;
    this.rebuild();
  }

  /*
   * Set the filter set. Identical-set short-circuits; otherwise a
   * rebuild is triggered. Selection is preserved if the selected
   * node is still in the filtered graph; otherwise cleared.
   */
  setKinds(kinds: Iterable<string>): void {
    const next = new Set(kinds);
    if (sameSet(next, this.kinds)) return;
    this.kinds = next;
    this.lastSignature = this.computeSignature(this.atoms, this.kinds);
    this.rebuild();
  }

  toggleKind(kind: string): void {
    const next = new Set(this.kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    this.setKinds(next);
  }

  select(id: string | null): void {
    if (id === null) {
      if (this.selection.nodeId === null) return;
      this.selection = EMPTY_SELECTION;
    } else {
      const existsInFilteredGraph = this.nodes.some((n) => n.id === id);
      if (!existsInFilteredGraph) {
        // Select a non-existent or filtered-out node = no-op. This is
        // a legitimate case when a sibling view passes an id that
        // doesn't match the current filter.
        return;
      }
      if (this.selection.nodeId === id) return;
      const neighbors = this.adjacency.get(id) ?? EMPTY_NEIGHBORS;
      this.selection = { nodeId: id, neighbors };
    }
    this.bumpVersion();
  }

  /*
   * Run the simulation to completion (synchronous). Useful for tests
   * that want a deterministic snapshot without waiting for rAF
   * ticks. In production the hook uses tick-driven renders.
   */
  settle(maxTicks = 400): void {
    if (!this.sim) return;
    let i = 0;
    while (i < maxTicks && this.sim.alpha() > 0.02) {
      this.sim.tick();
      i++;
    }
    this.settled = true;
    this.bumpVersion();
  }

  /*
   * Stop the simulation. Called when the view unmounts; keeps the
   * last positions on the nodes so re-mounts don't see a blank graph.
   */
  stop(): void {
    this.sim?.stop();
  }

  /*
   * Directly advance the simulation by one tick and notify
   * subscribers. The React hook calls this from rAF; tests can call
   * it synchronously.
   *
   * Returns true iff more ticks are needed.
   *
   * Critical: after `settled`, this is a no-op — NO sim.tick, NO
   * bumpVersion. Before this guard, any unrelated version bump (the
   * user selects a node, a filter is toggled and short-circuits,
   * etc.) made the React hook's rAF-restart useEffect re-fire and
   * schedule a frame; that frame called tick(), which ticked the
   * sim + bumped version, which re-fired the effect, ad infinitum.
   * A settled sim that gets "pinged" by a selection change now
   * stays still.
   */
  tick(): boolean {
    if (!this.sim || this.settled) return false;
    this.sim.tick();
    const a = this.sim.alpha();
    if (a < 0.02) {
      this.settled = true;
      this.bumpVersion(); // final bump to announce settled=true
      return false;
    }
    this.bumpVersion();
    return true;
  }

  /*
   * Current snapshot. Immutable view — consumers should treat the
   * returned object as frozen. Identity is stable between version
   * changes, which is what makes useSyncExternalStore cheap.
   */
  getSnapshot(): GraphSnapshot {
    if (this.snapshotCache && this.snapshotCache.version === this.version) {
      return this.snapshotCache;
    }
    const bounds = this.computeBounds();
    this.snapshotCache = {
      nodes: this.nodes,
      edges: this.edges,
      selection: this.selection,
      kinds: this.kinds,
      bounds,
      settled: this.settled,
      version: this.version,
    };
    return this.snapshotCache;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /*
   * Serialize the inputs that materially affect the simulation.
   * Kinds set + atom id set + derived_from-edge set. This is the
   * "did anything simulation-relevant actually change?" check.
   */
  private computeSignature(atoms: ReadonlyArray<GraphAtom>, kinds: ReadonlySet<string>): string {
    const keptIds: string[] = [];
    const edges: string[] = [];
    for (const a of atoms) {
      if (!kinds.has(a.type)) continue;
      keptIds.push(a.id);
    }
    const keptSet = new Set(keptIds);
    for (const a of atoms) {
      if (!kinds.has(a.type)) continue;
      const d = a.provenance?.derived_from ?? [];
      for (const to of d) {
        if (keptSet.has(to)) edges.push(`${a.id}>${to}`);
      }
    }
    keptIds.sort();
    edges.sort();
    const kindSig = Array.from(kinds).sort().join(',');
    return `${kindSig}|${keptIds.join(',')}|${edges.join(',')}`;
  }

  private rebuild(): void {
    const wasEmpty = this.nodes.length === 0;
    const kept = this.atoms.filter((a) => this.kinds.has(a.type));
    const keptIds = new Set(kept.map((a) => a.id));

    // Preserve positions of nodes that existed before. Rebuild keeps
    // physical continuity — adding one atom does not re-run force
    // layout on all of them.
    const prevPositions = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes) {
      if (n.x != null && n.y != null) prevPositions.set(n.id, { x: n.x, y: n.y });
    }

    this.nodes = kept.map((a) => {
      const prev = prevPositions.get(a.id);
      return {
        id: a.id,
        type: a.type,
        layer: a.layer,
        content: a.content,
        principal_id: a.principal_id,
        confidence: a.confidence,
        created_at: a.created_at,
        radius: radiusFor(a.type, a.confidence),
        x: prev?.x ?? this.width / 2 + (Math.random() - 0.5) * 40,
        y: prev?.y ?? this.height / 2 + (Math.random() - 0.5) * 40,
      };
    });

    this.adjacency = new Map();
    this.edges = [];
    for (const a of kept) {
      const d = a.provenance?.derived_from ?? [];
      for (const to of d) {
        if (!keptIds.has(to)) continue;
        this.edges.push({ source: a.id, target: to });
        addAdj(this.adjacency, a.id, to);
        addAdj(this.adjacency, to, a.id);
      }
    }

    // If the selected node is no longer in the filtered set, drop
    // the selection so we don't render a stale neighbor-halo.
    if (this.selection.nodeId && !keptIds.has(this.selection.nodeId)) {
      this.selection = EMPTY_SELECTION;
    } else if (this.selection.nodeId) {
      // Refresh neighbor set against the new adjacency.
      this.selection = {
        nodeId: this.selection.nodeId,
        neighbors: this.adjacency.get(this.selection.nodeId) ?? EMPTY_NEIGHBORS,
      };
    }

    this.startSimulation();
    /*
     * Pre-settle on the first populated rebuild so the view's first
     * paint has stable positions and a real bounds object. Without
     * this, the initial transform is applied to nodes still drifting
     * through the center-of-canvas, yielding the "not fit on load"
     * flash. Subsequent rebuilds (filter toggles, new atoms arriving)
     * preserve continuity via position carry-over and rAF ticks;
     * they should NOT re-settle synchronously because that would
     * freeze the main thread on every atom event.
     */
    if (wasEmpty && this.nodes.length > 0 && this.sim) {
      let i = 0;
      while (i < 400 && this.sim.alpha() > 0.02) {
        this.sim.tick();
        i++;
      }
      this.settled = true;
    }
    this.bumpVersion();
  }

  private startSimulation(): void {
    this.sim?.stop();
    this.settled = false;
    if (this.nodes.length === 0) {
      this.sim = null;
      return;
    }
    this.sim = forceSimulation<GraphNode, GraphEdge>(this.nodes)
      .force('link', forceLink<GraphNode, GraphEdge>(this.edges).id((d) => d.id).distance(80).strength(0.6))
      .force('charge', forceManyBody().strength(-260))
      .force('center', forceCenter(this.width / 2, this.height / 2))
      .force('collide', forceCollide<GraphNode>().radius((d) => d.radius + 4))
      .alphaDecay(0.03);
    // Do NOT subscribe to sim 'tick' here. The React hook (or a
    // test's explicit settle()) drives advancement. Keeping the
    // service agnostic of timing lets tests run synchronously.
  }

  private computeBounds(): GraphBounds | null {
    if (this.nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x == null || n.y == null) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  private bumpVersion(): void {
    this.version++;
    this.snapshotCache = null;
    for (const l of this.listeners) l();
  }
}

function addAdj(map: Map<string, Set<string>>, a: string, b: string): void {
  const s = map.get(a) ?? new Set<string>();
  s.add(b);
  map.set(a, s);
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function radiusFor(type: string, confidence: number): number {
  const base = type === 'directive' ? 8 : type === 'decision' ? 7 : type === 'plan' ? 6 : 5;
  return base + Math.round(confidence * 2);
}
