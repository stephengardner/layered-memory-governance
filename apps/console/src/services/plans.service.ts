import { transport } from './transport';
import type { CanonAtom } from './canon.service';

/*
 * Plan = atom with type='plan' OR with a top-level plan_state field
 * (arch-plan-state-top-level-field). Server does the filter.
 */
export interface PlanAtom extends CanonAtom {
  readonly plan_state?: string;
}

export async function listPlans(signal?: AbortSignal): Promise<ReadonlyArray<PlanAtom>> {
  return transport.call<ReadonlyArray<PlanAtom>>(
    'plans.list',
    undefined,
    signal ? { signal } : undefined,
  );
}
