/**
 * Open-PR source: deployment-side adapter that the orphan-reconcile
 * tick uses to enumerate currently-open PRs and their last-activity
 * timestamps.
 *
 * Mirrors the substrate-not-prescription posture of
 * `pr-observation-refresher.mjs`: the framework module
 * `src/runtime/plans/pr-orphan-reconcile.ts` stays mechanism-only;
 * this module carries the GitHub-shaped concern (process spawn,
 * GraphQL query construction, gh auth) so framework code never
 * imports a vendor adapter.
 *
 * Strategy: shell out to `gh-as.mjs <bot> api graphql` with a
 * GraphQL query that returns OpenPR(number, updatedAt, latest commit
 * authoredDate, latest review submittedAt, latest issueComment
 * updatedAt). The adapter computes
 * `last_activity_at = max(updatedAt, last commit authoredDate,
 * last review submittedAt, last issueComment updatedAt)` so the tick
 * sees a single authoritative timestamp.
 *
 * Best-effort: a failed gh invocation rejects the Promise; the tick
 * is responsible for surfacing the error to the operator's log. We
 * never silently degrade to an empty list because that would
 * silently disable orphan detection.
 *
 * Bot identity: routed through `gh-as.mjs <role>` so the API call is
 * attributed to the deployment's bot; never the operator's PAT.
 * Default role `lag-ceo` matches the canonical operator-proxy
 * identity for read-only PR queries. Override via env
 * `LAG_PR_ORPHAN_GH_ROLE`.
 */
import { execa } from 'execa';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_AS_PATH = resolve(HERE, '..', 'gh-as.mjs');

const PR_LIST_QUERY = `query OpenPrs($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 100, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        updatedAt
        commits(last: 1) { nodes { commit { committedDate authoredDate } } }
        latestReviews(last: 1) { nodes { submittedAt } }
        comments(last: 1) { nodes { updatedAt } }
      }
    }
  }
}`;

/**
 * Build the {@link OpenPrSource} adapter the framework tick consumes.
 *
 * @param {{
 *   readonly owner: string,
 *   readonly repo: string,
 *   readonly role?: string,
 *   readonly repoRoot?: string,
 *   readonly timeoutMs?: number,
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
  const { owner, repo } = options;
  return {
    async list() {
      const result = await execa(
        'node',
        [
          GH_AS_PATH, role,
          'api', 'graphql',
          '-f', `query=${PR_LIST_QUERY}`,
          '-F', `owner=${owner}`,
          '-F', `repo=${repo}`,
        ],
        { cwd: repoRoot, timeout: timeoutMs, reject: true },
      );
      const parsed = JSON.parse(result.stdout);
      const nodes = parsed?.data?.repository?.pullRequests?.nodes;
      if (!Array.isArray(nodes)) {
        throw new Error(
          `createGhOpenPrSource: unexpected GraphQL shape (no nodes array). stdout: ${result.stdout.slice(0, 200)}`,
        );
      }
      const snapshots = [];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const number = node.number;
        if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
        const updatedAtRaw = typeof node.updatedAt === 'string' ? node.updatedAt : null;
        const lastCommitAtRaw = typeof node.commits?.nodes?.[0]?.commit?.committedDate === 'string'
          ? node.commits.nodes[0].commit.committedDate
          : typeof node.commits?.nodes?.[0]?.commit?.authoredDate === 'string'
            ? node.commits.nodes[0].commit.authoredDate
            : null;
        const lastReviewAtRaw = typeof node.latestReviews?.nodes?.[0]?.submittedAt === 'string'
          ? node.latestReviews.nodes[0].submittedAt
          : null;
        const lastCommentAtRaw = typeof node.comments?.nodes?.[0]?.updatedAt === 'string'
          ? node.comments.nodes[0].updatedAt
          : null;
        const candidates = [updatedAtRaw, lastCommitAtRaw, lastReviewAtRaw, lastCommentAtRaw]
          .filter((s) => typeof s === 'string')
          .map((s) => ({ raw: s, ms: Date.parse(s) }))
          .filter((p) => Number.isFinite(p.ms));
        if (candidates.length === 0) continue;
        candidates.sort((a, b) => b.ms - a.ms);
        const latest = candidates[0];
        snapshots.push({
          pr: { owner, repo, number },
          last_activity_at: latest.raw,
          snapshot: {
            updated_at: updatedAtRaw,
            last_commit_at: lastCommitAtRaw,
            last_review_at: lastReviewAtRaw,
            last_comment_at: lastCommentAtRaw,
          },
        });
      }
      return snapshots;
    },
  };
}

/**
 * Compute the activity timestamp from a parsed PR node. Exported so
 * unit tests can pin the merge logic without spawning a subprocess.
 *
 * @param {Readonly<Record<string, unknown>>} node
 * @returns {string | null}
 */
export function computeLastActivityAt(node) {
  if (!node || typeof node !== 'object') return null;
  const candidates = [];
  if (typeof node.updatedAt === 'string') candidates.push(node.updatedAt);
  const commitNode = node.commits?.nodes?.[0]?.commit;
  if (commitNode) {
    if (typeof commitNode.committedDate === 'string') candidates.push(commitNode.committedDate);
    else if (typeof commitNode.authoredDate === 'string') candidates.push(commitNode.authoredDate);
  }
  const reviewAt = node.latestReviews?.nodes?.[0]?.submittedAt;
  if (typeof reviewAt === 'string') candidates.push(reviewAt);
  const commentAt = node.comments?.nodes?.[0]?.updatedAt;
  if (typeof commentAt === 'string') candidates.push(commentAt);
  const parsed = candidates
    .map((s) => ({ raw: s, ms: Date.parse(s) }))
    .filter((p) => Number.isFinite(p.ms));
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.ms - a.ms);
  return parsed[0].raw;
}
