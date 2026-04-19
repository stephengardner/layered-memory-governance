/**
 * GitHub external-system integration (subpath: `/external/github`).
 *
 * Reusable GitHub transport primitive shared by any LAG actor that
 * touches GitHub. Per D17, this lives outside the Host governance
 * boundary -- external-system adapters are actor-scoped.
 *
 * This module deliberately knows nothing about reviews, issues, PRs as
 * concepts; it is pure authenticated transport over the `gh` CLI.
 */

export {
  createGhClient,
  defaultGhExecutor,
  GhClientError,
} from './gh-client.js';
export type {
  GhClient,
  GhClientOptions,
  GhExecResult,
  GhExecutor,
  GhRestArgs,
} from './gh-client.js';
export type {
  GithubReplyResponse,
  GithubResolveReviewThreadResponse,
  GithubReviewCommentRest,
  GithubReviewThreadGql,
  GithubReviewThreadsResponse,
  GithubUser,
} from './types.js';
