/**
 * Compute a principal's depth from root via the `signed_by` chain.
 *
 * Conventions:
 *   - Depth 0 = a root principal (signed_by === null).
 *   - Depth N = N hops along `signed_by` to reach a root.
 *   - Unknown / broken chains return MAX_PRINCIPAL_DEPTH as a fail-safe
 *     so unrooted principals do not accidentally outrank properly-rooted
 *     ones.
 *
 * Cycle guard: if a chain loops (should never happen under normal use)
 * the walker halts at MAX_PRINCIPAL_DEPTH.
 *
 * This is the primitive that makes source-rank hierarchy-aware: a
 * shallower principal's atom outranks a deeper one when layer /
 * provenance / confidence are equal, via `sourceRank(atom, depth)`.
 */

import type { PrincipalStore } from '../interface.js';
import type { PrincipalId } from '../types.js';

/**
 * Principal chains deeper than this are capped. 9 is chosen as a
 * conservative upper bound that covers deeply-nested delegation chains
 * with room to spare; orgs with a shallower ladder never hit it, and
 * the arbitration rank math (depth multiplier 11) stays within a
 * single 100-point provenance step.
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
