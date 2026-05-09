/*
 * Pipeline-state bucket filter. Mirrors the plans bucket filter
 * (`features/plans-viewer/planStateFilter.ts`) so the chip-row UX is
 * identical across the two surfaces.
 *
 * Buckets:
 *   needs-attention -> failed OR hil-paused OR has_failed_atom OR
 *                       audit_counts.critical > 0 OR
 *                       dispatch_summary.failed > 0 OR
 *                       (completed AND dispatch_summary.dispatched === 0)
 *                      The actionable subset: every pipeline the
 *                      operator should look at right now. Composes
 *                      multiple substrate signals into one chip so the
 *                      operator does not have to scan four chips to
 *                      assemble the same picture.
 *   running   -> running OR pending (in-flight from the operator's POV)
 *   paused    -> hil-paused (operator decision required)
 *   completed -> completed (terminal success)
 *   failed    -> failed (terminal failure)
 *   unknown   -> any state we do NOT recognize (future state, malformed
 *                atom, etc.). Bucketed separately so the Running chip
 *                does not silently inflate when a new state ships.
 *   all       -> everything
 *
 * Default bucket is `all` because pipelines are intentionally rare;
 * filtering to a subset by default would hide most rows on the first
 * load. Plans use `active` because the volume + signal-noise ratio
 * is different. The `needs-attention` chip is OPT-IN: an operator
 * clicks it (or arrives via `?state=needs-attention`) when they want
 * the actionable subset.
 *
 * Note: `needs-attention` overlaps with `failed` and `paused`: a
 * failed pipeline counts in BOTH buckets. This is intentional.
 * Counts on the chip row are not mutually exclusive with respect to
 * needs-attention; the other five chips remain mutually exclusive.
 */

import type { PipelineSummary } from '@/services/pipelines.service';

export const PIPELINE_FILTER_STORAGE_KEY = 'pipeline-state-filter';
export const PIPELINE_FILTER_QUERY_KEY = 'state';

export type PipelineStateBucket =
  | 'needs-attention'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'all';

export const DEFAULT_PIPELINE_FILTER: PipelineStateBucket = 'all';

export function bucketForPipelineState(
  state: string | null | undefined,
): Exclude<PipelineStateBucket, 'needs-attention' | 'all'> {
  if (state === 'running' || state === 'pending') return 'running';
  if (state === 'hil-paused') return 'paused';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  // Unrecognized / null / future state. Keep it OUT of running so the
  // Running chip does not over-count a new state like 'cancelled'
  // before the UI ships a real chip for it.
  return 'unknown';
}

/*
 * Predicate: does this pipeline merit operator attention right now?
 *
 * The signals composed here are deliberately broader than `pipeline_state`
 * alone because the substrate spreads "needs-attention" across multiple
 * fields:
 *   - terminal-failure marker atoms surface via `has_failed_atom`
 *   - HIL pauses surface via `pipeline_state === 'hil-paused'`
 *   - critical audit findings surface via `audit_counts.critical`
 *   - partial-dispatch failures surface via `dispatch_summary.failed`
 *   - silent-skip / empty-diff completions surface via the
 *     `completed && dispatched === 0` shape (the noop case from
 *     dev-state-pill-true-outcome)
 *
 * A pipeline that's still running with no findings is NOT in this
 * bucket because it's in-flight, not stuck. The operator filters by
 * 'running' for that.
 */
export function pipelineNeedsAttention(p: PipelineSummary): boolean {
  if (p.pipeline_state === 'failed') return true;
  if (p.pipeline_state === 'hil-paused') return true;
  if (p.has_failed_atom) return true;
  if (p.audit_counts.critical > 0) return true;
  const ds = p.dispatch_summary;
  if (ds && ds.failed > 0) return true;
  if (p.pipeline_state === 'completed' && ds && ds.dispatched === 0) return true;
  return false;
}

/*
 * State-only `matchesBucket` retained for callers that already have a
 * raw `pipeline_state` string (e.g. tests, log analyzers). The
 * `needs-attention` bucket is NOT supported here because it requires
 * the full summary; calling with that bucket throws so a misuse fails
 * loud rather than silently mis-bucketing.
 */
export function matchesBucket(
  state: string | null | undefined,
  bucket: PipelineStateBucket,
): boolean {
  if (bucket === 'needs-attention') {
    throw new Error(
      "matchesBucket(state, 'needs-attention') is not supported -- "
      + 'the needs-attention bucket reads dispatch_summary + audit_counts '
      + '+ has_failed_atom. Call matchesPipelineBucket(pipeline, bucket) '
      + 'with the full PipelineSummary instead.',
    );
  }
  if (bucket === 'all') return true;
  return bucketForPipelineState(state) === bucket;
}

/*
 * Full-summary `matchesPipelineBucket`: the canonical predicate for
 * the chip-row UX. Reads pipeline_state for the exclusive buckets
 * (running / paused / completed / failed / unknown) and the broader
 * signals for `needs-attention`.
 */
export function matchesPipelineBucket(
  pipeline: PipelineSummary,
  bucket: PipelineStateBucket,
): boolean {
  if (bucket === 'all') return true;
  if (bucket === 'needs-attention') return pipelineNeedsAttention(pipeline);
  return bucketForPipelineState(pipeline.pipeline_state) === bucket;
}

/*
 * Validate a value (string from storage or URL) against the union.
 * Returns the bucket if valid, else null. Caller decides the fallback.
 */
export function normalizeBucket(value: unknown): PipelineStateBucket | null {
  if (
    value === 'needs-attention'
    || value === 'running'
    || value === 'paused'
    || value === 'completed'
    || value === 'failed'
    || value === 'unknown'
    || value === 'all'
  ) {
    return value;
  }
  return null;
}
