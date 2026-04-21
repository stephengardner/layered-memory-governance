/**
 * GitHubPrReviewAdapter: concrete `PrReviewAdapter` backed by the GitHub
 * API via the reusable `GhClient` primitive.
 *
 * Full implementation -- no best-effort stubs:
 *   - list: GraphQL query on `reviewThreads` with pagination; filters to
 *     unresolved, non-outdated; flattens to ReviewComment shape with
 *     threadId preserved for subsequent resolve calls
 *   - reply: REST POST to /pulls/{n}/comments/{id}/replies
 *   - resolve: GraphQL `resolveReviewThread` mutation using threadId
 *
 * Dry-run mode is first-class. When enabled, writes short-circuit before
 * shelling out; reads still go through.
 */

import type { GhClient } from '../../external/github/index.js';
import type {
  GithubPullRequestReviewRest,
  GithubReplyResponse,
  GithubResolveReviewThreadResponse,
  GithubReviewThreadsResponse,
} from '../../external/github/index.js';
import type {
  CheckRun,
  LegacyStatus,
  PrCommentOutcome,
  PrIdentifier,
  PrReviewAdapter,
  PrReviewStatus,
  ReviewComment,
  ReviewReplyOutcome,
  SubmittedReview,
} from './adapter.js';
import { extractProposedFixFromCommentBody, parseCodeRabbitReviewBody } from './coderabbit-body-parser.js';

export interface GitHubPrReviewAdapterOptions {
  readonly client: GhClient;
  /**
   * When true, write methods (reply / resolve) short-circuit: they log
   * intent and return stub outcomes without making any API calls. Reads
   * are unaffected. First-class option; not a hidden branch.
   */
  readonly dryRun?: boolean;
  /**
   * Max pages of review threads to fetch before giving up. Each page is
   * 100 threads. Default 10 (1000 threads is far more than any real PR).
   */
  readonly maxThreadPages?: number;
  /**
   * Author logins whose presence in a thread marks that thread as
   * already-handled. Prevents the actor from replying to its own
   * replies and infinite-looping. Default: ['github-actions[bot]'].
   * Set to [] to disable (testing only; returns every unresolved
   * comment regardless of prior replies).
   */
  readonly alreadyRepliedAuthors?: ReadonlyArray<string>;
  /**
   * Author login prefixes whose review BODIES are parsed for body-
   * scoped nits by `listReviewBodyNits`. Extracting nits from the
   * review body is reviewer-format-specific (CodeRabbit ships the
   * `🧹 Nitpick comments` collapsible block; other reviewers use
   * different structures we cannot parse). Vendor-specific knowledge
   * belongs in configuration, not src/: a team using a private
   * CodeRabbit instance with a custom login, or a different
   * reviewer bot entirely, overrides this without touching framework
   * code.
   *
   * Default: ['coderabbitai']. Any author whose login starts with
   * ANY prefix in the list has their review body parsed. Set to []
   * to disable body-nit parsing entirely.
   */
  readonly bodyNitReviewerPrefixes?: ReadonlyArray<string>;
}

const DEFAULT_ALREADY_REPLIED_AUTHORS: ReadonlyArray<string> = ['github-actions[bot]'];
const DEFAULT_BODY_NIT_REVIEWER_PREFIXES: ReadonlyArray<string> = ['coderabbitai'];

const REVIEW_THREADS_QUERY = `
query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { endCursor hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 100) {
            nodes {
              id
              databaseId
              author { login }
              body
              path
              line
              createdAt
            }
          }
        }
      }
    }
  }
}
`;

const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
`;

export class GitHubPrReviewAdapter implements PrReviewAdapter {
  readonly name = 'github-pr-review';
  readonly version = '0.1.0';

  private readonly client: GhClient;
  private readonly dryRun: boolean;
  private readonly maxThreadPages: number;
  private readonly alreadyRepliedAuthors: ReadonlySet<string>;
  private readonly bodyNitReviewerPrefixes: ReadonlyArray<string>;
  private readonly threadIndex = new Map<string, string>();

  constructor(options: GitHubPrReviewAdapterOptions) {
    this.client = options.client;
    this.dryRun = options.dryRun ?? false;
    this.maxThreadPages = options.maxThreadPages ?? 10;
    this.alreadyRepliedAuthors = new Set(
      options.alreadyRepliedAuthors ?? DEFAULT_ALREADY_REPLIED_AUTHORS,
    );
    this.bodyNitReviewerPrefixes =
      options.bodyNitReviewerPrefixes ?? DEFAULT_BODY_NIT_REVIEWER_PREFIXES;
  }

  async listUnresolvedComments(pr: PrIdentifier): Promise<ReadonlyArray<ReviewComment>> {
    const comments: ReviewComment[] = [];
    let cursor: string | null = null;
    this.threadIndex.clear();

    for (let page = 0; page < this.maxThreadPages; page++) {
      const variables: Record<string, unknown> = {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      };
      if (cursor !== null) variables.cursor = cursor;

      const data = await this.client.graphql<GithubReviewThreadsResponse>(
        REVIEW_THREADS_QUERY,
        variables,
      );
      const threads = data.repository.pullRequest.reviewThreads;

      for (const thread of threads.nodes) {
        if (thread.isResolved || thread.isOutdated) continue;
        if (this.threadAlreadyHandled(thread)) continue;
        const nodes = thread.comments.nodes;
        if (nodes.length === 0) continue;
        // Only expose the ROOT comment of each unresolved thread. That's
        // the one the actor replies to; replies thread underneath via
        // the /replies endpoint. Surfacing every nested comment would
        // cause the actor to reply to its own replies on the next pass.
        const root = nodes[0]!;
        const commentId = String(root.databaseId);
        this.threadIndex.set(commentId, thread.id);
        comments.push(mkComment(commentId, thread.id, thread.path, root));
      }

      if (!threads.pageInfo.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
      if (cursor === null) break;
    }

    return comments;
  }

  async replyToComment(
    pr: PrIdentifier,
    commentId: string,
    body: string,
  ): Promise<ReviewReplyOutcome> {
    if (this.dryRun) {
      return { commentId, posted: false, dryRun: true };
    }
    const response = await this.client.rest<GithubReplyResponse>({
      method: 'POST',
      path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments/${commentId}/replies`,
      fields: { body },
    });
    if (!response) {
      throw new Error(`GitHubPrReviewAdapter: empty response from POST reply for comment ${commentId}`);
    }
    return {
      commentId,
      replyId: String(response.id),
      posted: true,
    };
  }

  async resolveComment(pr: PrIdentifier, commentId: string): Promise<void> {
    // Contract is idempotent: a comment whose thread we cannot find
    // is most likely already-resolved or already-outdated (our
    // listUnresolvedComments filters those out before exposing them).
    // Treating missing-thread as success (no-op) matches the interface
    // doc's idempotence promise and prevents spurious failures when
    // the actor retries after a prior successful resolve.
    if (this.dryRun) return;

    const threadId = await this.resolveThreadId(pr, commentId);
    if (threadId === null) return;

    await this.client.graphql<GithubResolveReviewThreadResponse>(
      RESOLVE_THREAD_MUTATION,
      { threadId },
    );
  }

  /**
   * Check whether any of the given reviewer logins has posted ANY
   * review comment (line-level) OR top-level issue/PR comment. Uses
   * two REST endpoints so we catch both code-review threads and
   * top-level chatter. Read-only; dry-run has no effect.
   */
  async hasReviewerEngaged(
    pr: PrIdentifier,
    authorLogins: ReadonlyArray<string>,
  ): Promise<boolean> {
    if (authorLogins.length === 0) return false;
    const logins = new Set(authorLogins);

    type CommentLike = { readonly user?: { readonly login?: string } };
    const reviewComments = await this.client.rest<ReadonlyArray<CommentLike>>({
      path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`,
      query: { per_page: 100 },
    });
    for (const c of reviewComments ?? []) {
      const login = c.user?.login;
      if (login && logins.has(login)) return true;
    }

    const issueComments = await this.client.rest<ReadonlyArray<CommentLike>>({
      path: `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
      query: { per_page: 100 },
    });
    for (const c of issueComments ?? []) {
      const login = c.user?.login;
      if (login && logins.has(login)) return true;
    }

    return false;
  }

  /**
   * Fetch all reviews for the PR, parse each body for CodeRabbit's
   * `🧹 Nitpick comments (N)` block, and return the extracted items as
   * synthetic `ReviewComment`s with `kind: 'body-nit'`.
   *
   * Synthetic ids have the form
   * `body-nit:<reviewId>:<path>:<lineStart>:<ordinal>` so they are
   * stable across re-runs AND unique within a single review. The
   * ordinal is the nit's index inside the parser's ordered output
   * for that review; the parser walks the review body
   * deterministically, so the same review body yields the same
   * ordinal for the same nit on every run.
   *
   * Body-nits have no threadId and must not be fed into reply/resolve
   * paths; pr-landing enforces this via the `kind` check.
   *
   * Only CodeRabbit reviews are parsed today. A second reviewer format
   * would justify moving the parse dispatch into a registry; one
   * concrete consumer, one inline branch.
   */
  async listReviewBodyNits(pr: PrIdentifier): Promise<ReadonlyArray<ReviewComment>> {
    // Page through /pulls/{n}/reviews. GitHub caps per_page at 100;
    // large PRs can have more than 100 reviews (bot + human + bot
    // over many rounds) and a single-page fetch silently drops the
    // tail. Bounded by maxThreadPages like listUnresolvedComments so
    // a pathological case cannot stall the actor; if the cap is hit
    // we emit with the first N pages' body-nits and the escalation
    // notifier still surfaces the PR to the operator.
    const reviews: GithubPullRequestReviewRest[] = [];
    for (let page = 1; page <= this.maxThreadPages; page++) {
      const batch = await this.client.rest<ReadonlyArray<GithubPullRequestReviewRest>>({
        path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        query: { per_page: 100, page },
      });
      if (!batch || batch.length === 0) break;
      reviews.push(...batch);
      if (batch.length < 100) break;
    }
    if (reviews.length === 0) return [];

    const out: ReviewComment[] = [];
    for (const review of reviews) {
      const author = review.user?.login ?? 'unknown';
      // Body-nit parsing is reviewer-format-specific. Only authors
      // whose login starts with one of the configured prefixes get
      // their review body parsed; others have no supported body
      // format and would produce empty or garbage output.
      if (!this.bodyNitReviewerPrefixes.some((p) => author.startsWith(p))) continue;
      if (!review.body) continue;
      const parsed = parseCodeRabbitReviewBody(review.body);
      for (let i = 0; i < parsed.nitpicks.length; i++) {
        const nit = parsed.nitpicks[i]!;
        // Append the per-review ordinal so two nits on the same
        // (review, path, lineStart) do not collide. The parser's
        // ordering is deterministic given the same input body, so
        // the same nit always maps to the same ordinal -> same id
        // across re-runs. Downstream idempotency and de-dup rely
        // on this stability.
        const syntheticId = `body-nit:${review.id}:${nit.path}:${nit.lineStart ?? 0}:${i}`;
        const base: ReviewComment = {
          id: syntheticId,
          author,
          body: nit.body,
          createdAt: review.submitted_at ?? new Date().toISOString(),
          resolved: false,
          kind: 'body-nit',
          severity: 'nit',
          path: nit.path,
        };
        const withLine = nit.lineStart !== undefined
          ? { ...base, line: nit.lineStart }
          : base;
        const withFix = nit.proposedFix !== undefined
          ? { ...withLine, proposedFix: nit.proposedFix }
          : withLine;
        out.push(withFix);
      }
    }
    return out;
  }

  /**
   * Composite multi-surface read. Per canon directive
   * `dev-multi-surface-review-observation`, we fetch every surface
   * that can contribute to "is this PR ready to merge" and return
   * them together so callers never make decisions on a partial view.
   *
   * Surfaces fetched concurrently:
   *   - mergeable + mergeStateStatus + head SHA via GraphQL
   *   - line comments via listUnresolvedComments
   *   - body-nits via listReviewBodyNits
   *   - submitted reviews via REST /pulls/{n}/reviews
   *   - check-runs via REST /commits/{sha}/check-runs
   *   - legacy statuses via REST /commits/{sha}/status
   *
   * Per-surface failures degrade the snapshot to `partial: true` +
   * `partialSurfaces: [...]` rather than throwing. Callers decide
   * whether the missing surface matters for the decision at hand.
   */
  async getPrReviewStatus(pr: PrIdentifier): Promise<PrReviewStatus> {
    const partialSurfaces: string[] = [];

    const prMeta = this.fetchPrMetaGql(pr).catch((err) => {
      partialSurfaces.push(`pr-meta: ${err?.message ?? err}`);
      return {
        mergeable: null as boolean | null,
        mergeStateStatus: null as string | null,
        headOid: null as string | null,
      };
    });
    const lineComments = this.listUnresolvedComments(pr).catch((err) => {
      partialSurfaces.push(`line-comments: ${err?.message ?? err}`);
      return [] as ReadonlyArray<ReviewComment>;
    });
    const bodyNits = this.listReviewBodyNits(pr).catch((err) => {
      partialSurfaces.push(`body-nits: ${err?.message ?? err}`);
      return [] as ReadonlyArray<ReviewComment>;
    });
    const submittedReviews = this.fetchSubmittedReviews(pr).catch((err) => {
      partialSurfaces.push(`submitted-reviews: ${err?.message ?? err}`);
      return [] as ReadonlyArray<SubmittedReview>;
    });

    const [meta, line, body, reviews] = await Promise.all([
      prMeta,
      lineComments,
      bodyNits,
      submittedReviews,
    ]);

    // check-runs and legacy statuses hang off the HEAD commit; fetch
    // after prMeta resolves so we know the SHA. If prMeta failed
    // (no head oid), mark both as partial rather than guess.
    let checkRuns: ReadonlyArray<CheckRun> = [];
    let legacyStatuses: ReadonlyArray<LegacyStatus> = [];
    if (meta.headOid) {
      const [cr, ls] = await Promise.all([
        this.fetchCheckRuns(pr, meta.headOid).catch((err) => {
          partialSurfaces.push(`check-runs: ${err?.message ?? err}`);
          return [] as ReadonlyArray<CheckRun>;
        }),
        this.fetchLegacyStatuses(pr, meta.headOid).catch((err) => {
          partialSurfaces.push(`legacy-statuses: ${err?.message ?? err}`);
          return [] as ReadonlyArray<LegacyStatus>;
        }),
      ]);
      checkRuns = cr;
      legacyStatuses = ls;
    } else {
      partialSurfaces.push('check-runs: no head oid');
      partialSurfaces.push('legacy-statuses: no head oid');
    }

    return {
      pr,
      mergeable: meta.mergeable,
      mergeStateStatus: meta.mergeStateStatus,
      lineComments: line,
      bodyNits: body,
      submittedReviews: reviews,
      checkRuns,
      legacyStatuses,
      partial: partialSurfaces.length > 0,
      partialSurfaces,
    };
  }

  /**
   * Fetch PR-level mergeability metadata via a single GraphQL query.
   * Returns `mergeable` (coerced from the GraphQL enum to
   * boolean | null; null for UNKNOWN when GitHub has not finished
   * computing), `mergeStateStatus`
   * (CLEAN / BLOCKED / UNKNOWN / BEHIND / DIRTY / DRAFT / HAS_HOOKS /
   * UNSTABLE), and the head ref's SHA so the check-runs and
   * legacy-statuses fetches can hang off it. One GraphQL round trip
   * keeps the composite read cheap.
   */
  private async fetchPrMetaGql(pr: PrIdentifier): Promise<{
    mergeable: boolean | null;
    mergeStateStatus: string | null;
    headOid: string | null;
  }> {
    const query = `
      query PrMeta($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            mergeable
            mergeStateStatus
            headRefOid
          }
        }
      }
    `;
    type Resp = {
      readonly repository: {
        readonly pullRequest: {
          readonly mergeable: string | null;
          readonly mergeStateStatus: string | null;
          readonly headRefOid: string | null;
        };
      };
    };
    const data = await this.client.graphql<Resp>(query, {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
    });
    const node = data.repository.pullRequest;
    // GraphQL `mergeable` is an enum: MERGEABLE, CONFLICTING, UNKNOWN.
    // Coerce to a boolean for callers; null for UNKNOWN.
    const mergeable = node.mergeable === 'MERGEABLE'
      ? true
      : node.mergeable === 'CONFLICTING'
        ? false
        : null;
    return {
      mergeable,
      mergeStateStatus: node.mergeStateStatus,
      headOid: node.headRefOid,
    };
  }

  /**
   * Fetch all submitted reviews via REST. Single call, per_page=100;
   * pagination not added because realistic PRs top out well under
   * 100 submitted reviews. Returns each review's author login, state
   * (COMMENTED / APPROVED / CHANGES_REQUESTED / DISMISSED), submission
   * timestamp, and body. Defensively uses `user?.login ?? 'unknown'`
   * because GitHub's REST API can return a null user when the account
   * was deleted or is a ghost.
   */
  private async fetchSubmittedReviews(pr: PrIdentifier): Promise<ReadonlyArray<SubmittedReview>> {
    type Resp = ReadonlyArray<{
      readonly user?: { readonly login: string } | null;
      readonly state: string;
      readonly submitted_at?: string;
      readonly body?: string;
    }>;
    const reviews = await this.client.rest<Resp>({
      path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
      query: { per_page: 100 },
    });
    if (!reviews) return [];
    return reviews.map((r) => {
      const base: SubmittedReview = {
        author: r.user?.login ?? 'unknown',
        state: r.state,
        submittedAt: r.submitted_at ?? '',
      };
      return r.body ? { ...base, body: r.body } : base;
    });
  }

  /**
   * Fetch check-runs for the head commit via REST. check-runs is
   * GitHub's modern check surface (most CI systems post here, e.g.,
   * the repo's own `CI` workflow and `pr-landing agent`). Returns
   * name, status (queued / in_progress / completed), conclusion
   * (success / failure / cancelled / skipped / null when still
   * running), and the posting app's slug for attribution.
   */
  private async fetchCheckRuns(pr: PrIdentifier, sha: string): Promise<ReadonlyArray<CheckRun>> {
    type Resp = {
      readonly check_runs: ReadonlyArray<{
        readonly name: string;
        readonly status: string;
        readonly conclusion: string | null;
        readonly app?: { readonly slug?: string };
      }>;
    };
    const data = await this.client.rest<Resp>({
      path: `repos/${pr.owner}/${pr.repo}/commits/${sha}/check-runs`,
      query: { per_page: 100 },
    });
    if (!data) return [];
    return data.check_runs.map((r) => {
      const base: CheckRun = {
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
      };
      return r.app?.slug ? { ...base, appSlug: r.app.slug } : base;
    });
  }

  /**
   * Fetch legacy commit statuses via REST. Pre-dates the check-runs
   * API; some external services (notably some CodeRabbit
   * configurations) still post ONLY here, not via check-runs.
   * Reading both surfaces lets the composite read surface the
   * blocking check regardless of which API it lives on - the exact
   * failure mode that motivated the multi-surface observation
   * discipline in the first place.
   */
  private async fetchLegacyStatuses(pr: PrIdentifier, sha: string): Promise<ReadonlyArray<LegacyStatus>> {
    type Resp = {
      readonly statuses: ReadonlyArray<{
        readonly context: string;
        readonly state: string;
        readonly updated_at: string;
      }>;
    };
    const data = await this.client.rest<Resp>({
      path: `repos/${pr.owner}/${pr.repo}/commits/${sha}/status`,
    });
    if (!data) return [];
    return data.statuses.map((s) => ({
      context: s.context,
      state: s.state,
      updatedAt: s.updated_at,
    }));
  }

  /**
   * Post a top-level PR comment. Used to prompt a reviewer bot or
   * surface anything that is not a thread reply. GitHub treats PRs as
   * issues for top-level comments, so this POSTs to the issues endpoint.
   */
  async postPrComment(
    pr: PrIdentifier,
    body: string,
  ): Promise<PrCommentOutcome> {
    if (this.dryRun) {
      return { posted: false, dryRun: true };
    }
    const response = await this.client.rest<{ id: number }>({
      method: 'POST',
      path: `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
      fields: { body },
    });
    if (!response) {
      throw new Error(`GitHubPrReviewAdapter: empty response from POST issue comment on ${pr.owner}/${pr.repo}#${pr.number}`);
    }
    return { commentId: String(response.id), posted: true };
  }

  private threadAlreadyHandled(thread: {
    readonly comments: {
      readonly nodes: ReadonlyArray<{ readonly author?: { readonly login: string } }>;
    };
  }): boolean {
    if (this.alreadyRepliedAuthors.size === 0) return false;
    for (const c of thread.comments.nodes) {
      const login = c.author?.login;
      if (login && this.alreadyRepliedAuthors.has(login)) return true;
    }
    return false;
  }

  private async resolveThreadId(pr: PrIdentifier, commentId: string): Promise<string | null> {
    const cached = this.threadIndex.get(commentId);
    if (cached !== undefined) return cached;
    // Fallback: re-list (populates threadIndex).
    await this.listUnresolvedComments(pr);
    return this.threadIndex.get(commentId) ?? null;
  }
}

function mkComment(
  commentId: string,
  threadId: string,
  threadPath: string | undefined,
  c: {
    readonly author?: { readonly login: string };
    readonly body: string;
    readonly path?: string;
    readonly line?: number | null;
    readonly createdAt: string;
  },
): ReviewComment {
  const proposedFix = extractProposedFixFromCommentBody(c.body);
  const base: ReviewComment = {
    id: commentId,
    author: c.author?.login ?? 'unknown',
    body: c.body,
    createdAt: c.createdAt,
    resolved: false,
    threadId,
    kind: 'line',
    ...(proposedFix !== undefined ? { proposedFix } : {}),
  };
  const path = c.path ?? threadPath;
  const line = c.line ?? undefined;
  if (path !== undefined && line !== undefined) return { ...base, path, line };
  if (path !== undefined) return { ...base, path };
  if (line !== undefined) return { ...base, line };
  return base;
}
