/**
 * Source-rank rule.
 *
 * Deterministic priority ladder. Highest-rank atom wins when two atoms
 * conflict. Ties return null so the next rule can try.
 *
 * Priority, highest first:
 *   1. Layer: L3 canon > L2 curated > L1 extracted > L0 raw.
 *   2. Provenance kind: user-directive > canon-promoted > llm-refined
 *      > agent-inferred > agent-observed.
 *   3. Principal hierarchy depth: lower depth (closer to root) wins. A
 *      root principal's atom outranks a deeply-nested principal's atom
 *      when layer + provenance are otherwise equal.
 *   4. Confidence: higher wins (integer scale, 0-10).
 *
 * Principal depth is supplied by the caller because computing it requires
 * walking `signed_by` via the PrincipalStore (async). The caller resolves
 * both atoms' depths up front and passes them in via `SourceRankContext`.
 * Zero-depth defaults keep the function pure for callers that do not
 * need hierarchy.
 */

import type { Atom, Layer, ProvenanceKind } from '../types.js';
import type { ConflictPair, DecisionOutcome } from './types.js';
import { MAX_PRINCIPAL_DEPTH } from './principal-depth.js';

const LAYER_RANK: Record<Layer, number> = {
  L3: 100,
  L2: 80,
  L1: 40,
  L0: 10,
};

const PROVENANCE_RANK: Record<ProvenanceKind, number> = {
  // Bootstrap-seeded atoms rank with user-directives: both are operator-
  // authored claims; 'operator-seeded' comes from a script at init, while
  // 'user-directive' comes from a live session. Equal authority.
  'operator-seeded': 100,
  'user-directive': 100,
  'canon-promoted': 80,
  'llm-refined': 60,
  'agent-inferred': 40,
  'agent-observed': 20,
};

export interface SourceRankContext {
  /** Depth of atom.a's principal from root (0 = root). Default 0. */
  readonly depthA?: number;
  /** Depth of atom.b's principal from root (0 = root). Default 0. */
  readonly depthB?: number;
}

/**
 * Pure scoring function. Higher = wins. `principalDepth` is optional
 * and defaults to 0 (root / unknown treated as root).
 *
 * Scale chosen so Layer >> Provenance >> PrincipalDepth >> Confidence
 * in every comparison. Principal depth only matters when the two atoms
 * have identical layer and provenance; in that case the higher-in-
 * hierarchy principal wins.
 */
export function sourceRank(atom: Atom, principalDepth: number = 0): number {
  const depth = Math.max(0, Math.min(principalDepth, MAX_PRINCIPAL_DEPTH));
  // Confidence is in [0, 1] so Math.floor(c * 10) returns 0..10 (c=1
  // hits the upper bound). Clamp to 10 and use a depth multiplier of
  // 11 so a one-level hierarchy advantage always outranks any
  // confidence delta, preserving the documented precedence
  // Layer >> Provenance >> PrincipalDepth >> Confidence.
  const confidenceBucket = Math.max(0, Math.min(10, Math.floor(atom.confidence * 10)));
  return (
    LAYER_RANK[atom.layer] * 10_000 +
    PROVENANCE_RANK[atom.provenance.kind] * 100 +
    (MAX_PRINCIPAL_DEPTH - depth) * 11 +
    confidenceBucket
  );
}

/**
 * Decide a conflict via source-rank. Returns null on a tie so the caller
 * can move on to the next rule.
 */
export function sourceRankDecide(
  pair: ConflictPair,
  context: SourceRankContext = {},
): DecisionOutcome | null {
  const depthA = context.depthA ?? 0;
  const depthB = context.depthB ?? 0;
  const rankA = sourceRank(pair.a, depthA);
  const rankB = sourceRank(pair.b, depthB);
  if (rankA === rankB) return null;
  if (rankA > rankB) {
    return {
      kind: 'winner',
      winner: pair.a.id,
      loser: pair.b.id,
      reason: `source-rank a=${rankA} > b=${rankB} (depthA=${depthA}, depthB=${depthB})`,
    };
  }
  return {
    kind: 'winner',
    winner: pair.b.id,
    loser: pair.a.id,
    reason: `source-rank b=${rankB} > a=${rankA} (depthA=${depthA}, depthB=${depthB})`,
  };
}
