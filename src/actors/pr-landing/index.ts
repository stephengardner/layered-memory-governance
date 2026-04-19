/**
 * PrLandingActor and its PrReviewAdapter interface (Phase 53a reference
 * implementation).
 *
 * Subpath import:
 *
 *   import { PrLandingActor } from 'layered-autonomous-governance/actors/pr-landing';
 *
 * This is a reference Actor using the actor primitive. It demonstrates
 * the shape end-to-end; LAG does not prescribe that you use it.
 * Concrete PrReviewAdapter implementations (CodeRabbit via gh CLI,
 * Copilot review, etc.) are shipped separately and plugged in at
 * runActor time.
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
export type {
  PrIdentifier,
  PrReviewAdapter,
  ReviewComment,
  ReviewCommentSeverity,
  ReviewReplyOutcome,
} from './review-adapter.js';
