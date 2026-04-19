/**
 * PrReviewAdapter: the vendor-agnostic interface a PR review system must
 * satisfy for any LAG actor that consumes PR reviews.
 *
 * Moved from src/actors/pr-landing/review-adapter.ts so it can be shared
 * across multiple actors (pr-landing today; pr-auditor, pr-merger-gate,
 * stale-pr-reminder in the future). Per the "reusable composable code"
 * principle, an interface consumed by >= 1 concrete actor lives in a
 * shared location.
 *
 * Subpath import:
 *   import type { PrReviewAdapter } from 'layered-autonomous-governance/actors/pr-review';
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
  /** Provider-assigned classification, if any. Consumers may override. */
  readonly severity?: ReviewCommentSeverity;
  readonly resolved: boolean;
  /**
   * Vendor-scoped thread identifier. Adapters that key resolve operations
   * by thread (GitHub, GitLab) populate this; adapters that key by
   * comment id can leave it undefined.
   */
  readonly threadId?: string;
}

export interface ReviewReplyOutcome {
  readonly commentId: string;
  readonly replyId?: string;
  readonly posted: boolean;
  readonly dryRun?: boolean;
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

  /** Mark the thread that contains `commentId` as resolved. Idempotent. */
  resolveComment(pr: PrIdentifier, commentId: string): Promise<void>;

  /**
   * Check whether any of the given reviewer logins has posted ANY
   * review comment OR top-level PR comment on this PR. Used to detect
   * "the reviewer bot never ran" and prompt it explicitly. Read-only;
   * safe to call in dry-run.
   */
  hasReviewerEngaged(
    pr: PrIdentifier,
    authorLogins: ReadonlyArray<string>,
  ): Promise<boolean>;

  /**
   * Post a top-level PR comment (not a threaded review reply). Used
   * to prompt a reviewer bot (e.g., `@coderabbitai review`) or to
   * surface anything that is not inline on a diff. Honors dryRun.
   */
  postPrComment(pr: PrIdentifier, body: string): Promise<PrCommentOutcome>;
}

export interface PrCommentOutcome {
  readonly commentId?: string;
  readonly posted: boolean;
  readonly dryRun?: boolean;
}
