/**
 * Pure-function helpers for the resolve-outdated-threads flow.
 *
 * Lives next to scripts/lib/git-as.mjs (the existing per-bot helpers
 * convention) so vitest can exercise the classification logic without
 * touching the GitHub API.
 *
 * The wire shape mirrors GitHub's PullRequest.reviewThreads.nodes
 * GraphQL response so the production callsite can pass the response
 * verbatim. Each thread carries:
 *   - id: opaque GraphQL node id (used by resolveReviewThread mutation)
 *   - isResolved: whether the thread is already marked resolved
 *   - isOutdated: GitHub's signal that the anchored line was changed
 *     by a subsequent commit (i.e. the suggestion has been addressed
 *     or rendered moot by code churn)
 *   - path: file the thread is anchored to (informational, for logs)
 */

/**
 * @typedef {Object} ReviewThread
 * @property {string} id
 * @property {boolean} isResolved
 * @property {boolean} isOutdated
 * @property {string=} path
 */

/**
 * Classify threads into three buckets:
 *   - resolveTargets: unresolved AND outdated (the fix-commit changed
 *     the anchored line; safe to mark resolved)
 *   - stillCurrent: unresolved AND NOT outdated (the anchored line
 *     still exists; needs human or follow-up to resolve)
 *   - alreadyResolved: state already terminal
 *
 * Pure function. No I/O. The caller decides what to do with each
 * bucket; this module only tells them what shape they have.
 *
 * @param {ReadonlyArray<ReviewThread>} threads
 */
export function classifyReviewThreads(threads) {
  const resolveTargets = [];
  const stillCurrent = [];
  const alreadyResolved = [];
  for (const t of threads) {
    if (t.isResolved) {
      alreadyResolved.push(t);
    } else if (t.isOutdated) {
      resolveTargets.push(t);
    } else {
      stillCurrent.push(t);
    }
  }
  return { resolveTargets, stillCurrent, alreadyResolved };
}
