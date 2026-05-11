/**
 * Pipelines service: wraps /api/pipelines.list, /api/pipelines.detail,
 * /api/pipelines.live-ops.
 *
 * One service per surface so the data-fetching contract for each view
 * stays small + auditable. Mirrors `plans.service.ts` (list) and
 * `plan-lifecycle.service.ts` (detail) shapes; consumers call the
 * exported functions inside TanStack Query hooks rather than going
 * direct to the transport.
 *
 * Wire-shape types are re-exported from `server/pipelines-types.ts`
 * (the authoritative source). Re-exporting rather than duplicating
 * the shapes eliminates the silent client/server drift hazard that
 * the live-ops surface already documents.
 *
 * Read-only contract: every call here is a query; no write surface
 * exists for pipelines yet (the substrate writes pipeline atoms; the
 * UI observes them).
 */

import { transport } from './transport';

export type {
  AgentTurnRow,
  PipelineAuditCounts,
  PipelineAuditFinding,
  PipelineAuditSeverity,
  PipelineDetail,
  PipelineFailureRecord,
  PipelineListResult,
  PipelineLiveOpsResult,
  PipelineLiveOpsRow,
  PipelineResumeRecord,
  PipelineStageEvent,
  PipelineStageState,
  PipelineStageSummary,
  PipelineSummary,
} from '../../server/pipelines-types';

export type {
  PipelineLifecycle,
  PipelineLifecycleCheckCounts,
  PipelineLifecycleCodeAuthorInvocation,
  PipelineLifecycleDispatchRecord,
  PipelineLifecycleMerge,
  PipelineLifecycleObservation,
} from '../../server/pipeline-lifecycle-types';

export type {
  IntentOutcome,
  IntentOutcomeSkipReason,
  IntentOutcomeState,
} from '../../server/intent-outcome-types';

import type {
  PipelineDetail,
  PipelineListResult,
  PipelineLiveOpsResult,
} from '../../server/pipelines-types';
import type { PipelineLifecycle } from '../../server/pipeline-lifecycle-types';
import type { IntentOutcome } from '../../server/intent-outcome-types';

export async function listPipelines(signal?: AbortSignal): Promise<PipelineListResult> {
  return transport.call<PipelineListResult>(
    'pipelines.list',
    undefined,
    signal ? { signal } : undefined,
  );
}

export async function getPipelineDetail(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<PipelineDetail> {
  return transport.call<PipelineDetail>(
    'pipelines.detail',
    { pipeline_id: pipelineId },
    signal ? { signal } : undefined,
  );
}

export async function listLiveOpsPipelines(
  signal?: AbortSignal,
): Promise<PipelineLiveOpsResult> {
  return transport.call<PipelineLiveOpsResult>(
    'pipelines.live-ops',
    undefined,
    signal ? { signal } : undefined,
  );
}

/**
 * Fetch the pipeline post-dispatch lifecycle chain: dispatch-record
 * counts, code-author-invoked observation, latest pr-observation, and
 * plan-merge-settled atom for the resolved plan id.
 *
 * Used by PipelineDetailView to render the "Post-dispatch lifecycle"
 * section below the existing stage timeline. Returns the full envelope
 * regardless of which downstream blocks are populated; the UI renders
 * progressively as each phase materializes.
 */
export async function getPipelineLifecycle(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<PipelineLifecycle> {
  return transport.call<PipelineLifecycle>(
    'pipelines.lifecycle',
    { pipeline_id: pipelineId },
    signal ? { signal } : undefined,
  );
}

/**
 * Fetch the synthesized intent-outcome for a pipeline. Aggregates the
 * pipeline + post-dispatch chain into a single state-pill + summary,
 * answering "did this intent ship a PR?" without forcing the operator
 * to scroll the stage strip and post-dispatch sections.
 *
 * Renders above the stage timeline on /pipelines/<id>.
 */
export async function getIntentOutcome(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<IntentOutcome> {
  return transport.call<IntentOutcome>(
    'pipeline.intent-outcome',
    { pipeline_id: pipelineId },
    signal ? { signal } : undefined,
  );
}

/**
 * Wire shape returned by `/api/pipeline.resume`. Mirrors the backend
 * `handleResumePipeline` return shape so a client deserializes
 * without an additional type layer.
 *
 * The substrate's runner picks up the unpause on its next tick per
 * `runtime/planning-pipeline/runner.ts`; the Console's role here is
 * (a) verify authority via the canon `pol-pipeline-stage-hil-<stage>`
 * gate and (b) write the audit atom + flip the pipeline_state so the
 * substrate sees a resumable atom. The response echoes the resolved
 * stage + minted atom id so the UI can confirm the substrate observed
 * the flip on the next poll cycle (the `resumes` list on
 * `/api/pipelines.detail` walks the same atom).
 */
export interface PipelineResumeResult {
  readonly pipeline_id: string;
  readonly stage_name: string;
  readonly resumer_principal_id: string;
  readonly resume_atom_id: string;
  readonly resumed_at: string;
}

/**
 * Lift an HIL-paused pipeline back to running. Server-side checks:
 *   - 404 pipeline-not-found        : id does not match a pipeline atom
 *   - 409 pipeline-not-paused       : already running, completed, or failed
 *   - 409 pipeline-resume-no-stage  : substrate invariant violated
 *   - 409 pipeline-resume-conflict  : pipeline moved out of hil-paused
 *                                     between validation and write
 *   - 403 pipeline-resume-no-policy : canon entry missing for stage
 *   - 403 pipeline-resume-forbidden : caller not in allowed_resumers
 *   - 500 server-actor-unset        : LAG_CONSOLE_ACTOR_ID not configured
 *
 * Identity binding: the resumer principal is derived server-side from
 * `LAG_CONSOLE_ACTOR_ID`; the client does NOT supply an `actor_id`.
 * Trusting a client-supplied identity for a canon-gated write would
 * let any caller who reaches the origin-allowed endpoint impersonate
 * any principal in `allowed_resumers` (CR PR #396 critical finding).
 * If a future deployment wants per-user resume gating, the substrate
 * must surface auth tokens upstream of the backend handler.
 */
export async function resumePipeline(
  params: { pipeline_id: string; reason?: string },
  signal?: AbortSignal,
): Promise<PipelineResumeResult> {
  return transport.call<PipelineResumeResult>(
    'pipeline.resume',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

/**
 * Wire shape returned by `/api/pipeline.abandon`. Mirrors the backend
 * `handleAbandonPipeline` return shape so a client deserializes
 * without an additional type layer.
 *
 * The substrate's runner observes the pipeline-abandoned atom on its
 * next stage-transition check per
 * `runtime/planning-pipeline/runner.ts` and halts cleanly before
 * dispatching the next stage. The Console's role is (a) verify
 * authority via the canon `pol-pipeline-abandon` gate, (b) write the
 * audit atom carrying the operator's reason, and (c) flip the
 * pipeline_state so the substrate observes the terminal state. The
 * response echoes the minted atom id so the UI can confirm the
 * substrate observed the flip on the next poll cycle.
 */
export interface PipelineAbandonResult {
  readonly pipeline_id: string;
  readonly abandoner_principal_id: string;
  readonly abandon_atom_id: string;
  readonly abandoned_at: string;
}

/**
 * Abandon a running or hil-paused pipeline. Server-side checks:
 *   - 400 reason-missing            : reason field absent or empty
 *   - 400 reason-too-short          : reason below the 10-char floor
 *   - 400 reason-too-long           : reason above the 500-char cap
 *   - 404 pipeline-not-found        : id does not match a pipeline atom
 *   - 409 pipeline-already-terminal : already abandoned, completed, or failed
 *   - 409 pipeline-abandon-conflict : pipeline moved into terminal state
 *                                     between validation and write
 *   - 403 pipeline-abandon-no-policy: canon pol-pipeline-abandon missing
 *   - 403 pipeline-abandon-forbidden: caller not in allowed_principals
 *   - 500 server-actor-unset        : LAG_CONSOLE_ACTOR_ID not configured
 *
 * Identity binding: the abandoner principal is derived server-side
 * from `LAG_CONSOLE_ACTOR_ID`; the client does NOT supply an
 * `actor_id`. Mirrors the pipeline.resume route's identity binding
 * (CR PR #396 critical finding); a forbidden caller cannot land an
 * audit atom on disk even when reaching the origin-allowed endpoint.
 *
 * The `reason` field is REQUIRED and forms part of the audit trail.
 * Per the substrate's reason-validation rung, an empty or whitespace-
 * only reason fails the 400 floor; trim is server-side so leading or
 * trailing whitespace does not count toward the minimum.
 */
export async function abandonPipeline(
  params: { pipeline_id: string; reason: string },
  signal?: AbortSignal,
): Promise<PipelineAbandonResult> {
  return transport.call<PipelineAbandonResult>(
    'pipeline.abandon',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

/*
 * Per-pipeline SSE stream wire shapes. These pin the contract with
 * the server's pipeline-stream module; the field names below must
 * match the payload builders in server/pipeline-stream.ts.
 *
 * Replaces the 5-second TanStack Query refetch on /pipelines/<id>
 * with push-based updates: the backend sends each event within
 * milliseconds of the watcher observing the corresponding atom write
 * (vs the up-to-5s lag of the polling baseline). The polling
 * fallback survives in PipelineDetailView for the case where the
 * EventSource fails to connect.
 */
export interface PipelineStreamAtomChange {
  readonly pipeline_id: string;
  readonly atom_id: string;
  readonly atom_type: string;
  readonly at: string;
}

export interface PipelineStreamPipelineStateChange {
  readonly pipeline_id: string;
  readonly pipeline_state: string | null;
  readonly at: string;
}

export interface PipelineStreamOpen {
  readonly pipeline_id: string;
  readonly at: string;
}

export interface PipelineStreamHandlers {
  readonly onOpen?: (ev: PipelineStreamOpen) => void;
  readonly onAtomChange?: (ev: PipelineStreamAtomChange) => void;
  readonly onPipelineStateChange?: (ev: PipelineStreamPipelineStateChange) => void;
  readonly onError?: (err: Error) => void;
}

/**
 * Subscribe to the per-pipeline SSE stream. Returns an unsubscribe
 * function the caller MUST invoke on component unmount or pipeline
 * change to free the underlying socket.
 *
 * Routes through the existing `transport.subscribe` seam so the
 * future Tauri port picks up the same channel naming convention with
 * zero call-site changes. The transport implementation handles
 * EventSource creation, named-event registration, and unsubscribe
 * cleanup.
 *
 * The single SSE callback is fanned out to four typed handlers by
 * payload shape: atom-change carries `atom_id`, pipeline-state-change
 * carries `pipeline_state`, open carries only `{pipeline_id, at}`,
 * and the heartbeat is intentionally swallowed (its only purpose is
 * to keep the connection alive through idle-timeout proxies).
 */
export function subscribeToPipelineStream(
  pipelineId: string,
  handlers: PipelineStreamHandlers,
): () => void {
  return transport.subscribe<unknown>(
    `pipeline.${pipelineId}`,
    (ev) => {
      if (typeof ev !== 'object' || ev === null) return;
      const record = ev as Record<string, unknown>;
      if (typeof record['pipeline_id'] !== 'string') return;
      /*
       * Defense in depth: even though the server only broadcasts
       * events for the matching pipeline_id, a misrouted or stale
       * payload (e.g. a future server bug, an in-flight connection
       * that was previously bound to a different id) must not patch
       * the wrong detail view's cache. Drop events whose payload
       * pipeline_id does not match the subscribed pipelineId.
       */
      if (record['pipeline_id'] !== pipelineId) return;

      if ('atom_id' in record && typeof record['atom_id'] === 'string') {
        handlers.onAtomChange?.(ev as PipelineStreamAtomChange);
        return;
      }
      if ('pipeline_state' in record) {
        handlers.onPipelineStateChange?.(ev as PipelineStreamPipelineStateChange);
        return;
      }
      // Lone {pipeline_id, at} is the open ack.
      if (typeof record['at'] === 'string') {
        handlers.onOpen?.(ev as PipelineStreamOpen);
      }
    },
    handlers.onError,
  );
}
