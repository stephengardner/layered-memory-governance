/*
 * Single source of truth for the TRUE-outcome a pill should reflect.
 *
 * `plan_state` and `pipeline_state` are necessary inputs but not
 * sufficient: a plan that classified as `succeeded` while the
 * dispatch produced ZERO PRs is not actually a success the operator
 * should read as green. The operator stated 2026-05-07: "a plan
 * should also not show a succeeded green pill if it failed to
 * dispatch." This module derives a TRUE-outcome label that combines
 * the substrate state with the dispatch counters so render sites can
 * paint the pill the same way every time.
 *
 * Inputs:
 *   - plan_state          : from plan atoms (proposed/approved/.../succeeded)
 *   - pipeline_state      : from pipeline atoms (pending/running/.../completed)
 *   - dispatch_summary    : { dispatched, failed } counts when known
 *
 * Outputs (`TrueOutcome`):
 *   - 'succeeded'   : substrate said success AND dispatch >= 1 PR
 *   - 'noop'        : substrate said success BUT dispatch produced no
 *                     PRs (silent-skip / drafter-empty-diff / existence
 *                     gate). The operator-facing render is amber, not
 *                     green, so a "ran without effect" outcome is
 *                     visually distinct from "ran and shipped".
 *   - 'failed'      : substrate said failure OR dispatch counters carry
 *                     a non-zero failed bucket
 *   - 'paused'      : HIL pause held the chain
 *   - 'in-progress' : proposed / approved / executing / pending / running
 *   - 'unknown'     : missing data or a state the console hasn't mirrored
 *                     yet (forward-compat: do not throw, fall through to
 *                     a neutral pill so a new substrate vocabulary still
 *                     renders something)
 *
 * Render sites import `deriveTrueOutcome` + `trueOutcomeTone` rather
 * than reading plan_state directly so a future substrate state added
 * without an entry here surfaces as `unknown` (neutral pill) instead
 * of silently painting the wrong tone.
 */

export type TrueOutcome =
  | 'succeeded'
  | 'noop'
  | 'failed'
  | 'paused'
  | 'in-progress'
  | 'unknown';

export interface DispatchSummaryShape {
  readonly dispatched?: number | null | undefined;
  readonly failed?: number | null | undefined;
}

export interface DeriveTrueOutcomeArgs {
  readonly plan_state?: string | null | undefined;
  readonly pipeline_state?: string | null | undefined;
  readonly dispatch_summary?: DispatchSummaryShape | null | undefined;
}

/*
 * State buckets shared across plan_state and pipeline_state vocabularies.
 * Keeping these as Sets so a contributor adding a new substrate state
 * has one obvious place to register the bucket without re-reading the
 * derive function body.
 *
 * Notes:
 *   - 'completed' is the pipeline-level analogue of plan_state
 *     'succeeded'. Both gate on dispatch counters before rendering green.
 *   - 'abandoned' lands in `failed` (terminal-negative) rather than
 *     `unknown` because the operator-facing render of an abandoned plan
 *     should be a danger pill, not a neutral one.
 *   - 'rejected' is also danger-toned (arbitration veto).
 */
const SUCCESS_STATES: ReadonlySet<string> = new Set(['succeeded', 'completed']);
const FAILED_STATES: ReadonlySet<string> = new Set([
  'failed',
  'abandoned',
  'rejected',
]);
const PAUSED_STATES: ReadonlySet<string> = new Set(['paused', 'hil-paused']);
const IN_PROGRESS_STATES: ReadonlySet<string> = new Set([
  'proposed',
  'approved',
  'executing',
  'pending',
  'running',
  'draft',
]);

/*
 * Resolve the TRUE outcome from plan_state + pipeline_state +
 * dispatch_summary. Precedence:
 *
 *   1. Any non-zero `dispatch_summary.failed` flips to 'failed' even
 *      when plan_state says succeeded -- a partial dispatch counts as a
 *      failure surface for the operator.
 *   2. Substrate-said-failed states ('failed' / 'abandoned' / 'rejected')
 *      collapse to 'failed'.
 *   3. Substrate-said-paused states collapse to 'paused'.
 *   4. Substrate-said-succeeded states gate on dispatch counters: when
 *      `dispatched >= 1` -> 'succeeded'; when `dispatched === 0`
 *      (or no dispatch summary present at all on a succeeded plan)
 *      -> 'noop'. The "no dispatch info but succeeded" path defaults
 *      to noop because at the surfaces this matters for, the
 *      dispatch-record atom is the source of truth for "PR opened" and
 *      its absence is informative -- a plan that genuinely shipped a PR
 *      always has a dispatch record on the chain.
 *   5. In-progress states collapse to 'in-progress'.
 *   6. Anything else -> 'unknown'.
 *
 * The `dispatched === 0` branch is deliberately strict: a plan with
 * `succeeded` state but `dispatched === 0` is the bug this whole
 * helper exists to fix.
 */
export function deriveTrueOutcome(args: DeriveTrueOutcomeArgs): TrueOutcome {
  const planRaw = typeof args.plan_state === 'string' ? args.plan_state : null;
  const pipelineRaw = typeof args.pipeline_state === 'string'
    ? args.pipeline_state
    : null;
  const dispatch = args.dispatch_summary ?? null;
  const dispatchedCount = typeof dispatch?.dispatched === 'number'
    ? dispatch.dispatched
    : null;
  const failedCount = typeof dispatch?.failed === 'number'
    ? dispatch.failed
    : null;

  // Rule 1: any non-zero failed bucket is a failure surface regardless
  // of plan_state. Catches the partial-dispatch case where the
  // dispatcher attempted N invocations and one halted.
  if (failedCount !== null && failedCount > 0) {
    return 'failed';
  }

  // Pick whichever substrate-state is set (plan and pipeline never
  // both apply to the same atom); plan wins on ambiguous input so a
  // plan-shaped consumer is unambiguous.
  const state = planRaw ?? pipelineRaw;

  if (state !== null && FAILED_STATES.has(state)) {
    return 'failed';
  }

  if (state !== null && PAUSED_STATES.has(state)) {
    return 'paused';
  }

  if (state !== null && SUCCESS_STATES.has(state)) {
    // dispatch !== null means we have a dispatch summary in hand.
    // dispatched > 0 means the substrate produced at least one PR.
    if (dispatchedCount !== null && dispatchedCount > 0) {
      return 'succeeded';
    }
    // If dispatched === 0 OR there's no dispatch summary at all, the
    // surface treats this as noop. The "no summary" branch matches the
    // bug: plan_state landed at succeeded but the chain produced no PR
    // (dispatch_result.summary contained 'silent-skip' / 'empty-diff'
    // and the dispatcher failed to emit a count). The amber pill makes
    // "ran without effect" visually distinct from "ran and shipped".
    return 'noop';
  }

  if (state !== null && IN_PROGRESS_STATES.has(state)) {
    return 'in-progress';
  }

  return 'unknown';
}

/*
 * Resolve the CSS tone for a TRUE outcome. Mirrors the shape of
 * planStateTone / pipelineStateTone so call sites that already use
 * `style={{ borderColor: tone, color: tone }}` need no other changes.
 *
 * Tones:
 *   - succeeded   -> --status-success (green)
 *   - noop        -> --status-warning (amber)  ← distinct from green
 *   - failed      -> --status-danger  (red)
 *   - paused      -> --status-warning (amber)  ← matches HIL convention
 *   - in-progress -> --status-info    (blue)
 *   - unknown     -> --text-secondary (neutral)
 *
 * Both `noop` and `paused` resolve to amber but they are distinct
 * states; the pill text differs ('noop' vs 'paused'), and the operator
 * reads them as different stories. Same color is intentional: both are
 * "operator attention without being terminal".
 */
export function trueOutcomeTone(outcome: TrueOutcome): string {
  switch (outcome) {
    case 'succeeded':
      return 'var(--status-success)';
    case 'noop':
      return 'var(--status-warning)';
    case 'failed':
      return 'var(--status-danger)';
    case 'paused':
      return 'var(--status-warning)';
    case 'in-progress':
      return 'var(--status-info)';
    case 'unknown':
    default:
      return 'var(--text-secondary)';
  }
}

/*
 * Pull a `DispatchSummaryShape` out of an atom's metadata bag. The
 * substrate emits two carriers:
 *
 *   - On a plan atom: `metadata.dispatch_result.kind === 'completed'`
 *     means the dispatcher ran. The plan atom doesn't carry counters
 *     directly today; `dispatch_result.summary` text mentions
 *     'silent-skip' or 'empty-diff' for the dispatched===0 case. We
 *     pattern-match the summary string to derive `dispatched: 0` so
 *     the surface treats those plans as noop without a substrate
 *     change.
 *
 *   - On a pipeline summary projection: a `dispatch_summary` field
 *     server-side that mirrors the dispatch-record atom counts.
 *
 * For the plan path, an explicit `dispatch_result.kind === 'error'`
 * carries `failed === 1` so the rule-1 short-circuit fires.
 */
export function readPlanDispatchSummary(
  metadata: unknown,
): DispatchSummaryShape | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const meta = metadata as Record<string, unknown>;
  const result = meta['dispatch_result'];
  if (result === null || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  const kind = typeof obj['kind'] === 'string' ? (obj['kind'] as string) : null;
  const summary = typeof obj['summary'] === 'string'
    ? (obj['summary'] as string)
    : '';

  // 'error' kind is a dispatcher failure: count it as failed=1 so the
  // rule-1 short-circuit flips the pill to red rather than the noop
  // path painting amber.
  if (kind === 'error') {
    return { dispatched: 0, failed: 1 };
  }

  // 'completed' kind means the dispatch chain ran end-to-end; the
  // summary string carries the 'silent-skip' or 'empty-diff' marker
  // when the executor produced no PR. Without those markers we treat
  // the dispatch as a real ship (dispatched: 1).
  if (kind === 'completed') {
    const lowered = summary.toLowerCase();
    const isNoop = lowered.includes('silent-skip')
      || lowered.includes('empty-diff')
      || lowered.includes('empty diff')
      || lowered.includes('no-op')
      || lowered.includes('noop');
    return isNoop
      ? { dispatched: 0, failed: 0 }
      : { dispatched: 1, failed: 0 };
  }

  return null;
}
