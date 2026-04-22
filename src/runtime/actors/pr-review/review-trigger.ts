/**
 * ReviewTriggerAdapter: a pluggable seam for asking an external PR
 * review service to run against a PR out-of-band.
 *
 * Some reviewer integrations only honor trigger comments authored by
 * user-authenticated accounts rather than by automation (GitHub App)
 * accounts. This adapter exposes the "post a trigger comment" step as
 * a first-class interface so:
 *
 * - Callers (typically an Actor runner) have one place to invoke
 *   when they need to nudge a reviewer, rather than reaching into
 *   raw HTTP from inside actor bodies.
 * - Implementations are swappable: the concrete form in this module
 *   posts a comment under a user-authenticated token; other
 *   implementations could drive a reviewer's own API, post via a
 *   different channel, or short-circuit for tests.
 * - Callers never hardcode reviewer names or account logins; both
 *   the trigger body and any token source are passed in at
 *   composition time.
 *
 * Per the framework-code directive, this module knows nothing about
 * which specific reviewer or which specific account is used;
 * vendor-specific strings live in configuration or canon.
 */

import type { ActorAdapter } from '../types.js';
import type { PrIdentifier } from './adapter.js';

/**
 * Outcome of a trigger attempt. The adapter either POSTed the
 * comment, short-circuited because dry-run is set, or was unable to
 * post (auth error, HTTP failure). Callers should treat `posted` as
 * the single source of truth; `failure` carries diagnostic text for
 * audit + escalation messages.
 */
export interface ReviewTriggerOutcome {
  readonly posted: boolean;
  readonly dryRun?: boolean;
  /**
   * Identifier of the comment the adapter posted, when known. May
   * be absent for dry-runs or for implementations that do not
   * produce a comment surface.
   */
  readonly commentId?: string;
  /**
   * When posted is false AND dryRun is falsy, this field carries
   * the reason (HTTP status, 'missing-token', 'unauthorized', etc.)
   * so callers can include it in an escalation message without
   * having to decode the implementation-specific error.
   */
  readonly failure?: string;
}

export interface ReviewTriggerAdapter extends ActorAdapter {
  /**
   * Post a trigger comment on `pr` asking the external reviewer to
   * run. `body` is the full comment text (e.g., "@coderabbitai
   * review"); callers construct it so this adapter stays
   * reviewer-agnostic.
   */
  triggerReview(pr: PrIdentifier, body: string): Promise<ReviewTriggerOutcome>;
}

// ---------------------------------------------------------------------------
// Concrete: UserAccountCommentTrigger (machine-user via PAT)
// ---------------------------------------------------------------------------

export interface UserAccountCommentTriggerOptions {
  /**
   * Fetch returning a PAT (or equivalent bearer) that authenticates
   * AS a GitHub User account (type=User, not type=Bot). The factory
   * is async so secret-store indirection is legal. Return `null` if
   * the secret is unavailable in the current environment; the
   * adapter then returns `{posted:false, failure:'missing-token'}`
   * rather than throwing, so callers can surface a clean
   * operator-escalation.
   */
  readonly getToken: () => Promise<string | null>;
  /**
   * When true, `triggerReview` short-circuits before the POST and
   * returns `{posted:false, dryRun:true}`. Mirrors the pattern on
   * GitHubPrReviewAdapter so dry-run semantics stay consistent.
   */
  readonly dryRun?: boolean;
  /**
   * HTTP client override. Defaults to global `fetch`. Test code
   * supplies a stub that asserts request shape + returns canned
   * responses; production code uses the default.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Overrides the GitHub REST API base. Default
   * `https://api.github.com`. Tests set this to a mock server URL.
   */
  readonly apiBase?: string;
  /**
   * Human-readable name of the machine-user identity this adapter
   * is acting as, for audit + log readability. Not used in the HTTP
   * call itself (GitHub reads the token, not this string).
   */
  readonly actingAs?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * Concrete ReviewTriggerAdapter that posts the trigger comment as
 * a user-authenticated bearer token rather than an installation
 * token, for deployments that use a reviewer integration requiring
 * a user-authored trigger surface. The token is fetched per-
 * invocation (no caching at this layer) so rotations or secret-
 * store changes are picked up immediately; the implementation
 * trades one extra getToken() await for correctness-over-performance.
 */
export class UserAccountCommentTrigger implements ReviewTriggerAdapter {
  readonly name = 'user-account-comment-trigger';
  readonly version = '0.1.0';

  private readonly getToken: () => Promise<string | null>;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly actingAs: string | undefined;

  constructor(options: UserAccountCommentTriggerOptions) {
    this.getToken = options.getToken;
    this.dryRun = options.dryRun ?? false;
    // Cast to typeof fetch because `globalThis.fetch` is typed as
    // `typeof fetch | undefined` in some lib configurations; the
    // Node 22 runtime this repo ships against always has it.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    if (options.actingAs !== undefined) this.actingAs = options.actingAs;
  }

  async triggerReview(pr: PrIdentifier, body: string): Promise<ReviewTriggerOutcome> {
    if (this.dryRun) {
      return { posted: false, dryRun: true };
    }
    // Normalize at the boundary: any source (env, secret store,
    // test stub) that returns whitespace-only or null is treated as
    // missing-token uniformly. Without the trim, a whitespace-only
    // token would reach the HTTP layer with an invalid Bearer value
    // and produce an opaque 401 rather than the clean missing-token
    // failure shape callers can surface in an escalation.
    const rawToken = await this.getToken();
    const token = rawToken?.trim() ?? null;
    if (token === null || token === '') {
      return { posted: false, failure: 'missing-token' };
    }
    const url = `${this.apiBase}/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          // `User-Agent` is required by GitHub for all API calls;
          // without it, some endpoints return 403 with an unclear
          // error. The value identifies the adapter in GitHub's
          // access logs (useful when debugging which machine-user
          // call did what).
          'User-Agent': `lag-review-trigger${this.actingAs !== undefined ? `/${this.actingAs}` : ''}`,
        },
        body: JSON.stringify({ body }),
      });
    } catch (err) {
      return {
        posted: false,
        failure: `network: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    if (!response.ok) {
      const status = response.status;
      let detail = '';
      try {
        const text = await response.text();
        detail = text.slice(0, 200);
      } catch {
        // If reading the body also fails, we still report status.
      }
      return {
        posted: false,
        failure: `http-${status}${detail !== '' ? `: ${detail}` : ''}`,
      };
    }
    let json: { id?: number } = {};
    try {
      json = (await response.json()) as { id?: number };
    } catch {
      // Response is 2xx but body is not JSON. Treat as posted
      // without a commentId; caller's audit will still record
      // posted=true.
    }
    const commentId = typeof json.id === 'number' ? String(json.id) : undefined;
    return {
      posted: true,
      ...(commentId !== undefined ? { commentId } : {}),
    };
  }
}

/**
 * Convenience: build a getToken function that reads from a process
 * env var. Separated so callers can plumb any secret source (env,
 * Secret Manager, file-backed store) with zero changes to the
 * adapter itself. Callers choose the environment variable name at
 * composition time.
 */
export function getTokenFromEnv(varName: string): () => Promise<string | null> {
  return async () => {
    const raw = process.env[varName];
    if (raw === undefined || raw.trim() === '') return null;
    return raw;
  };
}
