import { transport } from './transport';
import type { CanonAtom } from './canon.service';

/*
 * Activity = any atom across layers/types, sorted by created_at desc.
 * Server-side filter keeps superseded atoms out by default and hides
 * atoms whose `metadata.reaped_at` is set unless the caller opts in
 * via `include_reaped: true`. The wire shape returns both the visible
 * `atoms` array AND a `reaped_count` so the UI toggle can read
 * "Show reaped (N)" without a second roundtrip.
 *
 * Reaping is a projection-layer hide, not a substrate-layer fence:
 * single-atom reads (atoms.get, atoms.references, atoms.audit-chain)
 * still resolve to reaped atoms so a `derived_from` link from a live
 * atom navigates to the reaped ancestor. The toggle here only affects
 * the activities feed's default view.
 */
export type Activity = CanonAtom;

export interface ListActivitiesParams {
  readonly limit?: number;
  readonly types?: ReadonlyArray<string>;
  readonly include_reaped?: boolean;
}

export interface ActivitiesListResponse {
  readonly atoms: ReadonlyArray<Activity>;
  readonly reaped_count: number;
}

export async function listActivities(
  params?: ListActivitiesParams,
  signal?: AbortSignal,
): Promise<ActivitiesListResponse> {
  return transport.call<ActivitiesListResponse>(
    'activities.list',
    params as Record<string, unknown> | undefined,
    signal ? { signal } : undefined,
  );
}
