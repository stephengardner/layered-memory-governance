/*
 * Plan-state filter buckets.
 *
 * The Plans view rendered every plan_state in a flat masonry grid. With
 * 60+ plans across a long session that surface drowns in failed and
 * stale-proposed atoms, which an operator reads as "the system is
 * broken" even when the work shipped. The fix is a render-time bucket
 * filter with explicit chips so anything filtered remains one click
 * away; the default bucket is documented near DEFAULT_PLAN_FILTER below.
 *
 * Buckets follow operator mental model rather than the substrate
 * vocabulary one-to-one:
 *   - active    -> in-flight work the operator might want to act on
 *                  (proposed, approved, executing, draft, pending)
 *                  PLUS unknown so a missing plan_state never silently
 *                  vanishes from the default surface
 *   - succeeded -> terminal good
 *   - failed    -> terminal bad of any flavor (failed, abandoned,
 *                  rejected) so the operator sees one combined number
 *                  and one chip click to triage
 *   - all       -> escape hatch for "I want everything"
 *
 * The default is `all` so completed work surfaces alongside in-flight
 * work without an extra click; operator grievance 2026-04-28 was
 * "plans show as approved, not completed" because the prior `active`
 * default hid the succeeded bucket entirely. The chips still let the
 * operator narrow to a specific bucket and the choice persists via
 * storage.service so a triage session does not snap back on reload.
 */

export type PlanStateBucket = 'active' | 'succeeded' | 'failed' | 'all';

export const PLAN_FILTER_STORAGE_KEY = 'plans-filter-bucket';
export const DEFAULT_PLAN_FILTER: PlanStateBucket = 'all';

const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'proposed',
  'approved',
  'executing',
  'draft',
  'pending',
]);

const FAILED_STATES: ReadonlySet<string> = new Set([
  'failed',
  'abandoned',
  'rejected',
]);

/*
 * Classify a plan_state into a bucket. Unknown / empty / missing
 * plan_state lands in `active` rather than disappearing — substrate
 * states are added over time and silently dropping a plan from the
 * default surface would be worse than rendering an extra row.
 */
export function bucketForPlanState(state: string | null | undefined): PlanStateBucket {
  if (typeof state !== 'string' || state.length === 0) return 'active';
  if (state === 'succeeded') return 'succeeded';
  if (FAILED_STATES.has(state)) return 'failed';
  if (ACTIVE_STATES.has(state)) return 'active';
  return 'active';
}

export function matchesBucket(
  state: string | null | undefined,
  bucket: PlanStateBucket,
): boolean {
  if (bucket === 'all') return true;
  return bucketForPlanState(state) === bucket;
}

/*
 * Coerce an arbitrary persisted value back into a known bucket.
 * Anything we don't recognise (missing key, corrupted localStorage,
 * a future bucket name written by a newer build) falls back to the
 * default rather than throwing, so the view stays live across version
 * skew.
 */
export function normalizeBucket(value: unknown): PlanStateBucket {
  if (value === 'active' || value === 'succeeded' || value === 'failed' || value === 'all') {
    return value;
  }
  return DEFAULT_PLAN_FILTER;
}
