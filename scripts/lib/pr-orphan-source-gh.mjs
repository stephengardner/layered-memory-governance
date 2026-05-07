/**
 * Open-PR source: deployment-side adapter that the orphan-reconcile
 * tick uses to enumerate currently-open PRs and their last-activity
 * timestamps.
 *
 * Substrate purity: the framework module
 * `src/runtime/plans/pr-orphan-reconcile.ts` stays mechanism-only; the
 * GraphQL query, gh-process spawn, and timestamp merge live here so
 * framework code never imports a vendor adapter.
 *
 * Strategy: shell out to `gh-as.mjs <bot> api graphql` with a paginated
 * GraphQL query that returns each open PR's `updatedAt`, last commit
 * `committedDate`/`authoredDate`, latest review `submittedAt`, latest
 * issue-comment `updatedAt`, latest review-comment `updatedAt`, and
 * latest check-run `completedAt`. The adapter computes
 * `last_activity_at = max(...)` across every signal so the tick sees a
 * single authoritative "did anyone recently care about this PR"
 * timestamp; the orphan tick never branches on the source.
 *
 * Pagination: the query walks PRs page-by-page (`first: 100, after:
 * cursor`) until `pageInfo.hasNextPage` is false. Without pagination
 * the oldest PRs (the ones most likely to be orphans, by definition)
 * silently get dropped on any deployment with >100 open PRs. A
 * configurable `maxPages` ceiling guards against an unbounded walk on
 * a long-tail store.
 *
 * Best-effort: a failed gh invocation rejects the Promise; the tick
 * is responsible for surfacing the error to the operator's log. We
 * never silently degrade to an empty list because that would silently
 * disable orphan detection.
 *
 * Bot identity: routed through `gh-as.mjs <role>` so the API call is
 * attributed to the deployment's bot; never the operator's PAT.
 */
import { execa } from 'execa';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_AS_PATH = resolve(HERE, '..', 'gh-as.mjs');

/**
 * Activity-signal set. `updatedAt` is GitHub's catch-all but does NOT
 * fire reliably on every event path (notably check-run completions and
 * review-comment updates can leave `updatedAt` stale). Each signal in
 * the list represents an INDEPENDENT surface that the orphan tick
 * treats as recent activity; the merge function takes the max.
 *
 * - `commits`: the last commit's committedDate / authoredDate. Catches
 *   fix-pushes from the driver sub-agent.
 * - `latestReviews`: CR / human review submissions. Catches review
 *   round-trips that did not also bump `updatedAt`.
 * - `comments`: PR-level issue comments. Catches CR triggers and
 *   operator notes.
 * - `reviews(last: 5).comments`: line-comment replies posted on a
 *   review. CR's incremental engine surfaces here separately from the
 *   issue-comment thread.
 * - `commits(last: 1).statusCheckRollup`: the rollup state's
 *   `state` is a coarse signal; `commits.statusCheckRollup` is the
 *   ground truth for "did CI just churn on this PR" and is the
 *   surface CR's required-status check writes to.
 * - `commits(last: 1).checkSuites.checkRuns(last: 5)`: per-check-run
 *   `completedAt`. CI re-runs and check-run completions update
 *   freshness without bumping `updatedAt` reliably across all event
 *   paths (per the CR finding).
 */
const PR_LIST_QUERY = `query OpenPrs($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 100, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        updatedAt
        commits(last: 1) {
          nodes {
            commit {
              committedDate
              authoredDate
              statusCheckRollup { state }
              checkSuites(last: 5) {
                nodes {
                  checkRuns(last: 5) {
                    nodes { completedAt }
                  }
                }
              }
            }
          }
        }
        latestReviews(last: 1) { nodes { submittedAt } }
        comments(last: 1) { nodes { updatedAt } }
        reviews(last: 5) {
          nodes {
            comments(last: 5) { nodes { updatedAt } }
          }
        }
      }
    }
  }
}`;

/** Maximum pagination pages walked per `list()` call. 100 PRs/page * 50
 *  pages = 5000 open PRs ceiling; far past any realistic deployment.
 *  Past this cap the walker stops and returns the partial list so the
 *  orphan tick still runs on the visible window. */
const DEFAULT_MAX_PAGES = 50;

/**
 * Build the {@link OpenPrSource} adapter the framework tick consumes.
 *
 * @param {{
 *   readonly owner: string,
 *   readonly repo: string,
 *   readonly role?: string,
 *   readonly repoRoot?: string,
 *   readonly timeoutMs?: number,
 *   readonly maxPages?: number,
 * }} options
 */
export function createGhOpenPrSource(options) {
  if (typeof options !== 'object' || options === null) {
    throw new Error('createGhOpenPrSource: options is required');
  }
  if (typeof options.owner !== 'string' || options.owner.length === 0) {
    throw new Error('createGhOpenPrSource: options.owner must be a non-empty string');
  }
  if (typeof options.repo !== 'string' || options.repo.length === 0) {
    throw new Error('createGhOpenPrSource: options.repo must be a non-empty string');
  }
  const repoRoot = options.repoRoot ?? resolve(HERE, '..', '..');
  const role = options.role ?? process.env.LAG_PR_ORPHAN_GH_ROLE ?? 'lag-ceo';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const { owner, repo } = options;
  return {
    async list() {
      const snapshots = [];
      let cursor = null;
      let pageCount = 0;
      while (pageCount < maxPages) {
        const args = [
          GH_AS_PATH, role,
          'api', 'graphql',
          '-f', `query=${PR_LIST_QUERY}`,
          '-F', `owner=${owner}`,
          '-F', `repo=${repo}`,
        ];
        // gh's `-F` flag does not encode null cleanly; for the first
        // page omit the cursor entirely, then pass the explicit string
        // returned by GraphQL on subsequent pages.
        if (cursor !== null) {
          args.push('-f', `cursor=${cursor}`);
        }
        const result = await execa('node', args, {
          cwd: repoRoot,
          timeout: timeoutMs,
          reject: true,
        });
        const parsed = JSON.parse(result.stdout);
        const pullRequests = parsed?.data?.repository?.pullRequests;
        const nodes = pullRequests?.nodes;
        if (!Array.isArray(nodes)) {
          throw new Error(
            `createGhOpenPrSource: unexpected GraphQL shape (no nodes array). stdout: ${result.stdout.slice(0, 200)}`,
          );
        }
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const number = node.number;
          if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
          // Single source of truth for the timestamp merge: callers and
          // tests use `computeLastActivityAt` against the same node
          // shape, so the adapter and the helper cannot drift.
          const lastActivityRaw = computeLastActivityAt(node);
          if (lastActivityRaw === null) continue;
          // Build a snapshot record for audit. The structured fields
          // mirror the helper's inputs so consumers walking the atom
          // chain can recompute the merge offline.
          const updatedAtRaw = typeof node.updatedAt === 'string' ? node.updatedAt : null;
          const lastCommitAtRaw = readCommitTimestamp(node);
          const lastReviewAtRaw = typeof node.latestReviews?.nodes?.[0]?.submittedAt === 'string'
            ? node.latestReviews.nodes[0].submittedAt
            : null;
          const lastCommentAtRaw = typeof node.comments?.nodes?.[0]?.updatedAt === 'string'
            ? node.comments.nodes[0].updatedAt
            : null;
          const lastReviewCommentAtRaw = readLatestReviewCommentAt(node);
          const lastCheckRunAtRaw = readLatestCheckRunCompletedAt(node);
          snapshots.push({
            pr: { owner, repo, number },
            last_activity_at: lastActivityRaw,
            snapshot: {
              updated_at: updatedAtRaw,
              last_commit_at: lastCommitAtRaw,
              last_review_at: lastReviewAtRaw,
              last_comment_at: lastCommentAtRaw,
              last_review_comment_at: lastReviewCommentAtRaw,
              last_check_run_at: lastCheckRunAtRaw,
            },
          });
        }
        const pageInfo = pullRequests?.pageInfo;
        const hasNext = pageInfo?.hasNextPage === true && typeof pageInfo?.endCursor === 'string';
        if (!hasNext) break;
        cursor = pageInfo.endCursor;
        pageCount += 1;
      }
      return snapshots;
    },
  };
}

/**
 * Read the last commit's committedDate (preferred) or authoredDate
 * (fallback). Exported only via re-use inside this module; matches
 * the per-field shape `computeLastActivityAt` expects.
 *
 * @param {Readonly<Record<string, unknown>>} node
 * @returns {string | null}
 */
function readCommitTimestamp(node) {
  const commit = node.commits?.nodes?.[0]?.commit;
  if (!commit) return null;
  if (typeof commit.committedDate === 'string') return commit.committedDate;
  if (typeof commit.authoredDate === 'string') return commit.authoredDate;
  return null;
}

/**
 * Read the most-recent line-comment timestamp across the last few
 * reviews. CR's incremental engine writes review comments without
 * always bumping the PR's outer `updatedAt`, so this surface is an
 * independent activity signal.
 *
 * @param {Readonly<Record<string, unknown>>} node
 * @returns {string | null}
 */
function readLatestReviewCommentAt(node) {
  const reviewNodes = node.reviews?.nodes;
  if (!Array.isArray(reviewNodes) || reviewNodes.length === 0) return null;
  let latest = null;
  let latestMs = -Infinity;
  for (const review of reviewNodes) {
    const commentNodes = review?.comments?.nodes;
    if (!Array.isArray(commentNodes)) continue;
    for (const comment of commentNodes) {
      const at = comment?.updatedAt;
      if (typeof at !== 'string') continue;
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      if (ms > latestMs) {
        latestMs = ms;
        latest = at;
      }
    }
  }
  return latest;
}

/**
 * Read the most-recent check-run `completedAt` across the last commit's
 * check-suites. CI re-runs land here without reliably bumping
 * `updatedAt` across every event path, so this surface is an
 * independent activity signal.
 *
 * @param {Readonly<Record<string, unknown>>} node
 * @returns {string | null}
 */
function readLatestCheckRunCompletedAt(node) {
  const commit = node.commits?.nodes?.[0]?.commit;
  const suiteNodes = commit?.checkSuites?.nodes;
  if (!Array.isArray(suiteNodes) || suiteNodes.length === 0) return null;
  let latest = null;
  let latestMs = -Infinity;
  for (const suite of suiteNodes) {
    const runNodes = suite?.checkRuns?.nodes;
    if (!Array.isArray(runNodes)) continue;
    for (const run of runNodes) {
      const at = run?.completedAt;
      if (typeof at !== 'string') continue;
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      if (ms > latestMs) {
        latestMs = ms;
        latest = at;
      }
    }
  }
  return latest;
}

/**
 * Compute the activity timestamp from a parsed PR node. Single source
 * of truth for the merge: both the `list()` loop above and the
 * exported helper use this function so the adapter cannot drift from
 * the unit-tested shape.
 *
 * Returns the most recent ISO timestamp across:
 *   - `updatedAt`
 *   - last commit `committedDate` / `authoredDate`
 *   - latest review `submittedAt`
 *   - latest issue comment `updatedAt`
 *   - latest review (line) comment `updatedAt`
 *   - latest check-run `completedAt`
 *
 * Or null when no candidate parses to a finite epoch.
 *
 * @param {Readonly<Record<string, unknown>>} node
 * @returns {string | null}
 */
export function computeLastActivityAt(node) {
  if (!node || typeof node !== 'object') return null;
  const candidates = [];
  if (typeof node.updatedAt === 'string') candidates.push(node.updatedAt);
  const commitTs = readCommitTimestamp(node);
  if (commitTs !== null) candidates.push(commitTs);
  const reviewAt = node.latestReviews?.nodes?.[0]?.submittedAt;
  if (typeof reviewAt === 'string') candidates.push(reviewAt);
  const commentAt = node.comments?.nodes?.[0]?.updatedAt;
  if (typeof commentAt === 'string') candidates.push(commentAt);
  const reviewCommentAt = readLatestReviewCommentAt(node);
  if (reviewCommentAt !== null) candidates.push(reviewCommentAt);
  const checkRunAt = readLatestCheckRunCompletedAt(node);
  if (checkRunAt !== null) candidates.push(checkRunAt);
  const parsed = candidates
    .map((s) => ({ raw: s, ms: Date.parse(s) }))
    .filter((p) => Number.isFinite(p.ms));
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.ms - a.ms);
  return parsed[0].raw;
}
