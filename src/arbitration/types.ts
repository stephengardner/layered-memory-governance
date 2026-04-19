/**
 * Arbitration types.
 *
 * Arbitration resolves semantic conflicts between atoms BEFORE they both
 * sit in the store claiming to be true. It is the write-time safety net
 * that prevents "contradictory high-confidence atoms" (north-star criterion).
 */

import type { Atom, AtomId } from '../types.js';

export type ConflictKind =
  /** Contradictory claims that cannot both be true in the same context. */
  | 'semantic'
  /** Claims that disagree but may apply to different time windows. */
  | 'temporal'
  /** Detector deemed the atoms compatible or unrelated. */
  | 'none';

export interface ConflictPair {
  readonly a: Atom;
  readonly b: Atom;
  readonly kind: ConflictKind;
  readonly explanation: string;
}

export type DecisionOutcome =
  /** One atom wins; the other is superseded. */
  | {
      readonly kind: 'winner';
      readonly winner: AtomId;
      readonly loser: AtomId;
      readonly reason: string;
    }
  /** Both atoms retained; e.g. temporal fencing or inconclusive arbitration. */
  | {
      readonly kind: 'coexist';
      readonly reason: string;
    }
  /** Kicked upstairs; a human or higher authority decides. */
  | {
      readonly kind: 'escalate';
      readonly reason: string;
    };

export type ArbiterRule =
  | 'source-rank'
  | 'temporal-scope'
  | 'validation'
  | 'escalation'
  | 'none';

export interface Decision {
  readonly pair: ConflictPair;
  readonly outcome: DecisionOutcome;
  readonly ruleApplied: ArbiterRule;
}
