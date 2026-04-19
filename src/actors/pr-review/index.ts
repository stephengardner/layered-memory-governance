/**
 * PrReview (subpath: `/actors/pr-review`).
 *
 * Shared PR-review abstraction: the `PrReviewAdapter` interface + one
 * reference implementation (GitHub via gh CLI). Any actor that needs to
 * read, reply to, or resolve PR review comments depends on this module.
 *
 * Import the interface (vendor-agnostic):
 *
 *   import type { PrReviewAdapter } from 'layered-autonomous-governance/actors/pr-review';
 *
 * Import the GitHub implementation (opts in to the gh CLI):
 *
 *   import { GitHubPrReviewAdapter } from 'layered-autonomous-governance/actors/pr-review';
 *   import { createGhClient } from 'layered-autonomous-governance/external/github';
 */

export type {
  PrCommentOutcome,
  PrIdentifier,
  PrReviewAdapter,
  ReviewComment,
  ReviewCommentSeverity,
  ReviewReplyOutcome,
} from './adapter.js';
export { GitHubPrReviewAdapter } from './github.js';
export type { GitHubPrReviewAdapterOptions } from './github.js';
