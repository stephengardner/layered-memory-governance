/**
 * Validation rule.
 *
 * If a validator can re-check an atom against ground truth, the atom that
 * checks out wins. Unverifiable atoms fall through to the next rule.
 *
 * Validators are registered per atom type / domain (e.g. filesystem, HTTP,
 * SQL). A registry holds them; the first non-"unverifiable" result for
 * each atom is used.
 */

import type { Host } from '../interface.js';
import type { Atom } from '../types.js';
import type { ConflictPair, DecisionOutcome } from './types.js';

export type ValidationResult = 'verified' | 'invalid' | 'unverifiable';

export type Validator = (atom: Atom, host: Host) => Promise<ValidationResult>;

export class ValidatorRegistry {
  private readonly validators: Validator[] = [];

  register(v: Validator): void {
    this.validators.push(v);
  }

  async validate(atom: Atom, host: Host): Promise<ValidationResult> {
    for (const v of this.validators) {
      const result = await v(atom, host);
      if (result !== 'unverifiable') return result;
    }
    return 'unverifiable';
  }

  size(): number {
    return this.validators.length;
  }
}

export async function validationDecide(
  pair: ConflictPair,
  registry: ValidatorRegistry,
  host: Host,
): Promise<DecisionOutcome | null> {
  if (registry.size() === 0) return null;
  const va = await registry.validate(pair.a, host);
  const vb = await registry.validate(pair.b, host);

  // Only conclusive opposite results decide a winner. An 'unverifiable'
  // side means missing validator coverage, not a negative vote, and must
  // fall through so the next rule can try. (Module JSDoc: "Unverifiable
  // atoms fall through to the next rule.")
  if (va === 'verified' && vb === 'invalid') {
    return {
      kind: 'winner',
      winner: pair.a.id,
      loser: pair.b.id,
      reason: `validation: a verified, b ${vb}`,
    };
  }
  if (vb === 'verified' && va === 'invalid') {
    return {
      kind: 'winner',
      winner: pair.b.id,
      loser: pair.a.id,
      reason: `validation: b verified, a ${va}`,
    };
  }
  // Ties, matching categories, or either side unverifiable: inconclusive.
  return null;
}
