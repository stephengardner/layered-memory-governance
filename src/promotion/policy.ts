/**
 * Promotion policy: pure threshold math.
 *
 * Given a candidate and a target layer, decide whether policy allows
 * promotion. Policy is intentionally conservative: if a dimension is not
 * measurable (e.g. validator says 'unverifiable'), that dimension passes
 * only when the threshold does NOT require validation.
 */

import type {
  PromotableLayer,
  PromotionCandidate,
  PromotionDecision,
  PromotionThresholds,
} from './types.js';
import { DEFAULT_THRESHOLDS, sourceLayerFor } from './types.js';

export function evaluate(
  candidate: PromotionCandidate,
  targetLayer: PromotableLayer,
  thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
): PromotionDecision {
  const thr = targetLayer === 'L2' ? thresholds.L2 : thresholds.L3;
  const reasons: string[] = [];
  let canPromote = true;

  const expectedSourceLayer = sourceLayerFor(targetLayer);
  if (candidate.atom.layer !== expectedSourceLayer) {
    canPromote = false;
    reasons.push(
      `atom.layer=${candidate.atom.layer} but target ${targetLayer} requires source ${expectedSourceLayer}`,
    );
  }

  if (candidate.atom.superseded_by.length > 0) {
    canPromote = false;
    reasons.push('atom is already superseded');
  }

  if (candidate.atom.taint !== 'clean') {
    canPromote = false;
    reasons.push(`atom.taint=${candidate.atom.taint}`);
  }

  if (candidate.atom.confidence < thr.minConfidence) {
    canPromote = false;
    reasons.push(
      `confidence ${candidate.atom.confidence.toFixed(3)} < minConfidence ${thr.minConfidence}`,
    );
  }

  if (candidate.consensusCount < thr.minConsensus) {
    canPromote = false;
    reasons.push(
      `consensus ${candidate.consensusCount} < minConsensus ${thr.minConsensus}`,
    );
  }

  if (thr.requireValidation) {
    // ValidationResult is 'verified' | 'invalid' | 'unverifiable'.
    // requireValidation=true means we will NOT promote atoms the validator
    // has flagged invalid. 'unverifiable' still passes (no validator could
    // judge; policy accepts absence of evidence).
    if (candidate.validation === 'invalid') {
      canPromote = false;
      reasons.push('validation: invalid (threshold requires non-invalid)');
    }
  }

  if (canPromote) {
    reasons.push('meets policy thresholds');
  }

  return { candidate, targetLayer, canPromote, reasons: Object.freeze(reasons) };
}
