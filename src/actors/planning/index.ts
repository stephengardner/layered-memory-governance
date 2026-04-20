/**
 * PlanningActor subpath (Phase 55a).
 *
 * The CTO-role planning mechanism for LAG. Synthesizes Plan atoms
 * grounded in the org's canon + decisions + relevant atoms. Composes
 * with runActor from `/actors` for the driver + policy gate + audit.
 *
 *   import { PlanningActor } from 'layered-autonomous-governance/actors/planning';
 *   import { aggregateRelevantContext } from 'layered-autonomous-governance/actors/planning';
 *
 * 55b wires the real LLM-backed PlanningJudgment; 55c adds sub-actor
 * delegation so an approved plan can invoke PrLandingActor /
 * DeployActor / etc.
 */

export { PlanningActor } from './planning-actor.js';
export type {
  PlanningActionPayload,
  PlanningActorOptions,
  PlanningObservation,
  PlanningOutcome,
} from './planning-actor.js';
export { aggregateRelevantContext } from './aggregate-context.js';
export type { AggregateContextOptions } from './aggregate-context.js';
export {
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_MAX_BUDGET_USD_PER_CALL,
  HostLlmPlanningJudgment,
} from './host-llm-judgment.js';
export type { HostLlmPlanningJudgmentOptions } from './host-llm-judgment.js';
export type {
  PlanningClassification,
  PlanningClassificationKind,
  PlanningContext,
  PlanningJudgment,
  ProposedPlan,
} from './types.js';
