/**
 * Plan primitive: intent governance.
 *
 * A plan is an atom with `type: 'plan'` and a `plan_state` lifecycle:
 *   proposed -> approved -> executing -> succeeded | failed | abandoned
 *
 * This module exposes two primitives:
 *   - validatePlan(): checks a plan against L3 canon via the
 *     arbitration stack; returns conflicts (if any) before execution.
 *   - transitionPlanState(): moves a plan between lifecycle states with
 *     audit logging and state-machine validation.
 *
 * Composing these two with a Notifier gives the full governance loop:
 *   1. Agent writes a plan atom at layer L1 with plan_state='proposed'.
 *   2. validatePlan() runs. If conflicts found, caller telegraphs an
 *      escalation via host.notifier; HIL reviews and either approves
 *      (transition to 'approved') or asks for revision (the plan atom
 *      is abandoned and a new one takes its place).
 *   3. On approval, caller transitions to 'executing' and dispatches
 *      the steps (execution is orchestrated outside LAG).
 *   4. On completion, caller transitions to 'succeeded' / 'failed' and
 *      writes outcome atoms with `derived_from: [planId]` so the
 *      lineage back to the intent is preserved.
 */

export {
  canTransition,
  transitionPlanState,
  InvalidPlanTransitionError,
} from './state.js';
export {
  validatePlan,
  summarizeValidation,
  type PlanValidationStatus,
  type PlanValidationResult,
  type PlanConflict,
  type ValidatePlanOptions,
} from './validate.js';
export {
  executePlan,
  type ExecutePlanOptions,
  type ExecutionResult,
  type ExecutionReport,
  type ExecutionOutcomeAtom,
} from './execute.js';
export {
  classifyPlan,
  classifyPlans,
  applyReap,
  loadAllProposedPlans,
  runReaperSweep,
  DEFAULT_REAPER_TTLS,
  REAPER_PAGE_SIZE,
  REAPER_PAGE_LIMIT,
} from './reaper.js';
export type {
  ReaperTtls,
  ReaperBucket,
  ReaperClassification,
  ReaperClassifications,
  ReapApplyResult,
  LoadAllProposedPlansResult,
  RunReaperSweepResult,
} from './reaper.js';
