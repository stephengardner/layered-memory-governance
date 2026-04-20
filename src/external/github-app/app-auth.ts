/**
 * GitHub App authentication primitive.
 *
 * Flow:
 *   1. Sign a short-lived (10 min) RS256 JWT with the App's private key.
 *      Claim set: { iat, exp, iss = appId }.
 *   2. Exchange the JWT for an installation access token by POST to
 *      /app/installations/{installationId}/access_tokens.
 *   3. Use the installation token (valid 1 hour) to call GitHub's REST
 *      API as the App.
 *
 * This module is deliberately dependency-free. `node:crypto` handles
 * RSA signing; `fetch` (built-in on Node 22) handles transport. Docs:
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app
 */

import { createSign } from 'node:crypto';

export interface AppAuthOptions {
  readonly appId: number;
  readonly privateKey: string; // PEM-encoded
  readonly installationId: number;
  readonly now?: () => number; // ms; defaults to Date.now; injectable for tests
  readonly fetchImpl?: typeof fetch;
}

export interface InstallationToken {
  readonly token: string;
  /** ISO string */
  readonly expiresAt: string;
  /** Milliseconds since epoch */
  readonly expiresAtMs: number;
}

/**
 * Create a short-lived App JWT. Valid for 10 minutes, per GitHub's cap.
 */
export function createAppJwt(opts: {
  readonly appId: number;
  readonly privateKey: string;
  readonly now?: () => number;
}): string {
  const nowMs = (opts.now ?? (() => Date.now()))();
  const nowSec = Math.floor(nowMs / 1000);
  // 30 seconds of skew protection on both sides per GitHub's guidance.
  const iat = nowSec - 30;
  const exp = nowSec + 9 * 60; // 9 minutes; below the 10-min cap.
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: opts.appId };
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(opts.privateKey)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${unsigned}.${signature}`;
}

/**
 * Exchange an App JWT for an installation access token.
 */
export async function fetchInstallationToken(opts: AppAuthOptions): Promise<InstallationToken> {
  const jwt = createAppJwt({
    appId: opts.appId,
    privateKey: opts.privateKey,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${opts.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'lag-actor-provisioning',
      },
    },
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`fetchInstallationToken failed: ${res.status} ${res.statusText} :: ${body}`);
  }
  const parsed = JSON.parse(body) as { token: string; expires_at: string };
  const expiresAtMs = new Date(parsed.expires_at).getTime();
  return {
    token: parsed.token,
    expiresAt: parsed.expires_at,
    expiresAtMs,
  };
}

/**
 * Small cache that refreshes installation tokens lazily, renewing when
 * less than `skewMs` remains before expiry. Instantiate once per (App,
 * installation) pair in your process.
 */
export class InstallationTokenCache {
  private current: InstallationToken | null = null;
  constructor(
    private readonly opts: AppAuthOptions,
    private readonly skewMs: number = 2 * 60 * 1000,
  ) {}

  async get(): Promise<string> {
    const now = (this.opts.now ?? (() => Date.now()))();
    if (this.current && this.current.expiresAtMs - now > this.skewMs) {
      return this.current.token;
    }
    this.current = await fetchInstallationToken(this.opts);
    return this.current.token;
  }
}
