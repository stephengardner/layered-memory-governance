/**
 * Public surface of the planning-pipeline substrate.
 *
 *   import {
 *     runPipeline,
 *     mkPipelineAtom,
 *     readPipelineStagesPolicy,
 *   } from 'layered-autonomous-governance/planning-pipeline';
 *
 * Re-exports the consumer-facing symbols only. Internal helpers in the
 * individual files (atom-builders shared between shape factories, policy
 * iteration helpers, runner-internal failure shorthands) are not part of
 * this surface and stay file-local.
 */

export type {
  PlanningStage,
  StageInput,
  StageOutput,
  StageContext,
  AuditFinding,
  RetryStrategy,
} from './types.js';

export {
  mkPipelineAtom,
  mkPipelineStageEventAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineResumeAtom,
  mkPipelineCrossStageRepromptAtom,
  mkSpecAtom,
  mkBrainstormOutputAtom,
  mkSpecOutputAtom,
  mkReviewReportAtom,
  mkDispatchRecordAtom,
  mkPlanOutputAtoms,
  serializeStageOutput,
  projectStageOutputForMetadata,
  MAX_STAGE_OUTPUT_CONTENT,
  PIPELINE_STATE_VALUES,
} from './atom-shapes.js';
export type {
  PipelineStateLabel,
  MkPipelineAtomInput,
  MkSpecAtomInput,
  MkPipelineStageEventAtomInput,
  MkPipelineAuditFindingAtomInput,
  MkPipelineFailedAtomInput,
  MkPipelineResumeAtomInput,
  MkPipelineCrossStageRepromptAtomInput,
  CrossStageRepromptFindingShape,
  MkStageOutputAtomBaseInput,
  MkPlanOutputAtomsInput,
  CanonAuditFindingShape,
} from './atom-shapes.js';

export { runPipeline } from './runner.js';
export type { RunPipelineOptions, PipelineResult } from './runner.js';

export {
  readPipelineStagesPolicy,
  readPipelineStageHilPolicy,
  readPipelineDefaultModePolicy,
  readDispatchInvokerDefaultPolicy,
  readPipelineStageCostCapPolicy,
  readPipelineStageImplementationsPolicy,
} from './policy.js';
export type {
  StageDescriptor,
  PipelineStagesPolicyResult,
  PipelineStageHilPolicyResult,
  PipelineDefaultModePolicyResult,
  DispatchInvokerDefaultPolicyResult,
  PipelineStageCostCapPolicyResult,
  PipelineStageImplementationsPolicyResult,
  PipelineStageImplementationMode,
} from './policy.js';

export {
  evaluatePipelinePlanAutoApproval,
  runPipelinePlanAutoApproval,
} from './auto-approve.js';
export type {
  PlanAutoApprovalEvaluation,
  PlanAutoApprovalEvaluatorInput,
  RunPipelinePlanAutoApprovalOptions,
  RunPipelinePlanAutoApprovalResult,
} from './auto-approve.js';

export {
  decideRePromptAction,
  buildRePromptContext,
} from './auditor-feedback-reprompt.js';
export type {
  AuditorFeedbackRePromptConfig,
  RePromptAction,
} from './auditor-feedback-reprompt.js';
export {
  HARDCODED_DEFAULT as AUDITOR_FEEDBACK_REPROMPT_HARDCODED_DEFAULT,
  readAuditorFeedbackRePromptPolicy,
} from './auditor-feedback-reprompt-config.js';

export {
  decideValidatorRetryAction,
  buildValidatorRetryContext,
} from './plan-stage-validator-retry.js';
export type {
  PlanStageValidatorRetryConfig,
  ValidatorRetryAction,
} from './plan-stage-validator-retry.js';
export {
  HARDCODED_DEFAULT as PLAN_STAGE_VALIDATOR_RETRY_HARDCODED_DEFAULT,
  readPlanStageValidatorRetryPolicy,
} from './plan-stage-validator-retry-config.js';

export {
  DERIVE_FROM_PIPELINE_COMPOSITION,
  HARDCODED_DEFAULT as CROSS_STAGE_REPROMPT_HARDCODED_DEFAULT,
  readCrossStageRePromptPolicy,
} from './cross-stage-reprompt-config.js';
export type { CrossStageRePromptConfig } from './cross-stage-reprompt-config.js';
