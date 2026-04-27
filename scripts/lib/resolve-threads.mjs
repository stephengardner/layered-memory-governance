/**
 * Pure-function helpers for the resolve-outdated-threads flow.
 *
 * Lives next to scripts/lib/git-as.mjs (the existing per-bot helpers
 * convention) so vitest can exercise the classification + arg-parsing
 * logic without touching the GitHub API.
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

/**
 * @typedef {Object} ResolveArgs
 * @property {number|null} pr - PR number, or null when --help or no number provided
 * @property {boolean} dryRun
 * @property {boolean} help
 * @property {string|null} error - Error message, or null when args are valid
 */

/**
 * Parse argv for the resolve-outdated-threads CLI.
 *
 * Returns the parsed result instead of throwing or exiting, so callers
 * (the CLI in this repo, plus future callers wiring this into actor
 * loops) own the exit-code policy.
 *
 * Rejects a second numeric argument loud rather than silently
 * overwriting -- otherwise `node script.mjs 229 234` would target 234
 * with no warning, an obvious footgun once this gets wired into
 * `run-pr-fix.mjs` / `run-pr-landing.mjs` and someone forwards an
 * argv blindly.
 *
 * @param {ReadonlyArray<string>} argv
 * @returns {ResolveArgs}
 */
export function parseResolveArgs(argv) {
  const out = { pr: null, dryRun: false, help: false, error: null };
  for (const a of argv) {
    if (a === '--dry-run') {
      if (out.dryRun) {
        out.error = `multiple --dry-run flags provided; pass at most one`;
        return out;
      }
      out.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      if (out.help) {
        out.error = `multiple --help flags provided; pass at most one`;
        return out;
      }
      out.help = true;
    } else if (/^\d+$/.test(a)) {
      if (out.pr !== null) {
        out.error = `multiple pr numbers provided (${out.pr}, ${a}); pass exactly one`;
        return out;
      }
      out.pr = Number(a);
    } else {
      out.error = `unknown arg: ${a}`;
      return out;
    }
  }
  return out;
}
