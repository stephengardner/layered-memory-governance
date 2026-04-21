/**
 * Promotion module types.
 *
 * Promotion moves an atom upward through the trust layers: L1 -> L2 -> L3.
 * Gated by confidence, consensus (distinct principals observing the same
 * content), and validation (if a validator registry is provided).
 *
 * Implementation detail: promotion CREATES a new atom at the target layer
 * with provenance.kind = 'canon-promoted' and derived_from = [original_id].
 * The original atom is marked superseded_by the new atom. This preserves
 * provenance and keeps Atom.layer immutable in line with the interface
 * contract.
 */

import type { Atom, AtomId, Layer, PrincipalId } from '../substrate/types.js';
import type { ValidationResult } from '../arbitration/validation.js';

export type PromotableLayer = 'L2' | 'L3';

export interface PromotionCandidate {
  /** The highest-ranked atom in a content-hash class. */
  readonly atom: Atom;
  /** Distinct principals that have emitted atoms in this content-hash class. */
  readonly consensusCount: number;
  /** The atoms that constitute the class (including `atom`). */
  readonly consensusAtoms: ReadonlyArray<Atom>;
  /** Validator registry's verdict on the candidate atom. */
  readonly validation: ValidationResult;
}

export interface LayerThresholds {
  readonly minConfidence: number;
  readonly minConsensus: number;
  /** If true, validation !== 'invalid' is required. */
  readonly requireValidation: boolean;
  /** If true, L3 requires human approval via the Notifier. */
  readonly requireHumanApproval?: boolean;
}

export interface PromotionThresholds {
  readonly L2: LayerThresholds;
  readonly L3: LayerThresholds;
}

export const DEFAULT_THRESHOLDS: PromotionThresholds = {
  L2: {
    minConfidence: 0.7,
    minConsensus: 2,
    requireValidation: false,
  },
  L3: {
    minConfidence: 0.9,
    minConsensus: 3,
    requireValidation: true,
    requireHumanApproval: true,
  },
};

export interface PromotionDecision {
  readonly candidate: PromotionCandidate;
  readonly targetLayer: PromotableLayer;
  readonly canPromote: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export type PromotionOutcomeKind =
  | 'promoted'
  | 'rejected-by-policy'
  | 'rejected-by-human'
  | 'timed-out-awaiting-human';

export interface PromotionOutcome {
  readonly decision: PromotionDecision;
  readonly kind: PromotionOutcomeKind;
  /** ID of the new atom created at the target layer, if promoted. */
  readonly promotedAtomId: AtomId | null;
  /** Reason describing the outcome (for audit). */
  readonly reason: string;
  /** For L3 outcomes that escalated, the responder principal. */
  readonly responderId?: PrincipalId;
}

/** Source layer for a given promotion target. */
export function sourceLayerFor(target: PromotableLayer): Layer {
  return target === 'L2' ? 'L1' : 'L2';
}
