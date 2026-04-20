/**
 * AppBackedGhClient adapter tests (Phase 59).
 *
 * Uses a stub fetch to assert:
 *   - REST call shape (method, URL path, JSON body, query string)
 *   - GraphQL call shape (/graphql POST with { query, variables })
 *   - JSON parsing of success responses
 *   - GhClientError on non-2xx
 *   - GhClientError on GraphQL `errors` array
 *   - raw() throws (not supported over HTTP auth)
 *   - executor() throws (cannot shell out)
 *   - Every call carries an installation token header (not JWT)
 */

import { describe, expect, it } from 'vitest';
import { createAppBackedGhClient } from '../../../src/external/github-app/gh-client-adapter.js';
import { GhClientError } from '../../../src/external/github/gh-client.js';

// Minimal RSA PKCS1 key for JWT signing in tests. Small enough to ship
// inline (512-bit, NOT for production use, but valid for signing that
// node:crypto accepts). Generated offline with openssl.
const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAMfo2pZGpvrnxuQ0vB6l1DYx2vnXg/zvzbZ0dQKBZhYoZeuRCOUV
9jKOoGvRQWtpkmN9X6GSKJbjnW3rV8MuG5MCAwEAAQJAEYn0JhIZJ0MDcabGTHvF
OzHoL+EvsPfsnWtSOTg9fFfJ2kHJoX5SaDKvnCfBkWLUPdOnIEQ7CXJUCaNVrJvi
4QIhAPjE6dH8yGZxcBpGN9tFp6Rz0Rn86pZ4PdBMWZXlpjEDAiEAzgZhpQxzqCNx
fCn1Ye/UrHJzz0n4XKjNV8wjSggsLpECIDjjUoBQvvuk2oJG5EvLiEBK8U2xOGJ5
OgQ1sw2SMfYvAiAQhPIAHfC6eX9EZHPF9aLm2Vo4EzlBJu1/ZETeDK4aMQIhAJrN
EdQCFWdbJbH+2QaJWsYmUqYxVxSWmOSRqGCc5Tor
-----END RSA PRIVATE KEY-----
`;

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

function mkStubFetch(responses: ReadonlyArray<{
  status: number;
  body: string;
}>): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    }
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, headers, body });
    const r = responses[i] ?? { status: 200, body: '{}' };
    i++;
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch) {
  // We need an installation-token fetch to succeed so the adapter
  // reaches its business-logic calls. The token-fetch always comes
  // first on any call since the cache is empty.
  return createAppBackedGhClient({
    auth: {
      appId: 12345,
      privateKey: TEST_PRIVATE_KEY,
      installationId: 99999,
      fetchImpl,
    },
  });
}

describe('AppBackedGhClient', () => {
  it('rest GET prepends /, attaches installation token, parses JSON', async () => {
    const { fetchImpl, calls } = mkStubFetch([
      // 1. token exchange
      { status: 201, body: JSON.stringify({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      // 2. the actual REST call
      { status: 200, body: JSON.stringify({ login: 'octocat', id: 1 }) },
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.rest<{ login: string }>({ path: '/users/octocat' });
    expect(result).toEqual({ login: 'octocat', id: 1 });

    // Token fetch is first.
    expect(calls[0]!.url).toMatch(/\/app\/installations\/99999\/access_tokens$/);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer /);

    // Business call carries installation token.
    expect(calls[1]!.url).toBe('https://api.github.com/users/octocat');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.headers.authorization).toBe('token ghs_installation');
  });

  it('rest POST with fields serializes JSON body', async () => {
    const { fetchImpl, calls } = mkStubFetch([
      { status: 201, body: JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      { status: 201, body: JSON.stringify({ id: 42 }) },
    ]);
    const client = makeClient(fetchImpl);
    await client.rest<{ id: number }>({
      method: 'POST',
      path: '/repos/a/b/issues/1/comments',
      fields: { body: '@coderabbitai please review' },
    });
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ body: '@coderabbitai please review' });
  });

  it('rest attaches query params', async () => {
    const { fetchImpl, calls } = mkStubFetch([
      { status: 201, body: JSON.stringify({ token: 'ghs_q', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      { status: 200, body: '[]' },
    ]);
    const client = makeClient(fetchImpl);
    await client.rest<unknown[]>({
      path: '/repos/a/b/pulls',
      query: { state: 'open', per_page: 30 },
    });
    expect(calls[1]!.url).toBe('https://api.github.com/repos/a/b/pulls?state=open&per_page=30');
  });

  it('rest throws GhClientError on non-2xx', async () => {
    const { fetchImpl } = mkStubFetch([
      { status: 201, body: JSON.stringify({ token: 'ghs_e', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      { status: 404, body: JSON.stringify({ message: 'Not Found' }) },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.rest({ path: '/nope' })).rejects.toBeInstanceOf(GhClientError);
  });

  it('graphql POSTs to /graphql with query + variables', async () => {
    const { fetchImpl, calls } = mkStubFetch([
      { status: 201, body: JSON.stringify({ token: 'ghs_g', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      { status: 200, body: JSON.stringify({ data: { viewer: { login: 'bot' } } }) },
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.graphql<{ viewer: { login: string } }>(
      'query { viewer { login } }',
      { x: 1 },
    );
    expect(result).toEqual({ viewer: { login: 'bot' } });
    expect(calls[1]!.url).toBe('https://api.github.com/graphql');
    expect(calls[1]!.method).toBe('POST');
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      query: 'query { viewer { login } }',
      variables: { x: 1 },
    });
  });

  it('graphql throws when response has errors', async () => {
    const { fetchImpl } = mkStubFetch([
      { status: 201, body: JSON.stringify({ token: 'ghs_ge', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      { status: 200, body: JSON.stringify({ data: null, errors: [{ message: 'bad field' }] }) },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.graphql('{ nope }')).rejects.toBeInstanceOf(GhClientError);
  });

  it('raw() throws; executor() throws (use .rest / .graphql instead)', async () => {
    const { fetchImpl } = mkStubFetch([]);
    const client = makeClient(fetchImpl);
    await expect(client.raw(['api', 'user'])).rejects.toThrow(/raw is not supported/);
    await expect(client.executor([], undefined)).rejects.toThrow(/executor is not available/);
  });

  it('caches installation token across calls', async () => {
    const { fetchImpl, calls } = mkStubFetch([
      { status: 201, body: JSON.stringify({ token: 'ghs_cached', expires_at: new Date(Date.now() + 3600_000).toISOString() }) },
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
    ]);
    const client = makeClient(fetchImpl);
    await client.rest({ path: '/a' });
    await client.rest({ path: '/b' });
    // One token fetch, two business calls: three total.
    expect(calls.length).toBe(3);
    expect(calls[0]!.url).toMatch(/access_tokens/);
    expect(calls[1]!.url).toMatch(/\/a$/);
    expect(calls[2]!.url).toMatch(/\/b$/);
  });
});
