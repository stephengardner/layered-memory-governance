/**
 * PrFixActor (subpath: `/actors/pr-fix`).
 *
 * A reference outward Actor that drives a PR through CodeRabbit review
 * findings by dispatching agent-loop sub-runs against the PR's HEAD
 * branch and resolving threads on touched paths. Composes with the
 * agentic-actor-loop substrate (AgentLoopAdapter, WorkspaceProvider,
 * BlobStore, Redactor) and the existing `PrReviewAdapter`.
 *
 * Subpath import:
 *
 *   import { PrFixActor } from 'layered-autonomous-governance/actors/pr-fix';
 *
 * LAG does not prescribe that you use this actor. It is a reference
 * implementation demonstrating the agent-loop seam end-to-end.
 */

export { PrFixActor } from './pr-fix.js';
export type { PrFixOptions } from './pr-fix.js';
export type {
  PrFixObservation,
  PrFixClassification,
  PrFixAction,
  PrFixOutcome,
  PrFixAdapters,
} from './types.js';
export {
  mkPrFixObservationAtom,
  mkPrFixObservationAtomId,
  renderObservationContent,
} from './pr-fix-observation.js';
