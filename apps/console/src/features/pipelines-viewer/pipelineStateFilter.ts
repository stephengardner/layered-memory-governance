/*
 * Pipeline-state bucket filter. Mirrors the plans bucket filter
 * (`features/plans-viewer/planStateFilter.ts`) so the chip-row UX is
 * identical across the two surfaces.
 *
 * Buckets:
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
 * is different.
 */

export const PIPELINE_FILTER_STORAGE_KEY = 'pipeline-state-filter';

export type PipelineStateBucket =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'all';

export const DEFAULT_PIPELINE_FILTER: PipelineStateBucket = 'all';

export function bucketForPipelineState(
  state: string | null | undefined,
): PipelineStateBucket {
  if (state === 'running' || state === 'pending') return 'running';
  if (state === 'hil-paused') return 'paused';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  // Unrecognized / null / future state. Keep it OUT of running so the
  // Running chip does not over-count a new state like 'cancelled'
  // before the UI ships a real chip for it.
  return 'unknown';
}

export function matchesBucket(
  state: string | null | undefined,
  bucket: PipelineStateBucket,
): boolean {
  if (bucket === 'all') return true;
  return bucketForPipelineState(state) === bucket;
}

/*
 * Validate a value (string from storage) against the union. Returns
 * the bucket if valid, else null. Caller decides the fallback.
 */
export function normalizeBucket(value: unknown): PipelineStateBucket | null {
  if (
    value === 'running'
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
