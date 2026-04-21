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
 *   NOT replyable or resolvable individually: the body is a single
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

  /**
   * Composite multi-surface read. Per canon directive
   * `dev-multi-surface-review-observation`, any actor observing PR
   * state MUST use this single call rather than polling individual
   * endpoints; partial reads are the root cause of silent-failure
   * bugs like the one observed in session 2026-04-20 where CR's
   * review completion landed on one surface but was missed because
   * the observer only read the legacy status API.
   *
   * Returns a point-in-time snapshot covering every surface that
   * can contribute to a merge/escalation decision: line comments,
   * body-nits, submitted reviews, check-runs, legacy statuses, and
   * GitHub's mergeStateStatus + mergeable flag. Per-surface fetch
   * failures degrade the snapshot to `partial: true` rather than
   * throwing, so callers can make an explicit choice about acting
   * on an incomplete view.
   */
  getPrReviewStatus(pr: PrIdentifier): Promise<PrReviewStatus>;
}

export interface PrCommentOutcome {
  readonly commentId?: string;
  readonly posted: boolean;
  readonly dryRun?: boolean;
}

/**
 * A composite snapshot of a PR's review state. Consumers that want
 * to answer "can I merge?" / "has my reviewer finished?" / "what is
 * unresolved?" read this one object instead of correlating five
 * separate API calls. See `dev-multi-surface-review-observation` in
 * canon for why partial snapshots are forbidden as a decision input
 * unless the specific missing surface is irrelevant to the decision.
 */
export interface PrReviewStatus {
  readonly pr: PrIdentifier;
  /** GitHub's mergeable boolean; null if GitHub has not computed it. */
  readonly mergeable: boolean | null;
  /**
   * GitHub's mergeStateStatus enum: CLEAN, BLOCKED, UNKNOWN, BEHIND,
   * DIRTY, DRAFT, HAS_HOOKS, UNSTABLE. BLOCKED with all checks green
   * typically means a required status check has not posted yet
   * (e.g., an external reviewer like CodeRabbit still thinking).
   * `null` when GitHub has not computed it.
   */
  readonly mergeStateStatus: string | null;
  /**
   * Line-level unresolved review comments. Same shape as
   * listUnresolvedComments; duplicated in this composite so a
   * caller never has to make a second call.
   */
  readonly lineComments: ReadonlyArray<ReviewComment>;
  /**
   * Body-scoped nits parsed from review bodies (e.g., CodeRabbit's
   * 🧹 block). Always read alongside lineComments to avoid silently
   * dropping nits.
   */
  readonly bodyNits: ReadonlyArray<ReviewComment>;
  /**
   * Submitted PR reviews: author + state (COMMENTED, APPROVED,
   * CHANGES_REQUESTED, DISMISSED) + submittedAt. The "review has
   * been submitted at all" signal that legacy status misses.
   */
  readonly submittedReviews: ReadonlyArray<SubmittedReview>;
  /**
   * Check-runs posted against the head commit. Modern replacement
   * for legacy statuses; most CI systems post here.
   */
  readonly checkRuns: ReadonlyArray<CheckRun>;
  /**
   * Legacy commit statuses (pre-Check-Runs API). Some services
   * still post only here (e.g., some CodeRabbit configurations).
   * Read both so we never miss the surface the blocking check
   * happens to live on.
   */
  readonly legacyStatuses: ReadonlyArray<LegacyStatus>;
  /**
   * When true, at least one surface failed to fetch and the snapshot
   * is incomplete. Callers must treat a partial snapshot as a hard
   * "do not decide" signal unless the specific missing surface is
   * irrelevant to the decision being made.
   */
  readonly partial: boolean;
  /** Surfaces that failed to fetch, when partial is true. Empty otherwise. */
  readonly partialSurfaces: ReadonlyArray<string>;
}

export interface SubmittedReview {
  readonly author: string;
  readonly state: string;
  readonly submittedAt: string;
  readonly body?: string;
}

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly appSlug?: string;
}

export interface LegacyStatus {
  readonly context: string;
  readonly state: string;
  readonly updatedAt: string;
}
