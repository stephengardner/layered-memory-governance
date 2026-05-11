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
 *   - 403 pipeline-resume-no-policy : canon entry missing for stage
 *   - 403 pipeline-resume-forbidden : caller not in allowed_resumers
 *
 * Caller responsibility: supply the operator principal id via
 * `actor_id`. The session.service helper `requireActorId` is the
 * canonical pre-mutation guard; see KillSwitchPill for the pattern.
 */
export async function resumePipeline(
  params: { pipeline_id: string; actor_id: string; reason?: string },
  signal?: AbortSignal,
): Promise<PipelineResumeResult> {
  return transport.call<PipelineResumeResult>(
    'pipeline.resume',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}
