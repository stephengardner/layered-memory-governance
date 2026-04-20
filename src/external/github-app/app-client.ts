/**
 * High-level GitHub client that authenticates as a GitHub App and
 * exposes the handful of operations Actors need.
 *
 * Intentionally small: this is the minimum surface to validate the
 * end-to-end provisioning flow (convert manifest code -> App creds,
 * list installations, get a repo, open a PR). More methods land on
 * demand, one per consumer Actor.
 */

import type { AppAuthOptions, InstallationToken } from './app-auth.js';
import { createAppJwt, InstallationTokenCache } from './app-auth.js';

const API = 'https://api.github.com';

export interface AppManifestConversionResult {
  readonly id: number;
  readonly slug: string;
  readonly owner: { readonly login: string; readonly type: string };
  readonly pem: string; // PEM private key
  readonly webhook_secret: string | null;
  readonly client_id: string;
  readonly client_secret: string;
}

/**
 * Exchange a manifest `code` (from GitHub's callback) for a new App's
 * credentials. This is an unauthenticated call; the code itself is the
 * bearer of proof. One-time-use, ~1 hour TTL on GitHub's side.
 */
export async function convertManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppManifestConversionResult> {
  const res = await fetchImpl(`${API}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lag-actor-provisioning',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `convertManifestCode failed: ${res.status} ${res.statusText} :: ${body}`,
    );
  }
  return JSON.parse(body) as AppManifestConversionResult;
}

export interface AppInstallation {
  readonly id: number;
  readonly account: { readonly login: string; readonly type: string };
  readonly repository_selection: 'all' | 'selected';
}

/**
 * List the installations of this App (where it's been installed on an
 * org/user). Requires App JWT auth.
 */
export async function listAppInstallations(opts: {
  readonly appId: number;
  readonly privateKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<ReadonlyArray<AppInstallation>> {
  const jwt = createAppJwt({ appId: opts.appId, privateKey: opts.privateKey });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${API}/app/installations`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lag-actor-provisioning',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`listAppInstallations failed: ${res.status} ${res.statusText} :: ${body}`);
  }
  return JSON.parse(body) as ReadonlyArray<AppInstallation>;
}

export interface AppAuthedFetch {
  (path: string, init?: RequestInit): Promise<Response>;
}

/**
 * Build a fetch wrapper that injects a fresh installation token on
 * every call. Pass absolute URLs or /path (we prefix with the API
 * origin).
 */
export function createAppAuthedFetch(
  opts: AppAuthOptions,
): AppAuthedFetch {
  const cache = new InstallationTokenCache(opts);
  const baseFetch = opts.fetchImpl ?? fetch;
  return async (path, init = {}) => {
    const token = await cache.get();
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `token ${token}`);
    if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
    if (!headers.has('user-agent')) headers.set('user-agent', 'lag-actor-provisioning');
    headers.set('x-github-api-version', '2022-11-28');
    return baseFetch(url, { ...init, headers });
  };
}

/**
 * Open a pull request on the given repo as the App. Returns the PR URL.
 *
 * Assumes `branch` already exists on the repo; callers who need to
 * commit files first should do so through the same authed-fetch using
 * the contents API.
 */
export async function openPullRequest(opts: {
  readonly fetch: AppAuthedFetch;
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly head: string; // source branch
  readonly base: string; // target branch
}): Promise<{ readonly url: string; readonly number: number }> {
  const res = await opts.fetch(`/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`openPullRequest failed: ${res.status} ${res.statusText} :: ${text}`);
  }
  const parsed = JSON.parse(text) as { html_url: string; number: number };
  return { url: parsed.html_url, number: parsed.number };
}

/**
 * Create or update a file on a branch using the Contents API. This is
 * the simplest path to "the App commits something" without needing a
 * local git clone.
 */
export async function upsertFile(opts: {
  readonly fetch: AppAuthedFetch;
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  readonly content: string; // raw UTF-8; we base64-encode
  readonly message: string;
  readonly sha?: string; // existing file sha if updating
}): Promise<{ readonly sha: string }> {
  const body = {
    message: opts.message,
    branch: opts.branch,
    content: Buffer.from(opts.content, 'utf8').toString('base64'),
    ...(opts.sha ? { sha: opts.sha } : {}),
  };
  const res = await opts.fetch(`/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upsertFile failed: ${res.status} ${res.statusText} :: ${text}`);
  }
  const parsed = JSON.parse(text) as { content: { sha: string } };
  return { sha: parsed.content.sha };
}

/**
 * Create a new branch from an existing ref. Uses the Git Refs API.
 */
export async function createBranch(opts: {
  readonly fetch: AppAuthedFetch;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly fromSha: string;
}): Promise<void> {
  const res = await opts.fetch(`/repos/${opts.owner}/${opts.repo}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ref: `refs/heads/${opts.branch}`,
      sha: opts.fromSha,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createBranch failed: ${res.status} ${res.statusText} :: ${text}`);
  }
}

/**
 * Get the commit SHA of a branch head.
 */
export async function getBranchSha(opts: {
  readonly fetch: AppAuthedFetch;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}): Promise<string> {
  const res = await opts.fetch(
    `/repos/${opts.owner}/${opts.repo}/branches/${opts.branch}`,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`getBranchSha failed: ${res.status} ${res.statusText} :: ${text}`);
  }
  const parsed = JSON.parse(text) as { commit: { sha: string } };
  return parsed.commit.sha;
}
