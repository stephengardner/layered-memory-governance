/*
 * Pure projection: plan atom -> plan_state lifecycle steps.
 *
 * The plan-dispatcher (src/runtime/actor-message/plan-dispatch.ts)
 * stamps four metadata fields when a plan crosses each plan_state
 * boundary:
 *
 *   - approved_at         (set by intent-approve / multi-reviewer flow)
 *   - executing_at        (set by runDispatchTick on approved -> executing)
 *   - executing_invoker   (set by runDispatchTick alongside executing_at)
 *   - terminal_at         (set on succeeded | failed)
 *   - terminal_kind       ('succeeded' | 'failed')
 *   - error_message       (truncated, set only on terminal_kind === 'failed')
 *
 * The plan atom's own `created_at` carries the proposed_at timestamp.
 *
 * The console renders these as a focused four-step timeline
 * (Proposed -> Approved -> Executing -> Terminal) on the plan-detail
 * view so an operator sees the plan_state transitions without grepping
 * the metadata.
 *
 * This file holds the pure projection so it stays vitest-friendly
 * (no DOM, no fs, no fetch). The wider `handlePlanLifecycle` in
 * `index.ts` consumes the same input atom and stitches in the
 * adjacent atom-chain shape; the two projections are deliberately
 * separated so each renders independently and the focused timeline
 * doesn't have to know about pr-observation / settled atoms.
 */
import { readString } from './projection-helpers.js';

/**
 * Minimal slice of an atom this projection consumes. Keeping the
 * input shape narrow means the unit test fixtures don't have to
 * fabricate the entire Atom envelope every time, and the function
 * can be reused without coupling to the server's full Atom type.
 */
export interface PlanAtomSlice {
  readonly id: string;
  readonly created_at: string;
  readonly principal_id: string;
  readonly plan_state: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type PlanStateLifecycleStepKind =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'terminal';

export type PlanStateLifecycleStepStatus =
  | 'reached'
  | 'pending'
  | 'skipped';

/**
 * One row in the focused plan_state lifecycle timeline.
 *
 *   - kind:   which boundary this row represents.
 *   - status: 'reached' if the plan landed on this boundary; 'pending'
 *             if the plan is still upstream of it; 'skipped' if the
 *             plan terminated without crossing it (e.g. proposed plans
 *             that never made it to approved). The UI renders pending
 *             as outlined/muted, reached as full color, skipped as
 *             dashed/gray.
 *   - at:     ISO-8601 timestamp the boundary stamped, or null if
 *             pending / skipped.
 *   - by:     principal that signed the transition. For 'proposed' the
 *             plan's own principal_id; for 'executing' the dispatcher's
 *             metadata.executing_invoker (the sub-actor it dispatched
 *             to); for terminal we report the dispatcher posture
 *             ('plan-dispatcher') because the dispatcher is the writer
 *             of terminal_at; null when the row hasn't been reached.
 *   - terminal_kind:    'succeeded' | 'failed', only on the terminal
 *                       row when reached, otherwise null.
 *   - error_message:    truncated halt reason, only on a failed
 *                       terminal row, otherwise null.
 */
export interface PlanStateLifecycleStep {
  readonly kind: PlanStateLifecycleStepKind;
  readonly status: PlanStateLifecycleStepStatus;
  readonly at: string | null;
  readonly by: string | null;
  readonly terminal_kind: 'succeeded' | 'failed' | null;
  readonly error_message: string | null;
}

export interface PlanStateLifecycle {
  readonly steps: ReadonlyArray<PlanStateLifecycleStep>;
}

/*
 * Plan_state vocabulary that always means the plan never advanced past
 * the proposed step. 'rejected' and 'abandoned' are legitimate terminal
 * states for plans that never crossed approved; they should NOT show
 * approved/executing as still-pending (that misleads the operator into
 * thinking the plan is still in flight).
 *
 * 'failed' is intentionally NOT in this set: a plan can fail AFTER
 * being approved (the dispatcher stamps approved_at, then registry.invoke
 * errors out and terminal_kind='failed'). Whether a 'failed' plan is
 * "terminated before approved" depends on whether approved_at was
 * stamped. The buildPlanStateLifecycle resolver checks that condition
 * directly rather than collapsing 'failed' into this set.
 */
const TERMINATED_BEFORE_APPROVED = new Set(['rejected', 'abandoned']);

/*
 * Plan_state values that signal an unambiguous terminal transition.
 * Terminal_at is the dispatcher's stamp for these; if it's missing,
 * we still render the row as reached so a legacy atom missing the
 * pre-#270 stamps doesn't disappear from the timeline.
 */
const TERMINAL_STATES = new Set(['succeeded', 'failed']);

/**
 * Build the focused four-step plan_state lifecycle for a single plan
 * atom. Pure: no I/O, no globals, no time. Deterministic for a given
 * input atom.
 */
export function buildPlanStateLifecycle(plan: PlanAtomSlice): PlanStateLifecycle {
  const meta = plan.metadata;
  const state = plan.plan_state;
  const approvedAt = readString(meta, 'approved_at');
  const executingAt = readString(meta, 'executing_at');
  const executingInvoker = readString(meta, 'executing_invoker');
  const terminalAt = readString(meta, 'terminal_at');
  const terminalKindRaw = readString(meta, 'terminal_kind');
  const errorMessage = readString(meta, 'error_message');

  // Normalize terminal_kind to the typed union. A legacy/garbage value
  // collapses to null so the UI does not paint a misleading green tick
  // for a state it cannot interpret.
  const terminalKind: 'succeeded' | 'failed' | null =
    terminalKindRaw === 'succeeded' || terminalKindRaw === 'failed'
      ? terminalKindRaw
      : null;

  /*
   * Step 1: proposed. Always reached -- the atom existing IS the
   * proposed transition. The plan's own created_at is the proposed_at
   * stamp by definition; the principal who signed the atom is the
   * proposer.
   */
  const proposed: PlanStateLifecycleStep = {
    kind: 'proposed',
    status: 'reached',
    at: plan.created_at,
    by: plan.principal_id,
    terminal_kind: null,
    error_message: null,
  };

  /*
   * Step 2: approved. Reached when metadata.approved_at is present.
   * Skipped when the plan terminated without ever passing approval:
   *   - state is 'rejected' or 'abandoned' (per TERMINATED_BEFORE_APPROVED), OR
   *   - state is 'failed' AND approved_at was never stamped (a pre-approval
   *     halt, e.g. an approval-flow error before envelope match).
   * Pending otherwise. The 'by' for approved is intentionally null in v0:
   * the substrate has multiple approval paths (operator-intent envelope,
   * multi-reviewer policy, manual /decide) and the metadata stamp does
   * not carry a single "approver" field today; surfacing a fabricated
   * literal would be a lie. We pass null and the UI renders the
   * approval row without a principal pill rather than guess.
   */
  const approvedReached = approvedAt !== null;
  const failedBeforeApproved = state === 'failed' && !approvedReached;
  const approvedSkipped = !approvedReached
    && state !== null
    && (TERMINATED_BEFORE_APPROVED.has(state) || failedBeforeApproved);
  const approved: PlanStateLifecycleStep = {
    kind: 'approved',
    status: approvedReached ? 'reached' : approvedSkipped ? 'skipped' : 'pending',
    at: approvedAt,
    by: null,
    terminal_kind: null,
    error_message: null,
  };

  /*
   * Step 3: executing. Reached when metadata.executing_at is present.
   * Skipped if the plan terminated without dispatch (a 'failed' plan
   * with terminal_at but NO executing_at reached terminal upstream
   * of dispatch, e.g. via a pre-dispatch policy error). Pending
   * otherwise. The 'by' is metadata.executing_invoker -- the
   * sub-actor the dispatcher handed off to, which is the most
   * informative attribution available at this boundary.
   */
  const executingReached = executingAt !== null;
  const terminalReachedNow = terminalAt !== null
    || (state !== null && TERMINAL_STATES.has(state));
  const executingSkipped = !executingReached && terminalReachedNow;
  const executing: PlanStateLifecycleStep = {
    kind: 'executing',
    status: executingReached
      ? 'reached'
      : executingSkipped
        ? 'skipped'
        : 'pending',
    at: executingAt,
    by: executingInvoker,
    terminal_kind: null,
    error_message: null,
  };

  /*
   * Step 4: terminal. Reached when metadata.terminal_at is present
   * OR plan_state is in TERMINAL_STATES (covers legacy atoms that
   * predate the #270 stamps but did transition to succeeded/failed).
   * 'pending' when the plan is still in-flight; never 'skipped' --
   * a plan either reaches terminal or it doesn't, there's no third
   * door. The 'by' is the dispatcher posture; the actual writer of
   * terminal_at is plan-dispatcher per src/runtime/actor-message/
   * plan-dispatch.ts. error_message is surfaced ONLY when the
   * terminal_kind is 'failed' -- a succeeded plan should never
   * carry one and the projection refuses to show it even if a
   * malformed atom does.
   */
  // Synthesize a fallback terminal_kind when the legacy metadata is
  // missing but plan_state itself encodes the outcome. Pre-#270 atoms
  // don't carry terminal_kind; without this, the UI would render a
  // succeeded plan with status='reached' but terminal_kind=null and
  // the operator would see "terminal" without knowing the outcome.
  const fallbackTerminalKind: 'succeeded' | 'failed' | null =
    state === 'succeeded' || state === 'failed' ? state : null;
  const effectiveTerminalKind = terminalKind ?? fallbackTerminalKind;
  const terminalReached = terminalReachedNow;
  const terminal: PlanStateLifecycleStep = {
    kind: 'terminal',
    status: terminalReached ? 'reached' : 'pending',
    at: terminalAt,
    by: terminalReached ? 'plan-dispatcher' : null,
    terminal_kind: terminalReached ? effectiveTerminalKind : null,
    error_message: terminalReached && effectiveTerminalKind === 'failed'
      ? errorMessage
      : null,
  };

  return { steps: [proposed, approved, executing, terminal] };
}
