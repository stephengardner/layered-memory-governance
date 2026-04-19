/**
 * Typed GitHub API response shapes.
 *
 * Only the fields LAG actually reads are typed. We do not model the full
 * GitHub schema; if a future actor needs more, extend these types or
 * introduce parallel ones. Avoid `any` at all costs.
 */

export interface GithubUser {
  readonly login: string;
  readonly id: number;
  readonly type?: string;
}

/** A review comment as returned by REST /pulls/{n}/comments. */
export interface GithubReviewCommentRest {
  readonly id: number;
  readonly node_id: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number | null;
  readonly original_line?: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user: GithubUser;
  readonly in_reply_to_id?: number;
  readonly pull_request_review_id?: number | null;
}

/** A review thread as returned by the GraphQL reviewThreads query. */
export interface GithubReviewThreadGql {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path?: string;
  readonly comments: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly databaseId: number;
      readonly author?: { readonly login: string };
      readonly body: string;
      readonly path?: string;
      readonly line?: number | null;
      readonly createdAt: string;
    }>;
  };
}

export interface GithubReviewThreadsResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly pageInfo: { readonly endCursor: string | null; readonly hasNextPage: boolean };
        readonly nodes: ReadonlyArray<GithubReviewThreadGql>;
      };
    };
  };
}

export interface GithubResolveReviewThreadResponse {
  readonly resolveReviewThread: {
    readonly thread: { readonly id: string; readonly isResolved: boolean };
  };
}

export interface GithubReplyResponse {
  readonly id: number;
  readonly node_id: string;
  readonly body: string;
}
