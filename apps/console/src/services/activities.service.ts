import { transport } from './transport';
import type { CanonAtom } from './canon.service';

/*
 * Activity = any atom across layers/types, sorted by created_at desc.
 * Server-side filter keeps superseded atoms out. Client passes
 * optional limit (default 100) and type filter.
 */
export type Activity = CanonAtom;

export interface ListActivitiesParams {
  readonly limit?: number;
  readonly types?: ReadonlyArray<string>;
}

export async function listActivities(
  params?: ListActivitiesParams,
  signal?: AbortSignal,
): Promise<ReadonlyArray<Activity>> {
  return transport.call<ReadonlyArray<Activity>>(
    'activities.list',
    params as Record<string, unknown> | undefined,
    signal ? { signal } : undefined,
  );
}
