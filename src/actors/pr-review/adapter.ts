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

/**
 * Where the comment originated.
 *
 * 'line': a threaded line-level review comment. Replyable + resolvable.
 * 'body-nit': an item extracted from a reviewer's review-body markdown
 *   (e.g., CodeRabbit's `🧹 Nitpick comments (N)` collapsible block).
 *   NOT replyable or resolvable individually — the body is a single
 *   review object on GitHub's side; items inside it are observed-only.
 *   Consumers (including pr-landing) must branch on `kind` before
 *   proposing reply/resolve actions against a body-nit.
 *
 * Defaults to 'line' when absent, which keeps all existing call sites
 * backward-compatible.
 */
export type ReviewCommentKind = 'line' | 'body-nit';

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
  /**
   * Origin of the comment. Absent ≡ 'line' (back-compat default).
   */
  readonly kind?: ReviewCommentKind;
  /**
   * Unified-diff text of a `♻️ Proposed fix` block found in the comment
   * body (or extracted from a body-nit). Present when the reviewer
   * posted an applyable diff; undefined otherwise. Consumers can copy
   * the text straight into `git apply`. No leading/trailing fenced-code
   * markers; just diff text.
   */
  readonly proposedFix?: string;
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

  /**
   * List items that live inside reviewers' review-body markdown rather
   * than as individual line comments. Today this covers CodeRabbit's
   * `🧹 Nitpick comments (N)` collapsible block; a shared abstraction
   * waits for a second concrete reviewer format (YAGNI until then).
   *
   * Returned items carry `kind: 'body-nit'` and have no threadId; they
   * are observed-only and cannot be replied to or resolved in isolation.
   * pr-landing surfaces them through the operator-escalation path
   * instead of the reply/resolve path.
   *
   * Adapters that do not consume a reviewer with body-scoped nits can
   * return an empty array.
   */
  listReviewBodyNits(pr: PrIdentifier): Promise<ReadonlyArray<ReviewComment>>;
}

export interface PrCommentOutcome {
  readonly commentId?: string;
  readonly posted: boolean;
  readonly dryRun?: boolean;
}
