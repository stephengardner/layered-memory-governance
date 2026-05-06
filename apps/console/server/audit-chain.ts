/*
 * Pure helpers for the atom audit-chain projection.
 *
 * Audit chain = transitive ancestors of a seed atom along
 * provenance.derived_from edges, depth-limited and cycle-safe. The
 * shape this module emits ({ atoms, edges }) is richer than the
 * existing atoms.chain endpoint (which returns Atom[] only) because
 * the operator-facing visualizer renders the actual graph -- nodes
 * AND the edges between them -- not a flat ancestor list.
 *
 * Why a separate module from server/index.ts:
 * - Sibling-helper convention (mirrors actor-activity.ts, pipelines.ts,
 *   stage-context.ts): pure function, no fs/http, vitest-friendly.
 * - Keeps the transform unit-testable in isolation; the route handler
 *   stays a thin pass-through.
 *
 * Why a separate endpoint from atoms.chain:
 * - atoms.chain has 5+ live callers in the Console
 *   (CanonCard.WhyThisAtom, AttributionAuditDialog, AtomGraph,
 *   SupersedesDiff, canon.service.listAtomChain). Changing its return
 *   shape would break every consumer; widening the response with a
 *   discriminator would require schema migration on each consumer.
 * - The audit-chain projection has different defaults (max_depth=10
 *   versus chain's 5) because the audit surface is the operator's
 *   "why does this atom exist + what produced it" trace, which can
 *   walk a substrate-deep pipeline 8+ stages back; canon-card
 *   neighborhoods stay narrow.
 * - Both projections coexist per `dev-substrate-not-prescription`:
 *   the substrate exposes the underlying graph; surfaces compose
 *   their own projections.
 */

/**
 * Minimal atom shape consumed by the audit-chain projection. Wider
 * `Atom` shapes are pass-through compatible (TypeScript structural
 * subtyping); the helper only reads provenance.derived_from.
 */
export interface AuditChainAtom {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly plan_state?: string;
  readonly pipeline_state?: string;
  readonly taint?: string;
}

/**
 * Edge in the audit-chain graph. `from` derived_from `to`: the child
 * atom (the one closer to the seed) cites the parent. The seed itself
 * is the bottom of the chain; its derived_from edges fan upward to its
 * ancestors. This direction matches the on-disk provenance shape so
 * consumers do not need to mentally invert.
 */
export interface AuditChainEdge {
  readonly from: string;
  readonly to: string;
}

export interface AuditChainResponse {
  /**
   * Atoms in the chain INCLUDING the seed at index 0. Subsequent
   * entries are ancestors discovered in BFS order. Order matters for
   * the timeline rendering: the seed sits at the bottom of the
   * timeline and ancestors flow upward.
   */
  readonly atoms: ReadonlyArray<AuditChainAtom>;
  /**
   * Edges referencing `atoms[*].id`. Always a subset of the actual
   * derived_from edges in the substrate -- edges that point at an
   * ancestor we did NOT include (because of max_depth, or because the
   * ancestor atom is missing from the store) are dropped so every
   * edge is renderable.
   */
  readonly edges: ReadonlyArray<AuditChainEdge>;
  /**
   * Truncation flags so the UI can show "+N more" affordances and
   * the operator knows the projection is bounded.
   */
  readonly truncated: {
    /** True when the BFS hit max_depth and stopped expanding further. */
    readonly depth_reached: boolean;
    /** Count of derived_from references pointing at atoms not in the response (missing from store, OR pruned by depth). */
    readonly missing_ancestors: number;
  };
}

/**
 * Default depth limit for an audit-chain projection. 10 is wide enough
 * to walk a substrate-deep pipeline (operator-intent -> brainstorm ->
 * spec -> plan -> review -> dispatch -> code-author session -> turns)
 * end-to-end without overflowing a single page render. Operators who
 * need more pass an explicit max_depth on the request.
 */
export const DEFAULT_AUDIT_CHAIN_DEPTH = 10;

/**
 * Hard ceiling on max_depth. Beyond this the response payload risks
 * pulling the entire connected component of the graph into a single
 * request, which collapses the in-memory atom index and the wire
 * payload at the org-ceiling of 50 actors. 25 is a defensive cap
 * that no real pipeline reaches; raise via canon edit if a deployment
 * exceeds it.
 */
export const MAX_AUDIT_CHAIN_DEPTH = 25;

/**
 * Read provenance.derived_from off any atom shape, returning [] when
 * the field is missing or malformed. The narrow type cast mirrors
 * the substrate convention (provenance is `Record<string, unknown>`
 * on disk; runtime guards extract the typed slice).
 */
function readDerivedFrom(atom: AuditChainAtom): ReadonlyArray<string> {
  const prov = atom.provenance as { derived_from?: unknown } | undefined;
  const raw = prov?.derived_from;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * Clamp the requested max_depth to the supported range. Falsy or
 * out-of-range inputs fall back to the default. The clamp happens in
 * the helper (not the route handler) so unit tests cover the bounds
 * without spinning up HTTP.
 */
export function clampAuditChainDepth(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_AUDIT_CHAIN_DEPTH;
  const n = Math.floor(raw);
  if (n < 1) return DEFAULT_AUDIT_CHAIN_DEPTH;
  if (n > MAX_AUDIT_CHAIN_DEPTH) return MAX_AUDIT_CHAIN_DEPTH;
  return n;
}

/**
 * Build the audit-chain projection for `seedId`.
 *
 * BFS from the seed along provenance.derived_from edges. The seed is
 * always emitted at index 0 so the renderer can highlight it without
 * a separate flag. Ancestors are deduplicated via a visited set so
 * a diamond-shaped graph (two children both citing the same parent)
 * does not double-list the parent.
 *
 * Edges are emitted only when BOTH endpoints are present in the
 * response. An edge pointing at an ancestor that was pruned (max_depth)
 * or that does not exist in the substrate (dangling derived_from)
 * is reflected in `truncated.missing_ancestors` instead of as a
 * dangling edge -- the visualizer never receives an edge whose
 * target it cannot render.
 *
 * @param seedId - id of the atom to start the walk from.
 * @param atoms - the full atom corpus (in-memory projection from the server's index).
 * @param maxDepth - depth limit (post-clamp, see clampAuditChainDepth).
 * @returns the projection, OR null when the seed is unknown.
 */
export function buildAuditChain(
  seedId: string,
  atoms: ReadonlyArray<AuditChainAtom>,
  maxDepth: number,
): AuditChainResponse | null {
  const byId = new Map<string, AuditChainAtom>();
  for (const a of atoms) byId.set(a.id, a);

  const seed = byId.get(seedId);
  if (!seed) return null;

  const included = new Set<string>([seedId]);
  const orderedIds: string[] = [seedId];
  /*
   * Edges are accumulated in walk order with their endpoints. We resolve
   * inclusion at emit time (after the full BFS settles) because an
   * ancestor referenced from depth=2 and depth=5 should produce ONE
   * edge per (from, to) pair, not two; and the missing-ancestor count
   * needs the final included-set to compute correctly.
   */
  const edgesAccum: AuditChainEdge[] = [];
  /*
   * Dedup the missing-ancestor count via a Set keyed on the dangling
   * parent id. Two children both citing the same pruned parent (a
   * diamond whose apex sits past max_depth, OR two children both
   * citing the same missing-from-store id) should produce ONE
   * missing-ancestor entry, not two; the UI's "+N upstream not shown"
   * pill must reflect distinct atoms.
   */
  const missingAncestorIds = new Set<string>();
  let depthReached = false;

  type WalkEntry = { id: string; depth: number };
  const queue: WalkEntry[] = [{ id: seedId, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);

    const atom = byId.get(cur.id);
    if (!atom) continue;

    if (cur.depth >= maxDepth) {
      // We render the atom we are AT, but do not expand its parents.
      // Each unincluded derived_from reference at this boundary is
      // recorded ONCE in missingAncestorIds (set-deduped) so two
      // boundary atoms citing the same missing parent count once.
      const parents = readDerivedFrom(atom);
      if (parents.length > 0) {
        depthReached = true;
        for (const p of parents) {
          if (!included.has(p)) missingAncestorIds.add(p);
        }
      }
      continue;
    }

    for (const parentId of readDerivedFrom(atom)) {
      edgesAccum.push({ from: cur.id, to: parentId });
      if (!included.has(parentId)) {
        if (byId.has(parentId)) {
          included.add(parentId);
          orderedIds.push(parentId);
          queue.push({ id: parentId, depth: cur.depth + 1 });
        }
        // else: parent missing from store; counted at edge-resolution time.
      }
    }
  }

  // Resolve edges + missing-ancestor count after the walk settles so
  // we never double-count: an edge accumulated twice because two
  // children both cite the same parent counts ONCE in the edges
  // array (edgeKey set), and a dangling target counts ONCE in
  // missingAncestorIds (set-deduped) regardless of how many
  // children cited it.
  const edgeKey = new Set<string>();
  const edges: AuditChainEdge[] = [];
  for (const e of edgesAccum) {
    if (!included.has(e.to)) {
      missingAncestorIds.add(e.to);
      continue;
    }
    const k = `${e.from}\u0000${e.to}`;
    if (edgeKey.has(k)) continue;
    edgeKey.add(k);
    edges.push(e);
  }

  const orderedAtoms = orderedIds.map((id) => byId.get(id)!).filter((a): a is AuditChainAtom => Boolean(a));

  return {
    atoms: orderedAtoms,
    edges,
    truncated: {
      depth_reached: depthReached,
      missing_ancestors: missingAncestorIds.size,
    },
  };
}
