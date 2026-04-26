/**
 * Metrics-rollup service.
 *
 * Conference-demo dashboard digest. One call returns the autonomous-loop
 * health summary the operator wants at a glance:
 *   - atom volume (total + in-window)
 *   - plan counts by state + success rate
 *   - autonomous-loop counts in window (dispatched / succeeded / failed)
 *   - median drafter cost, median dispatch-to-merge, median CR rounds
 *   - recent failures (last 5) for click-through to /plan-lifecycle/<id>
 *
 * Server-stitched per-call so the browser never walks the atom set
 * itself; the contract `(window_hours) -> rollup` survives a Tauri
 * port unchanged. Read-only - this endpoint computes and returns; it
 * never writes.
 */

import { transport } from './transport';

export interface MetricsRollupFailure {
  readonly plan_id: string;
  readonly stage: string;
  readonly message_preview: string;
  readonly at: string;
}

export interface MetricsRollupPlans {
  readonly total: number;
  readonly by_state: Readonly<Record<string, number>>;
  readonly success_rate: number;
}

export interface MetricsRollupAutonomousLoop {
  readonly dispatched_in_window: number;
  readonly succeeded_in_window: number;
  readonly failed_in_window: number;
  readonly median_drafter_cost_usd: number | null;
  readonly median_dispatch_to_merge_minutes: number | null;
  readonly median_cr_rounds_per_pr: number | null;
}

export interface MetricsRollup {
  readonly window_hours: number;
  readonly atoms_total: number;
  readonly atoms_in_window: number;
  readonly plans: MetricsRollupPlans;
  readonly autonomous_loop: MetricsRollupAutonomousLoop;
  readonly recent_failures: ReadonlyArray<MetricsRollupFailure>;
}

export async function getMetricsRollup(
  windowHours = 24,
  signal?: AbortSignal,
): Promise<MetricsRollup> {
  return transport.call<MetricsRollup>(
    'metrics.rollup',
    { window_hours: windowHours },
    signal ? { signal } : undefined,
  );
}
