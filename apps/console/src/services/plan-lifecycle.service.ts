/**
 * Plan-lifecycle service.
 *
 * One call → the whole autonomous-loop chain for a single plan,
 * stitched server-side from atoms with no client-side correlation.
 * The PlanLifecycleView consumes the structured response directly;
 * components do NOT call transport themselves.
 *
 * Why server-stitched and not client-derived:
 *   - The atom set is ~thousands of files; correlating intent →
 *     plan → invoked → pr-observation → settled in the browser would
 *     require pulling everything down per render. The server already
 *     keeps an in-memory atom index; it can answer in O(N).
 *   - The contract `(plan_id) → lifecycle` survives a future swap to
 *     a Tauri host that uses Rust handlers — the response shape is
 *     transport-agnostic.
 */

import { transport } from './transport';

export type PlanLifecyclePhase =
  | 'deliberation'
  | 'approval'
  | 'dispatch'
  | 'observation'
  | 'merge'
  | 'settled';

export interface PlanLifecycleTransition {
  readonly phase: PlanLifecyclePhase;
  readonly label: string;
  readonly at: string;
  readonly by: string;
  readonly atom_id: string;
}

export interface PlanLifecyclePlan {
  readonly id: string;
  readonly content: string;
  readonly plan_state: string | null;
  readonly principal_id: string;
  readonly created_at: string;
  readonly layer: string;
}

export interface PlanLifecycleIntent {
  readonly id: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
}

export interface PlanLifecycleApproval {
  readonly policy_atom_id: string | null;
  readonly approved_at: string;
  readonly approved_intent_id: string | null;
}

export interface PlanLifecycleDispatch {
  readonly atom_id: string | null;
  readonly pr_number: number | null;
  readonly pr_html_url: string | null;
  readonly branch_name: string | null;
  readonly commit_sha: string | null;
  readonly model: string | null;
  readonly total_cost_usd: number | null;
  readonly confidence: number | null;
  readonly dispatched_at: string;
  readonly principal_id: string;
}

export interface PlanLifecycleObservation {
  readonly atom_id: string;
  readonly head_sha: string | null;
  readonly mergeable: string | null;
  readonly merge_state_status: string | null;
  readonly pr_state: string | null;
  readonly observed_at: string;
}

export interface PlanLifecycleSettled {
  readonly atom_id: string;
  readonly target_plan_state: string | null;
  readonly settled_at: string;
  readonly pr_state: string | null;
}

export interface PlanLifecycle {
  readonly plan: PlanLifecyclePlan | null;
  readonly intent: PlanLifecycleIntent | null;
  readonly approval: PlanLifecycleApproval | null;
  readonly dispatch: PlanLifecycleDispatch | null;
  readonly observation: PlanLifecycleObservation | null;
  readonly settled: PlanLifecycleSettled | null;
  readonly transitions: ReadonlyArray<PlanLifecycleTransition>;
}

export async function getPlanLifecycle(
  planId: string,
  signal?: AbortSignal,
): Promise<PlanLifecycle> {
  return transport.call<PlanLifecycle>(
    'plan.lifecycle',
    { plan_id: planId },
    signal ? { signal } : undefined,
  );
}
