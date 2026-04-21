/**
 * Unit tests for UserAccountCommentTrigger.
 *
 * Covers the load-bearing behaviors:
 *   - dry-run short-circuits (no POST, returns dryRun:true)
 *   - missing token returns posted:false with failure=missing-token
 *     (without throwing, so callers can surface a clean escalation)
 *   - successful POST returns posted:true + commentId from response
 *   - HTTP error surfaces as posted:false + failure=http-<status>
 *     with a detail fragment clipped to 200 chars
 *   - network/throw error surfaces as posted:false + failure=network:<msg>
 *   - Authorization header uses Bearer <token>
 *   - User-Agent header identifies the adapter (required by GitHub)
 *   - URL shape is /repos/{owner}/{repo}/issues/{number}/comments
 *     (the issue-comments endpoint; top-level PR comments land here)
 */

import { describe, expect, it, vi } from 'vitest';
import {
  UserAccountCommentTrigger,
  getTokenFromEnv,
} from '../../../src/actors/pr-review/review-trigger.js';
import type { PrIdentifier } from '../../../src/actors/pr-review/adapter.js';

const PR: PrIdentifier = { owner: 'o', repo: 'r', number: 42 };

function mkResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('UserAccountCommentTrigger', () => {
  it('short-circuits in dry-run without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => 'ghp_test',
      dryRun: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, '@coderabbitai review');
    expect(out.posted).toBe(false);
    expect(out.dryRun).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns missing-token when getToken resolves null', async () => {
    const fetchImpl = vi.fn();
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, '@coderabbitai review');
    expect(out.posted).toBe(false);
    expect(out.failure).toBe('missing-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns missing-token when getToken resolves empty string', async () => {
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => '',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, '@coderabbitai review');
    expect(out.failure).toBe('missing-token');
  });

  it('returns missing-token when getToken resolves whitespace-only string', async () => {
    const fetchImpl = vi.fn();
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => '   \t\n  ',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, 'body');
    expect(out.failure).toBe('missing-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace on a valid token before using it in Bearer auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mkResponse(201, { id: 7 }));
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => '  ghp_padded  ',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, 'body');
    expect(out.posted).toBe(true);
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_padded');
  });

  it('POSTs to the issue-comments endpoint with Bearer auth + UA + body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mkResponse(201, { id: 12345 }));
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => 'ghp_secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      actingAs: 'lag-ops',
    });
    const out = await trigger.triggerReview(PR, '@coderabbitai review');

    expect(out.posted).toBe(true);
    expect(out.commentId).toBe('12345');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/o/r/issues/42/comments');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_secret');
    expect(headers['User-Agent']).toContain('lag-review-trigger');
    expect(headers['User-Agent']).toContain('lag-ops');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(init.body).toBe(JSON.stringify({ body: '@coderabbitai review' }));
  });

  it('posted:true without commentId when response body is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('not json', { status: 201, headers: { 'Content-Type': 'text/plain' } }),
    );
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => 'ghp_x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, '@x review');
    expect(out.posted).toBe(true);
    expect(out.commentId).toBeUndefined();
  });

  it('surfaces HTTP error as failure=http-<status> with body detail clipped', async () => {
    const longBody = 'A'.repeat(500);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(longBody, { status: 403 }));
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => 'ghp_x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, 'body');
    expect(out.posted).toBe(false);
    expect(out.failure).toMatch(/^http-403: /);
    expect(out.failure!.length).toBeLessThanOrEqual('http-403: '.length + 200);
  });

  it('surfaces network error as failure=network:<msg>', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => 'ghp_x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await trigger.triggerReview(PR, 'body');
    expect(out.posted).toBe(false);
    expect(out.failure).toBe('network: ECONNRESET');
  });

  it('honors apiBase override so tests can point at a mock server', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mkResponse(201, { id: 1 }));
    const trigger = new UserAccountCommentTrigger({
      getToken: async () => 'ghp_x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiBase: 'http://mock.example',
    });
    await trigger.triggerReview(PR, 'body');
    const [url] = fetchImpl.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://mock.example/repos/o/r/issues/42/comments');
  });
});

describe('getTokenFromEnv', () => {
  it('returns the env var value when set', async () => {
    const prior = process.env.LAG_TEST_TOKEN;
    process.env.LAG_TEST_TOKEN = 'ghp_env';
    try {
      const fn = getTokenFromEnv('LAG_TEST_TOKEN');
      expect(await fn()).toBe('ghp_env');
    } finally {
      if (prior === undefined) delete process.env.LAG_TEST_TOKEN;
      else process.env.LAG_TEST_TOKEN = prior;
    }
  });

  it('returns null when the env var is unset', async () => {
    const prior = process.env.LAG_TEST_TOKEN;
    delete process.env.LAG_TEST_TOKEN;
    try {
      const fn = getTokenFromEnv('LAG_TEST_TOKEN');
      expect(await fn()).toBeNull();
    } finally {
      if (prior !== undefined) process.env.LAG_TEST_TOKEN = prior;
    }
  });

  it('returns null when the env var is an empty/whitespace string', async () => {
    const prior = process.env.LAG_TEST_TOKEN;
    process.env.LAG_TEST_TOKEN = '   ';
    try {
      const fn = getTokenFromEnv('LAG_TEST_TOKEN');
      expect(await fn()).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.LAG_TEST_TOKEN;
      else process.env.LAG_TEST_TOKEN = prior;
    }
  });
});
