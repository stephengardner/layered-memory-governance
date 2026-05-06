/*
 * Pure layout helper for the audit-chain visualization.
 *
 * The server returns { atoms, edges } in BFS order from the seed
 * outward. The renderer needs the per-atom DEPTH (distance from the
 * seed) so the gutter rail can color-code by depth, and so a future
 * desktop-only enhancement can switch to an indented tree without
 * recomputing the BFS in the component.
 *
 * Pure-function discipline: extracted to its own module + tested in
 * isolation per canon `dev-extract-at-n-equals-two` -- the depth
 * computation is the same logic the server's audit-chain helper
 * runs internally, but the wire shape doesn't preserve it (the BFS
 * frontier is local to the server walk). Computing it client-side
 * keeps the wire shape minimal and the client transform unit-testable
 * without a vitest mock for fetch.
 */

import type { AnyAtom } from '@/services/atoms.service';
import type { AuditChainEdge } from '@/services/atoms.service';

export interface AuditChainLayoutNode {
  readonly atom: AnyAtom;
  /**
   * Distance (in derived_from edges) from the seed. The seed itself
   * is depth 0; its direct parents are depth 1; etc.
   */
  readonly depth: number;
}

export interface AuditChainLayout {
  readonly nodes: ReadonlyArray<AuditChainLayoutNode>;
  /** The seed atom id, echoed for callers that already have it. */
  readonly seedId: string;
}

/**
 * Compute per-atom depth via BFS over the edge list, starting at the
 * seed. Atoms in the response that are not reachable from the seed
 * (impossible in the server's projection but defensively handled) are
 * appended at depth -1 so they still render rather than disappear.
 *
 * Output node order:
 *   - Seed first (depth 0)
 *   - Then atoms in ascending depth, ascending index within depth
 *
 * The within-depth tiebreak follows the order the server returned
 * (BFS order), which preserves the substrate-deep "stage 1 -> stage 2
 * -> stage 3" visual reading top-to-bottom.
 */
export function computeAuditChainLayout(
  atoms: ReadonlyArray<AnyAtom>,
  edges: ReadonlyArray<AuditChainEdge>,
  seedId: string,
): AuditChainLayout {
  const byId = new Map<string, AnyAtom>();
  for (const a of atoms) byId.set(a.id, a);

  /*
   * Build an adjacency map: child -> [parents]. We walk children
   * outward to discover depths in BFS order.
   */
  const parentsByChild = new Map<string, string[]>();
  for (const e of edges) {
    const list = parentsByChild.get(e.from);
    if (list) list.push(e.to);
    else parentsByChild.set(e.from, [e.to]);
  }

  const depthById = new Map<string, number>();
  if (byId.has(seedId)) {
    depthById.set(seedId, 0);
    const queue: string[] = [seedId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curDepth = depthById.get(cur)!;
      const parents = parentsByChild.get(cur) ?? [];
      for (const p of parents) {
        if (depthById.has(p)) continue;
        if (!byId.has(p)) continue;
        depthById.set(p, curDepth + 1);
        queue.push(p);
      }
    }
  }

  /*
   * Stable ordering: preserve the response order within a given depth,
   * but globally sort by (depth ASC, response-index ASC). The server
   * already emits seed at index 0 and ancestors in BFS order, so the
   * within-depth ordering matches the substrate-walked order.
   */
  const indexById = new Map<string, number>();
  atoms.forEach((a, i) => indexById.set(a.id, i));

  const nodes: AuditChainLayoutNode[] = atoms
    .map((a) => ({ atom: a, depth: depthById.get(a.id) ?? -1 }))
    .sort((a, b) => {
      // Atoms unreachable from the seed (depth -1) drop to the bottom.
      const da = a.depth === -1 ? Number.POSITIVE_INFINITY : a.depth;
      const db = b.depth === -1 ? Number.POSITIVE_INFINITY : b.depth;
      if (da !== db) return da - db;
      return (indexById.get(a.atom.id) ?? 0) - (indexById.get(b.atom.id) ?? 0);
    });

  return { nodes, seedId };
}
