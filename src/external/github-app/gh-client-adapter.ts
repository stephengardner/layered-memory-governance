/**
 * GhClient adapter backed by GitHub App authentication (Phase 59).
 *
 * Per D19, LAG actors are written against the `GhClient` interface.
 * That interface originally wrapped the `gh` CLI (user PAT / OAuth).
 * This adapter exposes the SAME shape on top of `AppAuthedFetch`, so
 * swapping identity backends is a one-line change in the consumer:
 *
 *   // PAT-backed: actions show as the operator
 *   const client = createGhClient();
 *
 *   // App-backed: actions show as <slug>[bot]
 *   const client = createAppBackedGhClient({ credentials, privateKey });
 *
 *   const actor = new PrLandingActor({ client, ... });
 *
 * The Actor code is identical in both modes.
 *
 * Scope note: `.raw()` (gh-CLI passthrough) is not implementable over
 * pure HTTP; this adapter throws on `.raw()`. Actors that need it
 * should be factored to use `.rest()` or `.graphql()` instead, which
 * is where they should have been all along.
 */

import type {
  GhClient,
  GhExecResult,
  GhExecutor,
  GhRestArgs,
} from '../github/gh-client.js';
import { GhClientError } from '../github/gh-client.js';
import type { AppAuthOptions } from './app-auth.js';
import { createAppAuthedFetch } from './app-client.js';

const GRAPHQL_ENDPOINT = '/graphql';

export interface AppBackedGhClientOptions {
  /** App auth options; the same shape `createAppAuthedFetch` takes. */
  readonly auth: AppAuthOptions;
}

/**
 * Build a GhClient-shaped object whose HTTP calls authenticate as the
 * supplied GitHub App installation. Returned client is indistinguishable
 * from the `createGhClient()` output at the Actor boundary, except that
 * actions appear on GitHub as `<app-slug>[bot]` instead of as the
 * operator's user account.
 */
export function createAppBackedGhClient(
  opts: AppBackedGhClientOptions,
): GhClient {
  const fetchApp = createAppAuthedFetch(opts.auth);

  // The GhClient interface requires `executor`; we synthesize one that
  // throws so tests / consumers do not accidentally hit the gh CLI
  // through an App-backed client.
  const executor: GhExecutor = async () => {
    throw new Error('createAppBackedGhClient: .executor is not available; use .rest or .graphql');
  };

  async function raw(_args: ReadonlyArray<string>): Promise<GhExecResult> {
    throw new Error('createAppBackedGhClient: .raw is not supported over App-auth HTTP; refactor to .rest / .graphql');
  }

  async function rest<T>(args: GhRestArgs): Promise<T | undefined> {
    const method = args.method ?? 'GET';
    const path = args.path.startsWith('http') || args.path.startsWith('/')
      ? applyQueryString(args.path, args.query)
      : applyQueryString(`/${args.path}`, args.query);

    const init: RequestInit = { method, headers: {} };
    if (args.fields && Object.keys(args.fields).length > 0) {
      // Mirror gh's --field semantics: all values serialize as a JSON
      // body. `gh api` with `--raw-field` treats the value as a literal
      // string; our fetch does the same by embedding the value
      // verbatim in the JSON object.
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(args.fields);
    }

    const res = await fetchApp(path, init);
    const text = await res.text();
    if (!res.ok) {
      throw new GhClientError(
        `rest ${method} ${path} failed`,
        [method, path],
        { stdout: text, stderr: res.statusText, exitCode: res.status },
      );
    }
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new GhClientError(
        `rest ${method} ${path} returned non-JSON: ${(err as Error).message}`,
        [method, path],
        { stdout: text, stderr: '', exitCode: 0 },
      );
    }
  }

  async function graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    const res = await fetchApp(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GhClientError(
        'graphql request failed',
        ['graphql'],
        { stdout: text, stderr: res.statusText, exitCode: res.status },
      );
    }
    let parsed: { data: T; errors?: ReadonlyArray<{ message: string }> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (err) {
      throw new GhClientError(
        `graphql returned non-JSON: ${(err as Error).message}`,
        ['graphql'],
        { stdout: text, stderr: '', exitCode: 0 },
      );
    }
    if (parsed.errors && parsed.errors.length > 0) {
      throw new GhClientError(
        `GraphQL returned errors: ${parsed.errors.map((e) => e.message).join('; ')}`,
        ['graphql'],
        { stdout: text, stderr: '', exitCode: 0 },
      );
    }
    return parsed.data;
  }

  return { executor, rest, graphql, raw };
}

function applyQueryString(
  path: string,
  query: Readonly<Record<string, string | number>> | undefined,
): string {
  if (!query || Object.keys(query).length === 0) return path;
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${qs}`;
}
