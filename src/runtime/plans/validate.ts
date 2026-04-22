/**
 * Pre-execution plan validation.
 *
 * A plan is an intent to act. Before execution, we check the plan atom
 * against existing L3 canon using the SAME arbitration stack that
 * resolves conflicting memories. If the plan's content contradicts an
 * L3 invariant, execution is blocked until either the plan is revised
 * or the conflicting canon atom is superseded.
 *
 * This is the load-bearing piece that makes plans governed rather than
 * just proposed. Without it, an agent can execute a plan that violates
 * the org's settled invariants and only realize after the damage.
 *
 * Scope: by default, a plan is checked against L3 canon in the same
 * scope (e.g. a scope='project' plan is checked against project-scope
 * canon). Callers wanting a wider or narrower check pass an explicit
 * `canonFilter`.
 */

import { arbitrate } from '../../arbitration/index.js';
import type { ConflictPair, Decision } from '../../arbitration/types.js';
import type { Host } from '../../interface.js';
import type { Atom, AtomFilter, PrincipalId } from '../../types.js';

export interface ValidatePlanOptions {
  /**
   * Principal id used when arbitrate() emits audit events while
   * checking conflicts. Should be the same id running the validation,
   * typically the agent that authored the plan or the governance loop.
   */
  readonly principalId: PrincipalId;
  /**
   * Override the canon filter used to pull candidate conflict atoms.
   * Defaults to `{ layer: ['L3'], scope: [plan.scope] }`. Pass
   * `{ layer: ['L3'] }` to check against all scopes (useful for
   * scope='global' plans).
   */
  readonly canonFilter?: AtomFilter;
  /**
   * Max canon atoms to scan. Defaults to 500. Safety ceiling so a
   * pathological canon does not stall a validation pass.
   */
  readonly maxCanonAtoms?: number;
}

export type PlanValidationStatus = 'clean' | 'conflicts';

export interface PlanConflict {
  readonly canonAtomId: Atom['id'];
  readonly canonContent: string;
  readonly decision: Decision;
}

export interface PlanValidationResult {
  readonly status: PlanValidationStatus;
  readonly conflicts: ReadonlyArray<PlanConflict>;
  readonly scanned: number;
}

/**
 * Run the plan through the arbitration stack against each L3 canon atom
 * in scope. Returns a result describing conflicts found (if any). Does
 * NOT mutate the plan's state; callers decide how to react (escalate
 * via notifier, transition plan to `abandoned`, revise and retry).
 *
 * Non-conflict decisions (detector 'none', temporal-scope coexist) do
 * not count as conflicts. Only `winner`/`escalate-no-winner` outcomes
 * or `coexist` outcomes from a detector kind other than 'none' do.
 */
export async function validatePlan(
  plan: Atom,
  host: Host,
  options: ValidatePlanOptions,
): Promise<PlanValidationResult> {
  if (plan.type !== 'plan') {
    throw new Error(`validatePlan: atom ${String(plan.id)} is not a plan (type=${plan.type})`);
  }

  const filter: AtomFilter = options.canonFilter ?? {
    layer: ['L3'],
    scope: [plan.scope],
  };
  const max = options.maxCanonAtoms ?? 500;

  const page = await host.atoms.query(filter, max);
  const conflicts: PlanConflict[] = [];
  let scanned = 0;

  for (const canonAtom of page.atoms) {
    if (canonAtom.id === plan.id) continue; // skip self
    if (canonAtom.taint !== 'clean') continue; // skip tainted / quarantined canon
    scanned += 1;

    const decision = await arbitrate(plan, canonAtom, host, {
      principalId: options.principalId,
    });

    if (isConflict(decision)) {
      conflicts.push({
        canonAtomId: canonAtom.id,
        canonContent: canonAtom.content,
        decision,
      });
    }
  }

  return {
    status: conflicts.length === 0 ? 'clean' : 'conflicts',
    conflicts,
    scanned,
  };
}

function isConflict(decision: Decision): boolean {
  // Detector said no conflict at all: plan compatible.
  if (decision.pair.kind === 'none') return false;
  // Detector classified the relationship as temporal (different time
  // windows, both true). The plan does not block even if source-rank
  // would have picked one as winner; the semantic judgment from the
  // detector takes precedence for validation purposes.
  if (decision.pair.kind === 'temporal') return false;
  // Semantic conflict regardless of outcome: winner, escalate-no-
  // winner, or coexist-from-semantic all need human attention.
  return true;
}

/**
 * Summarize a validation result as a human-readable string suitable
 * for an escalation event body or an audit log `details` field.
 */
export function summarizeValidation(result: PlanValidationResult): string {
  if (result.status === 'clean') {
    return `Plan validation: CLEAN (${result.scanned} canon atoms scanned, no conflicts)`;
  }
  const lines = [
    `Plan validation: ${result.conflicts.length} conflict(s) against L3 canon.`,
  ];
  for (const c of result.conflicts) {
    lines.push(`  - ${String(c.canonAtomId)}: ${c.canonContent}`);
    lines.push(`    decision: ${c.decision.ruleApplied} -> ${c.decision.outcome.kind}`);
  }
  return lines.join('\n');
}

// Re-export for callers that want the conflict detail type.
export type { ConflictPair };
