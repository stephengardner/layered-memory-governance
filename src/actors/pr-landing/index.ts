/**
 * PrLandingActor (subpath: `/actors/pr-landing`).
 *
 * A reference outward Actor that drives a PR through review feedback to
 * a clean state. Composes with any `PrReviewAdapter` (from
 * `/actors/pr-review`).
 *
 * Subpath import:
 *
 *   import { PrLandingActor } from 'layered-autonomous-governance/actors/pr-landing';
 *   import { GitHubPrReviewAdapter } from 'layered-autonomous-governance/actors/pr-review';
 *
 * LAG does not prescribe that you use this actor. It is a reference
 * implementation demonstrating the shape end-to-end.
 */

export { PrLandingActor } from './pr-landing.js';
export type {
  PrLandingActionKind,
  PrLandingActionPayload,
  PrLandingAdapters,
  PrLandingObservation,
  PrLandingOptions,
  PrLandingOutcome,
} from './pr-landing.js';
