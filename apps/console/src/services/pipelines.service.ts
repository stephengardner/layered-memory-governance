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

import type {
  PipelineDetail,
  PipelineListResult,
  PipelineLiveOpsResult,
} from '../../server/pipelines-types';
import type { PipelineLifecycle } from '../../server/pipeline-lifecycle-types';

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
