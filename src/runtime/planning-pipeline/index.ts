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
  mkSpecAtom,
  mkBrainstormOutputAtom,
  mkSpecOutputAtom,
  mkReviewReportAtom,
  mkDispatchRecordAtom,
  mkPlanOutputAtoms,
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
  MkStageOutputAtomBaseInput,
  MkPlanOutputAtomsInput,
} from './atom-shapes.js';

export { runPipeline } from './runner.js';
export type { RunPipelineOptions, PipelineResult } from './runner.js';

export {
  readPipelineStagesPolicy,
  readPipelineStageHilPolicy,
  readPipelineDefaultModePolicy,
  readPipelineStageCostCapPolicy,
} from './policy.js';
export type {
  StageDescriptor,
  PipelineStagesPolicyResult,
  PipelineStageHilPolicyResult,
  PipelineDefaultModePolicyResult,
  PipelineStageCostCapPolicyResult,
} from './policy.js';
