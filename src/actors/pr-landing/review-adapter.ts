/**
 * PrReviewAdapter: the vendor-agnostic interface a PR review system must
 * satisfy for PrLandingActor to drive it.
 *
 * Concrete implementations (CodeRabbit via gh CLI, GitHub Copilot review,
 * a stub for tests) live in separate files and satisfy this shape.
 *
 * This file is deliberately free of any vendor-specific detail. The
 * adapter pattern (D17) says actor-scoped adapters declare their own
 * boundary; this is where PrLanding's boundary lives.
 */

import type { ActorAdapter } from '../types.js';

export type ReviewCommentSeverity = 'nit' | 'suggestion' | 'architectural' | 'blocking';

export interface ReviewComment {
  readonly id: string;
  readonly author: string;
  readonly path?: string;
  readonly line?: number;
  readonly body: string;
  readonly createdAt: string;
  /** Provider-assigned classification, if any. PrLandingActor may override. */
  readonly severity?: ReviewCommentSeverity;
  readonly resolved: boolean;
}

export interface ReviewReplyOutcome {
  readonly commentId: string;
  readonly replyId?: string;
  readonly posted: boolean;
}

export interface PrIdentifier {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface PrReviewAdapter extends ActorAdapter {
  /** List review comments that are currently unresolved for the PR. */
  listUnresolvedComments(pr: PrIdentifier): Promise<ReadonlyArray<ReviewComment>>;

  /** Post a reply to a specific review comment. */
  replyToComment(pr: PrIdentifier, commentId: string, body: string): Promise<ReviewReplyOutcome>;

  /**
   * Mark a comment as resolved (if the provider supports it). Should be
   * idempotent.
   */
  resolveComment(pr: PrIdentifier, commentId: string): Promise<void>;
}
