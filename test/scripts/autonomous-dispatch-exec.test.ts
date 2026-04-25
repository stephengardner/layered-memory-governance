/**
 * Unit tests for scripts/lib/autonomous-dispatch-exec.mjs.
 *
 * These pure helpers compose with execa inside the dispatch invoker
 * (scripts/invokers/autonomous-dispatch.mjs) to attach App-installation
 * auth to outgoing git commands without leaking the token through
 * argv. The invoker shells out, so the tests cover the load-bearing
 * shape guarantees rather than spawning a child:
 *
 *   - parseRepoSlug accepts only well-formed `owner/repo` strings.
 *   - looksLikeGitPush detects `push` verbs even when git-level `-c`
 *     options precede them (the upstream isPushCommand bails on
 *     non-flag args, so this guards the gap).
 *   - buildAuthedGitInvocation rewrites push argvs to a transient
 *     x-access-token URL and clears the credential helper.
 *   - buildAuthedGitInvocation routes read verbs through the
 *     Bearer extraHeader path the read-only env helper produces.
 *   - The caller-provided env wins over the inherited env, but the
 *     auth env wins over the caller env (a user override cannot
 *     accidentally re-enable a credential helper that would prompt).
 */

import { describe, expect, it } from 'vitest';
import {
  buildAuthedGitInvocation,
  looksLikeGitPush,
  parseRepoSlug,
} from '../../scripts/lib/autonomous-dispatch-exec.mjs';

const TOKEN = 'ghs_test_installation_token_0123456789';
const OWNER = 'stephengardner';
const REPO = 'layered-autonomous-governance';

describe('parseRepoSlug', () => {
  it('returns owner/repo for "owner/repo"', () => {
    expect(parseRepoSlug('foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('trims whitespace', () => {
    expect(parseRepoSlug('  foo/bar  ')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('returns null for missing slash', () => {
    expect(parseRepoSlug('foobar')).toBe(null);
  });

  it('returns null for empty owner', () => {
    expect(parseRepoSlug('/bar')).toBe(null);
  });

  it('returns null for empty repo', () => {
    expect(parseRepoSlug('foo/')).toBe(null);
  });

  it('returns null for non-string', () => {
    expect(parseRepoSlug(undefined)).toBe(null);
    expect(parseRepoSlug(null)).toBe(null);
    expect(parseRepoSlug(42 as unknown as string)).toBe(null);
  });
});

describe('looksLikeGitPush', () => {
  it('detects push verb in a plain argv', () => {
    expect(looksLikeGitPush(['push', 'origin', 'main'])).toBe(true);
  });

  it('detects push verb when `-c k=v` precedes the verb', () => {
    expect(
      looksLikeGitPush([
        '-c', 'user.name=foo',
        '-c', 'user.email=bar@example.com',
        'push', 'origin', 'feat/x',
      ]),
    ).toBe(true);
  });

  it('returns false for read-only verbs', () => {
    expect(looksLikeGitPush(['fetch', 'origin', 'main'])).toBe(false);
    expect(
      looksLikeGitPush(['-c', 'user.name=foo', 'status', '--porcelain']),
    ).toBe(false);
  });

  it('returns false for non-array input', () => {
    expect(looksLikeGitPush(undefined as unknown as string[])).toBe(false);
    expect(looksLikeGitPush(null as unknown as string[])).toBe(false);
  });
});

describe('buildAuthedGitInvocation', () => {
  it('push: rewrites the remote arg to an x-access-token URL', () => {
    const out = buildAuthedGitInvocation({
      args: ['push', 'origin', 'feat/x'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { PATH: '/x' },
    });
    expect(out.args[0]).toBe('push');
    expect(out.args[1]).toBe(
      `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`,
    );
    expect(out.args[2]).toBe('feat/x');
  });

  it('push: clears credential.helper and disables interactive prompt', () => {
    const out = buildAuthedGitInvocation({
      args: ['push', 'origin', 'feat/x'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(out.env.GIT_CONFIG_VALUE_0).toBe('');
    // Bearer must NOT appear on push: GitHub receive-pack rejects it.
    expect(JSON.stringify(out.env)).not.toContain('Bearer');
  });

  it('push: preserves `-c k=v` git-level options that precede the verb', () => {
    const out = buildAuthedGitInvocation({
      args: [
        '-c', 'user.name=foo',
        '-c', 'user.email=foo@example.com',
        'push', 'origin', 'feat/x',
      ],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args.slice(0, 4)).toEqual([
      '-c', 'user.name=foo',
      '-c', 'user.email=foo@example.com',
    ]);
    expect(out.args[4]).toBe('push');
    // Same transient URL pattern at the post-`-c` remote position.
    expect(out.args[5]).toContain(`x-access-token:${TOKEN}`);
  });

  it('read: keeps argv intact and injects Bearer extraHeader', () => {
    const out = buildAuthedGitInvocation({
      args: ['fetch', 'origin', 'main', '--quiet'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { PATH: '/x' },
    });
    expect(out.args).toEqual(['fetch', 'origin', 'main', '--quiet']);
    const headerKey = Object.keys(out.env).find((k) => out.env[k] === 'http.extraHeader');
    expect(headerKey).toBeDefined();
    const valKey = headerKey!.replace('KEY', 'VALUE');
    expect(out.env[valKey]).toBe(`Authorization: Bearer ${TOKEN}`);
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('inherited env stays unless the auth env overrides the same key', () => {
    const out = buildAuthedGitInvocation({
      args: ['fetch', 'origin'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { PATH: '/inherited', GIT_TERMINAL_PROMPT: '1' },
    });
    expect(out.env.PATH).toBe('/inherited');
    // Auth env wins on collision: the inherited '1' is stomped by '0'
    // so a misconfigured environment cannot re-enable the prompt.
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('caller env layers between inherited and auth (auth wins on collision)', () => {
    const out = buildAuthedGitInvocation({
      args: ['fetch', 'origin'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { A: 'inherited' },
      callerEnv: { A: 'caller', B: 'caller-only' },
    });
    expect(out.env.A).toBe('caller');
    expect(out.env.B).toBe('caller-only');
  });
});
