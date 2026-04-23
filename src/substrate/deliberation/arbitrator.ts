/**
 * Deliberation arbitrator.
 *
 * Thin pattern layer on top of the existing source-rank primitive
 * (`src/substrate/arbitration/source-rank.ts`). The coordinator calls
 * `shouldConclude` after each round to decide whether to stop the
 * dialogue, and `decide` when the round loop ends to pick a winner
 * from the posted Positions.
 *
 * Positions and Counters are not full Atoms; the arbitrator synthesizes
 * minimal Atom shapes to feed into `sourceRank`. The synthetic atoms
 * are internal implementation detail, never persisted. All Positions
 * posted in a single deliberation share layer, provenance, and
 * confidence by default so that arbitration reduces to principal-
 * hierarchy comparison (via `principalDepths` passed by the caller).
 * Callers wanting richer behaviour (e.g. different confidence per
 * position) can pass `positionOverrides` to tune the synthetic atoms.
 *
 * Returning null from `decide` signals the caller to emit an
 * Escalation rather than a Decision. This is the soft-tier human
 * gate described in the design spec.
 */

import type { Atom, AtomId, Layer, PrincipalId, ProvenanceKind } from '../types.js';
import { sourceRank } from '../arbitration/source-rank.js';
import type { Counter, Decision, Position } from './patterns.js';

export interface DecideOptions {
  /**
   * Depth of each participant principal from the root. Used as the
   * source-rank tiebreaker when positions share layer, provenance, and
   * confidence. Missing keys default to 0 (treated as root).
   */
  readonly principalDepths?: Readonly<Record<string, number>>;
  /**
   * Per-position overrides for the synthetic Atom fed to `sourceRank`.
   * Default: layer='L1', provenance.kind='agent-inferred', confidence=1.0.
   * Keyed by Position.id.
   */
  readonly positionOverrides?: Readonly<
    Record<
      string,
      { layer?: Layer; provenanceKind?: ProvenanceKind; confidence?: number }
    >
  >;
}

/**
 * True when the round loop should stop: either a single position was
 * posted, or all but one position has been rebutted by a counter.
 * False on zero positions (nothing to decide yet) or when every
 * position has been rebutted (indeterminate - let caller escalate or
 * run another round).
 */
export function shouldConclude(
  positions: readonly Position[],
  counters: readonly Counter[],
): boolean {
  if (positions.length === 0) return false;
  const rebutted = new Set(counters.map((c) => c.inResponseTo));
  const unrebutted = positions.filter((p) => !rebutted.has(p.id));
  return unrebutted.length === 1;
}

/**
 * Pick a winning Position and return a Decision. Returns null when no
 * positions have been posted (caller should escalate). Prefers
 * unrebutted positions; within them, breaks ties via source-rank
 * (layer -> provenance -> principal depth -> confidence).
 */
export function decide(
  questionId: string,
  positions: readonly Position[],
  counters: readonly Counter[],
  decidingPrincipal: string,
  options: DecideOptions = {},
): Decision | null {
  if (positions.length === 0) return null;

  const rebutted = new Set(counters.map((c) => c.inResponseTo));
  const unrebutted = positions.filter((p) => !rebutted.has(p.id));
  const candidates = unrebutted.length > 0 ? unrebutted : [...positions];

  const scored = candidates.map((p) => {
    const override = options.positionOverrides?.[p.id];
    const atom = synthesizePositionAtom(p, override);
    const depth = options.principalDepths?.[p.authorPrincipal] ?? 0;
    return { position: p, rank: sourceRank(atom, depth) };
  });

  scored.sort((a, b) => b.rank - a.rank);

  // Tie at top: bail out; caller should escalate.
  const [winner, runnerUp] = scored;
  if (!winner) return null;
  if (runnerUp && runnerUp.rank === winner.rank) return null;

  const trace = renderTrace(positions, counters, winner.position.id);

  return {
    id: `dec-${questionId}`,
    type: 'decision',
    resolving: questionId,
    answer: winner.position.answer,
    arbitrationTrace: trace,
    authorPrincipal: decidingPrincipal,
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function renderTrace(
  positions: readonly Position[],
  counters: readonly Counter[],
  winnerId: string,
): string {
  const posList = positions.map((p) => p.id).join(', ');
  const ctrList = counters.length === 0 ? 'none' : counters.map((c) => c.id).join(', ');
  return `positions: [${posList}]; counters: [${ctrList}]; winner: ${winnerId} (source-rank)`;
}

/**
 * Build a minimal synthetic Atom from a Position so it can be scored
 * by the existing `sourceRank` primitive. The synthetic atom is never
 * persisted; it's a view over the Position for scoring purposes.
 *
 * Defaults:
 *   - layer: L1 (extracted, as a new claim arising from a deliberation round)
 *   - provenance.kind: 'agent-inferred'
 *   - confidence: 1.0 (a posted Position is a stated stance)
 */
function synthesizePositionAtom(
  p: Position,
  override?: { layer?: Layer; provenanceKind?: ProvenanceKind; confidence?: number },
): Atom {
  const layer: Layer = override?.layer ?? 'L1';
  const provenanceKind: ProvenanceKind = override?.provenanceKind ?? 'agent-inferred';
  const confidence = override?.confidence ?? 1.0;
  return {
    schema_version: 1,
    id: p.id as AtomId,
    content: p.answer,
    type: 'observation',
    layer,
    provenance: {
      kind: provenanceKind,
      source: { agent_id: p.authorPrincipal },
      derived_from: p.derivedFrom.map((id) => id as AtomId),
    },
    confidence,
    created_at: p.created_at,
    last_reinforced_at: p.created_at,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: p.authorPrincipal as PrincipalId,
    taint: 'clean',
    metadata: {},
  };
}
