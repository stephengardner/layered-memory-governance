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
  GithubReplyResponse,
  GithubResolveReviewThreadResponse,
  GithubReviewThreadsResponse,
} from '../../external/github/index.js';
import type {
  PrCommentOutcome,
  PrIdentifier,
  PrReviewAdapter,
  ReviewComment,
  ReviewReplyOutcome,
} from './adapter.js';

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
}

const DEFAULT_ALREADY_REPLIED_AUTHORS: ReadonlyArray<string> = ['github-actions[bot]'];

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
  private readonly threadIndex = new Map<string, string>();

  constructor(options: GitHubPrReviewAdapterOptions) {
    this.client = options.client;
    this.dryRun = options.dryRun ?? false;
    this.maxThreadPages = options.maxThreadPages ?? 10;
    this.alreadyRepliedAuthors = new Set(
      options.alreadyRepliedAuthors ?? DEFAULT_ALREADY_REPLIED_AUTHORS,
    );
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
  const base: ReviewComment = {
    id: commentId,
    author: c.author?.login ?? 'unknown',
    body: c.body,
    createdAt: c.createdAt,
    resolved: false,
    threadId,
  };
  const path = c.path ?? threadPath;
  const line = c.line ?? undefined;
  if (path !== undefined && line !== undefined) return { ...base, path, line };
  if (path !== undefined) return { ...base, path };
  if (line !== undefined) return { ...base, line };
  return base;
}
