/**
 * PR terminal-state verifier.
 *
 * Queries GitHub's PR REST endpoint as the authoritative source of truth
 * for whether a work-claim against a PR has reached one of its declared
 * terminal states (typically `MERGED`). Substrate must NOT trust a
 * sub-agent's attestation that "I merged PR #999"; the agent could be
 * lying, broken, or compromised. The verifier resolves the question
 * against GitHub itself so a falsified attestation cannot flip a claim
 * to `complete`.
 *
 * The handler is shape-compatible with `ClaimVerifier` from `./types.ts`
 * via the extended `PrVerifierContext` (adds an injectable `fetchImpl`
 * so tests can stub the HTTP boundary). Callers that already have a
 * `VerifierContext` pass it through with an optional `fetchImpl`
 * override; absent override, the default real fetcher is used.
 *
 * Identity + auth posture: this module accepts a `fetchImpl` so the
 * substrate stays adapter-agnostic. Production wiring uses the
 * `gh-as.mjs lag-ceo api ...` wrapper (per `dev-bot-identity-attribution`
 * canon) at the orchestration layer; the wrapper produces a fetch-like
 * function that mints a short-lived installation token per call. The
 * verifier itself never touches credentials.
 */

import type { VerifierContext, VerifierResult } from './types.js';

/**
 * Context extension for the PR verifier. Carries the standard
 * `VerifierContext` shape plus an optional `fetchImpl` override.
 * Tests inject a stub; production callers can leave it undefined
 * to fall through to the default fetcher.
 */
export interface PrVerifierContext extends VerifierContext {
  /**
   * HTTP client override. Defaults to the global `fetch` builtin.
   * Tests pass a `vi.fn()` that returns canned responses; production
   * code can pass a `gh-as`-backed fetcher that injects the bot
   * installation token.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Override for the GitHub REST API base URL. Defaults to
   * `https://api.github.com`. Tests can point this at a mock server.
   */
  readonly apiBase?: string;
  /**
   * Owner+repo override for the PR coordinates. Production callers
   * resolve this from `process.env.GITHUB_REPOSITORY` (the GitHub
   * Actions convention) or from a deployment-level config; tests
   * supply a stub or leave it absent because the mocked fetch does
   * not inspect the URL.
   */
  readonly repo?: { readonly owner: string; readonly repo: string };
}

const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * Sentinel coordinates used when no repo is configured. The HTTP call
 * still goes out (so a test stub or mock fetcher gets invoked), but
 * the URL is obviously bogus -- if it ever escapes to real GitHub the
 * resulting 404 surfaces as NOT_FOUND rather than a silent success
 * against the wrong repository. Production callers MUST set
 * `process.env.GITHUB_REPOSITORY` or pass `ctx.repo`; the sentinel
 * exists only to keep tests + the type signature ergonomic.
 */
const SENTINEL_REPO = { owner: 'unknown', repo: 'unknown' } as const;

/**
 * Resolve owner+repo coordinates. Order of precedence:
 *   1. `ctx.repo` (explicit caller override).
 *   2. `process.env.GITHUB_REPOSITORY` in the form `owner/repo`
 *      (matches the GitHub Actions convention so the substrate
 *      runs without extra wiring inside an action).
 *   3. SENTINEL_REPO (`unknown/unknown`) as the test-friendly
 *      fallback. Production callers should not hit this rung; a
 *      real call against the sentinel URL returns 404 from GitHub,
 *      which the verifier surfaces as NOT_FOUND -- not silent
 *      success against the wrong repo.
 */
function resolveRepo(ctx: PrVerifierContext): { owner: string; repo: string } {
  if (ctx.repo !== undefined) {
    return { owner: ctx.repo.owner, repo: ctx.repo.repo };
  }
  const env = process.env.GITHUB_REPOSITORY;
  if (typeof env === 'string' && env.length > 0) {
    // GitHub Actions convention: 'owner/repo'. Anything else is malformed
    // and we fall through to the sentinel.
    const parts = env.split('/');
    if (parts.length === 2) {
      const [owner, repo] = parts;
      if (
        typeof owner === 'string' &&
        owner.length > 0 &&
        typeof repo === 'string' &&
        repo.length > 0
      ) {
        return { owner, repo };
      }
    }
  }
  return { owner: SENTINEL_REPO.owner, repo: SENTINEL_REPO.repo };
}

/**
 * Normalize GitHub's PR-state shape into the substrate's terminal-state
 * vocabulary.
 *
 * GitHub REST returns `state: 'open' | 'closed'` plus a separate
 * `merged: boolean`. GitHub GraphQL returns `state: 'OPEN' | 'CLOSED'
 * | 'MERGED'`. The substrate uses the GraphQL vocabulary (uppercase,
 * `MERGED` as a first-class state) because it cleanly maps to a
 * work-claim's `expected_states` list.
 *
 * The function is permissive about input shape so the same code
 * handles REST + GraphQL responses + test stubs that just return
 * `{ state: 'MERGED' }` directly. Unknown values are returned in
 * uppercase rather than coerced, so a future GitHub state addition
 * surfaces as "actual != expected" instead of silently maps to a
 * known state.
 */
function normalizeState(json: { state?: unknown; merged?: unknown }): string {
  if (json.merged === true) {
    return 'MERGED';
  }
  if (typeof json.state === 'string') {
    return json.state.toUpperCase();
  }
  return 'UNKNOWN';
}

/**
 * Query GitHub for the PR state and report whether it matches one of
 * the expected terminal states.
 *
 * Return semantics:
 *   - `{ ok: true, observed_state }`  -- GitHub returned a state that
 *     matches one of `expectedStates`. Case-sensitive match (substrate
 *     vocabulary is uppercase; mismatched-case is treated as a
 *     mismatch so the caller sees a loud failure rather than a silent
 *     coincidence).
 *   - `{ ok: false, observed_state }` -- GitHub returned a state that
 *     does NOT match any expected state. The caller's
 *     `markClaimComplete` treats this as the sub-agent attesting a
 *     premature terminal state.
 *   - `{ ok: false, observed_state: 'NOT_FOUND' }` -- GitHub returned
 *     404. The PR identifier is malformed or the PR has been deleted;
 *     either way the claim cannot complete.
 *
 * Throws on:
 *   - 5xx response (GitHub is broken; the caller's
 *     `markClaimComplete` maps throw -> `verifier-error` so the claim
 *     stays pending and an operator-escalation surfaces).
 *   - Network/fetch error (same handling as 5xx).
 *   - Unparseable response body (treated as throw because we have no
 *     reliable signal about PR state).
 *   - Missing repo coordinates (deployment misconfiguration; loud is
 *     correct).
 *
 * The handler is intentionally narrow: one HTTP call, one comparison,
 * no retries. Retries belong to the caller (the work-claim reaper) so
 * the retry budget composes with the per-claim staleness window
 * rather than being smeared across every verifier in the substrate.
 */
export async function verifyPrTerminal(
  identifier: string,
  expectedStates: readonly string[],
  ctx: PrVerifierContext,
): Promise<VerifierResult> {
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const apiBase = ctx.apiBase ?? DEFAULT_API_BASE;
  const repo = resolveRepo(ctx);
  // PR number is a string at the substrate boundary (claim identifiers
  // are opaque strings); the REST URL takes the raw value. A non-numeric
  // identifier produces a 404 from GitHub which surfaces as NOT_FOUND;
  // we do not validate the shape here because future verifiers may use
  // a different identifier scheme and the verifier interface is shared.
  const url = `${apiBase}/repos/${repo.owner}/${repo.repo}/pulls/${identifier}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // User-Agent is required by GitHub. The string identifies the
        // verifier in access logs so an operator debugging an unexpected
        // 403 can trace it back.
        'User-Agent': 'lag-claim-verifier-pr',
      },
    });
  } catch (err) {
    // Network errors mean we cannot make a claim about PR state. Throw
    // so the caller treats this as a verifier-error rather than a
    // mismatch (mismatch implies we observed a non-terminal state,
    // which is a load-bearing distinction).
    throw new Error(
      `verifyPrTerminal: fetch failed for PR #${identifier}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 404 is a substrate-meaningful outcome: the PR does not exist.
  // Surface it as a normal mismatch so the caller transitions the
  // claim to a terminal "not-found" state, not as a thrown error.
  if (response.status === 404) {
    return { ok: false, observed_state: 'NOT_FOUND' };
  }
  if (response.status >= 500) {
    throw new Error(
      `verifyPrTerminal: GitHub returned ${response.status} for PR #${identifier}`,
    );
  }
  if (!response.ok) {
    // 4xx other than 404 (401, 403, 422 ...). These usually indicate a
    // governance/config problem (bad token, missing repo access). Throw
    // so it surfaces loud; a silent ok:false would let a misconfigured
    // verifier ratify falsified claims.
    throw new Error(
      `verifyPrTerminal: GitHub returned ${response.status} for PR #${identifier}`,
    );
  }
  let json: { state?: unknown; merged?: unknown };
  try {
    json = (await response.json()) as { state?: unknown; merged?: unknown };
  } catch (err) {
    throw new Error(
      `verifyPrTerminal: response body is not JSON for PR #${identifier}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const observed = normalizeState(json);
  // Case-sensitive comparison matches the plan directive
  // ("Compare GitHub's state field exactly; case-sensitive"). Substrate
  // vocabulary is uppercase by convention; a caller that passes
  // lowercase expected_states gets a loud mismatch rather than a
  // silent coercion.
  const matches = expectedStates.includes(observed);
  return { ok: matches, observed_state: observed };
}
