/**
 * Live Ops service: wraps /api/live-ops.snapshot.
 *
 * Single-call digest of the current state of the autonomous org so
 * the dashboard hits ONE endpoint on each 2s refresh tick. Splitting
 * into seven per-section endpoints would multiply the network cost
 * and risk inconsistent reads (each section observing a different
 * atom-store snapshot mid-tick).
 *
 * Wire-shape types are re-exported from `server/live-ops-types.ts`
 * (the authoritative source). Re-exporting rather than duplicating
 * eliminates the silent client/server drift hazard: a server-side
 * change (new field, narrower union) becomes a frontend type error
 * immediately instead of rendering `undefined` until someone
 * remembers to mirror the change.
 *
 * Read-only contract: this service exposes a single fetcher; no
 * write surface is built on top of /api/live-ops.snapshot.
 */

import { transport } from './transport';

export type {
  LiveOpsHeartbeat,
  LiveOpsActiveSession,
  LiveOpsLiveDeliberation,
  LiveOpsInFlightExecution,
  LiveOpsRecentTransition,
  LiveOpsActiveElevation,
  LiveOpsDaemonPosture,
  LiveOpsPrActivity,
  LiveOpsSnapshot,
} from '../../server/live-ops-types';

import type { LiveOpsSnapshot } from '../../server/live-ops-types';

export async function getLiveOpsSnapshot(signal?: AbortSignal): Promise<LiveOpsSnapshot> {
  return transport.call<LiveOpsSnapshot>(
    'live-ops.snapshot',
    undefined,
    signal ? { signal } : undefined,
  );
}
