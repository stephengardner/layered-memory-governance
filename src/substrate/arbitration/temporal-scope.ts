/**
 * Temporal-scope rule.
 *
 * If the detector classifies the conflict as "temporal", both atoms may
 * apply correctly at different times. For V0 we keep both atoms in the
 * store without marking either as superseded; retrieval-time temporal
 * filtering is the consumer's responsibility.
 *
 * Future V1: record an explicit `valid_until` hint on the older atom via
 * an AtomPatch signaling a time fence.
 */

import type { ConflictPair, DecisionOutcome } from './types.js';

export function temporalScopeDecide(pair: ConflictPair): DecisionOutcome | null {
  if (pair.kind !== 'temporal') return null;
  return {
    kind: 'coexist',
    reason: `temporal scope: atoms apply at different times (detector: ${pair.explanation})`,
  };
}
