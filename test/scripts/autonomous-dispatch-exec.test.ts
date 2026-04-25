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

  it('returns null for over-segmented input (rejects "org/team/repo" typos)', () => {
    // Regression for the truncate-on-extra-segments footgun: a
    // GH_REPO env typo like 'org/team/repo' must not silently
    // resolve to {owner:'org', repo:'team'} and dispatch against
    // the wrong repo with no diagnostic.
    expect(parseRepoSlug('org/team/repo')).toBe(null);
    expect(parseRepoSlug('a/b/c/d')).toBe(null);
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

  it('returns false for empty argv', () => {
    expect(looksLikeGitPush([])).toBe(false);
  });

  it('returns false when only flags are present and no verb is reachable', () => {
    expect(looksLikeGitPush(['-c', 'user.name=foo'])).toBe(false);
    expect(looksLikeGitPush(['-C', '/tmp/repo'])).toBe(false);
  });

  it('distinguishes the verb from a refspec named "push"', () => {
    // A benign `git fetch origin push` (refspec literally named
    // `push`) must not route into the push-auth path; positional
    // detection guards against the false positive a naive
    // `args.includes('push')` would emit.
    expect(looksLikeGitPush(['fetch', 'origin', 'push'])).toBe(false);
    expect(looksLikeGitPush(['-c', 'user.name=foo', 'fetch', 'origin', 'push'])).toBe(false);
  });

  it('handles `-C dir` and `--` separator', () => {
    expect(looksLikeGitPush(['-C', '/tmp/repo', 'push', 'origin', 'main'])).toBe(true);
    expect(looksLikeGitPush(['-C', '/tmp/repo', 'fetch', 'origin'])).toBe(false);
    // After `--`, the next arg is treated as the verb.
    expect(looksLikeGitPush(['--', 'push', 'origin', 'main'])).toBe(true);
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
    expect(out.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(out.env.GIT_CONFIG_VALUE_0).toBe('');
    // GitHub receive-pack rejects Bearer auth: the http.extraHeader
    // entry that buildReadOnlyEnv emits must NOT appear on push.
    // Asserting the specific keys (not a substring scan) keeps the
    // test stable when env values legitimately contain the literal
    // word 'Bearer' for unrelated reasons.
    const envKeys = Object.keys(out.env);
    expect(envKeys.some((k) => out.env[k] === 'http.extraHeader')).toBe(false);
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
    // Literal env keys: buildReadOnlyEnv emits two GIT_CONFIG
    // pairs -- KEY_0/VALUE_0 for the http.extraHeader Bearer
    // entry, and KEY_1/VALUE_1 to clear credential.helper so a
    // cached PAT cannot cross-pollinate. Asserting the specific
    // slots keeps the test focused; the upstream git-as-push-auth
    // tests already cover the indexing convention.
    expect(out.env.GIT_CONFIG_COUNT).toBe('2');
    expect(out.env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(out.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Bearer ${TOKEN}`);
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
      callerEnv: { A: 'caller', B: 'caller-only', GIT_TERMINAL_PROMPT: '1' },
    });
    expect(out.env.A).toBe('caller');
    expect(out.env.B).toBe('caller-only');
    // Auth env wins over caller env: a caller cannot re-enable the
    // prompt that buildReadOnlyEnv / buildPushEnv pin to '0'.
    // Regression guard: a future refactor that reordered the spread
    // to `{...buildReadOnlyEnv(token), ...callerEnv}` would silently
    // let an ambient askpass back in and hang the dispatch.
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('buildAuthedGitInvocation throws when the rewriter cannot translate the remote', () => {
    // Regression for the silent-auth-strip footgun: when
    // buildPushSpawnArgs returns null (no remote position to
    // rewrite, or a non-GitHub HTTPS shape), falling through with
    // buildPushEnv() would clear credential.helper without
    // supplying a replacement and the push would hang or fail with
    // no useful diagnostic. Throw so the caller sees the
    // misconfiguration immediately.
    //
    // Trigger the null path with a bare `git push` (no remote arg)
    // -- buildPushSpawnArgs's findRemoteArg returns null in that
    // case, and the helper short-circuits to null.
    expect(() =>
      buildAuthedGitInvocation({
        args: ['push'],
        token: TOKEN,
        repoOwner: OWNER,
        repoName: REPO,
        inheritedEnv: {},
      }),
    ).toThrow(/cannot rewrite push/);
  });
});
