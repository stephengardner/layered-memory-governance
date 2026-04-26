/**
 * Principal hierarchy tree builder.
 *
 * The signed_by chain is the trust model; a flat list of principals
 * doesn't show "if compromise X happens, who inherits the taint?" --
 * that question wants a parent-child projection rooted at the
 * principals with signed_by===null. This module exposes a single
 * pure function (buildPrincipalTree) that takes the flat principal
 * array and returns a nested PrincipalTreeNode forest plus an
 * orphan list.
 *
 * The function is intentionally pure (no I/O) so it is unit-
 * testable without standing up the filesystem and re-usable from
 * the demo bundler when a static build wants to project the same
 * shape.
 *
 * Cycle detection: signed_by chains MUST be acyclic by design (a
 * principal cannot sign its own ancestor), but real data can drift.
 * The builder tracks the visited set on each branch and throws on
 * cycle detection rather than silently truncating, so an operator
 * sees "principal-store has a cycle" and not "tree looks fine but
 * three principals are missing".
 *
 * Bounded fan-out: with MAX_PRINCIPAL_DEPTH = 9 (canon
 * `pref-max-principal-depth`) and a small org cardinality, the
 * recursion depth is naturally O(log N). No artificial cap is
 * needed; the cycle guard is the only safety net.
 */

export interface PrincipalTreeInput {
  readonly id: string;
  readonly name?: string;
  readonly role?: string;
  readonly active?: boolean;
  readonly signed_by?: string | null;
  readonly compromised_at?: string | null;
}

export interface PrincipalTreeNode {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly depth: number;
  readonly kind: 'root' | 'agent' | 'human' | 'unknown';
  readonly taint_state: 'clean' | 'compromised' | 'inherited';
  readonly active: boolean;
  readonly children: ReadonlyArray<PrincipalTreeNode>;
}

export interface PrincipalTreeResult {
  readonly roots: ReadonlyArray<PrincipalTreeNode>;
  /** Principals whose signed_by points at a missing id. */
  readonly orphans: ReadonlyArray<string>;
}

export function buildPrincipalTree(
  principals: ReadonlyArray<PrincipalTreeInput>,
): PrincipalTreeResult {
  const byId = new Map<string, PrincipalTreeInput>();
  for (const p of principals) {
    if (typeof p.id === 'string' && p.id.length > 0) byId.set(p.id, p);
  }

  // Children index for O(1) child lookup.
  const childrenById = new Map<string, PrincipalTreeInput[]>();
  for (const p of principals) {
    const parent = p.signed_by ?? null;
    if (parent === null) continue;
    const bucket = childrenById.get(parent);
    if (bucket) bucket.push(p);
    else childrenById.set(parent, [p]);
  }
  for (const bucket of childrenById.values()) {
    bucket.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Roots: principals whose signed_by is null/missing. Orphans:
  // principals whose signed_by points at an id that doesn't exist.
  // Returned alongside so the UI can warn rather than render them as
  // ghost roots.
  const roots: PrincipalTreeInput[] = [];
  const orphans: string[] = [];
  for (const p of principals) {
    if (!p.signed_by) {
      roots.push(p);
    } else if (!byId.has(p.signed_by)) {
      orphans.push(p.id);
    }
  }
  roots.sort((a, b) => a.id.localeCompare(b.id));

  // Build each root subtree. A separate visited set per root ensures
  // sibling subtrees can both reach a shared id (legal), while a
  // back-edge inside one root's chain throws.
  const builtRoots = roots.map((r) =>
    buildSubtree(r, 0, false, byId, childrenById, new Set<string>()),
  );
  return { roots: builtRoots, orphans };
}

function buildSubtree(
  principal: PrincipalTreeInput,
  depth: number,
  ancestorCompromised: boolean,
  byId: ReadonlyMap<string, PrincipalTreeInput>,
  childrenById: ReadonlyMap<string, PrincipalTreeInput[]>,
  visited: Set<string>,
): PrincipalTreeNode {
  if (visited.has(principal.id)) {
    throw new Error(`principal-tree: cycle detected at ${principal.id}`);
  }
  visited.add(principal.id);

  const selfCompromised = Boolean(principal.compromised_at);
  const taintState: PrincipalTreeNode['taint_state'] = selfCompromised
    ? 'compromised'
    : ancestorCompromised
      ? 'inherited'
      : 'clean';

  const role = principal.role ?? 'unknown';
  const kind: PrincipalTreeNode['kind'] = depth === 0
    ? 'root'
    : role === 'human'
      ? 'human'
      : role === 'agent'
        ? 'agent'
        : 'unknown';

  const childPrincipals = childrenById.get(principal.id) ?? [];
  // Pass a SHALLOW COPY of `visited` to each child so siblings don't
  // poison each other's chain (a legit DAG reuse from two siblings
  // would otherwise look like a cycle on the second visit).
  const children = childPrincipals.map((c) =>
    buildSubtree(
      c,
      depth + 1,
      selfCompromised || ancestorCompromised,
      byId,
      childrenById,
      new Set(visited),
    ),
  );

  return {
    id: principal.id,
    name: principal.name ?? principal.id,
    role,
    depth,
    kind,
    taint_state: taintState,
    active: principal.active !== false,
    children,
  };
}
