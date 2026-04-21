/**
 * Compute a principal's depth from root via the `signed_by` chain.
 *
 * Conventions:
 *   - Depth 0 = a root principal (signed_by === null). Typically the human
 *     operator or a top-level org directive principal.
 *   - Depth 1 = a principal signed by a root. e.g. VP-eng reports to root.
 *   - Depth 2 = grandchild. e.g. alice reports to vp-eng who reports to root.
 *   - Unknown / broken chains return MAX_PRINCIPAL_DEPTH as a fail-safe so
 *     unrooted principals do not accidentally outrank properly-rooted ones.
 *
 * Cycle guard: if a chain loops (should never happen under normal use) the
 * walker halts at MAX_PRINCIPAL_DEPTH.
 *
 * This is the primitive that makes source-rank hierarchy-aware. The
 * autonomous-organization story (a vp-eng atom beats an agent alice atom
 * even when their layer / provenance / confidence are equal) is realized by
 * feeding this depth into `sourceRank(atom, depth)`.
 */

import type { PrincipalStore } from '../substrate/interface.js';
import type { PrincipalId } from '../substrate/types.js';

/**
 * Principal chains deeper than this are capped. Exceeds realistic org
 * depth (human -> CEO -> VP -> director -> manager -> IC -> agent is 6);
 * 9 leaves headroom.
 */
export const MAX_PRINCIPAL_DEPTH = 9;

/**
 * Walk `signed_by` from `principalId` up to a root. Returns the number of
 * hops. Unknown principal, broken link, or cycle returns MAX_PRINCIPAL_DEPTH.
 */
export async function computePrincipalDepth(
  principalId: PrincipalId,
  principals: PrincipalStore,
): Promise<number> {
  const seen = new Set<PrincipalId>();
  let current: PrincipalId | null = principalId;
  let depth = 0;
  while (current !== null && depth < MAX_PRINCIPAL_DEPTH) {
    if (seen.has(current)) return MAX_PRINCIPAL_DEPTH; // cycle
    seen.add(current);
    const p = await principals.get(current);
    if (p === null) return MAX_PRINCIPAL_DEPTH;        // broken link
    if (p.signed_by === null) return depth;            // hit root
    current = p.signed_by;
    depth += 1;
  }
  return MAX_PRINCIPAL_DEPTH;
}
