/**
 * Plan state machine.
 *
 * Plans (atoms with type='plan') have an execution state separate from
 * the L0-L3 trust axis. This file defines the valid transitions and the
 * transition helper that:
 *   1. Validates the transition against the state machine.
 *   2. Patches the atom via host.atoms.update.
 *   3. Writes an audit event.
 *
 * Terminal states (succeeded / failed / abandoned) cannot transition.
 * Callers that want to "restart" a terminal plan propose a new plan
 * atom instead, with `derived_from: [oldPlanId]` so the lineage is
 * preserved.
 */

import type { Host } from '../substrate/interface.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../substrate/types.js';

const ALLOWED: Readonly<Record<PlanState, ReadonlyArray<PlanState>>> = Object.freeze({
  proposed: ['approved', 'abandoned'],
  approved: ['executing', 'abandoned'],
  executing: ['succeeded', 'failed', 'abandoned'],
  succeeded: [],
  failed: [],
  abandoned: [],
});

export class InvalidPlanTransitionError extends Error {
  constructor(
    public readonly from: PlanState | undefined,
    public readonly to: PlanState,
    public readonly atomId: AtomId,
  ) {
    super(
      from === undefined
        ? `Cannot transition non-plan atom ${String(atomId)} to ${to}`
        : `Invalid plan transition for ${String(atomId)}: ${from} -> ${to}. Allowed from ${from}: ${ALLOWED[from].join(', ') || '(terminal)'}`,
    );
    this.name = 'InvalidPlanTransitionError';
  }
}

/**
 * Pure: is the transition allowed by the state machine? Use this when
 * you only want to test validity without side effects.
 */
export function canTransition(from: PlanState | undefined, to: PlanState): boolean {
  if (from === undefined) return false;
  return ALLOWED[from].includes(to);
}

/**
 * Transition a plan atom to a new state. Validates against the machine,
 * patches the atom, and emits an audit event. Throws on invalid
 * transitions; callers that want a predicate check should use
 * `canTransition` first.
 */
export async function transitionPlanState(
  atomId: AtomId,
  newState: PlanState,
  host: Host,
  principalId: PrincipalId,
  reason?: string,
): Promise<Atom> {
  const atom = await host.atoms.get(atomId);
  if (!atom) {
    throw new Error(`Plan atom not found: ${String(atomId)}`);
  }
  if (atom.type !== 'plan') {
    throw new InvalidPlanTransitionError(undefined, newState, atomId);
  }
  if (!canTransition(atom.plan_state, newState)) {
    throw new InvalidPlanTransitionError(atom.plan_state, newState, atomId);
  }

  const updated = await host.atoms.update(atomId, { plan_state: newState });

  await host.auditor.log({
    kind: 'plan.state_transition',
    principal_id: principalId,
    timestamp: host.clock.now() as Time,
    refs: { atom_ids: [atomId] },
    details: {
      from: atom.plan_state,
      to: newState,
      reason: reason ?? '',
    },
  });

  return updated;
}
