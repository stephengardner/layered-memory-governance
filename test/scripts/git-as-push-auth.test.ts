/**
 * Unit tests for scripts/lib/git-as-push-auth.mjs.
 *
 * The wrapper script (scripts/git-as.mjs) composes these pure
 * helpers with an execa spawn of the git CLI. These tests cover the
 * load-bearing shape guarantees:
 *
 *   - push invocations spawn git with a URL containing
 *     `x-access-token:` (the documented GitHub installation-token
 *     basic-auth form).
 *   - push invocations do NOT carry `Authorization: Bearer` in the
 *     child env (GitHub receive-pack rejects Bearer with 401 /
 *     www-authenticate: Basic).
 *   - non-push invocations DO carry the Bearer extraHeader
 *     (unchanged from the pre-fix behaviour where read-only verbs
 *     still work with Bearer).
 *   - `credential.helper=''` and `GIT_TERMINAL_PROMPT=0` are present
 *     on BOTH paths so neither a cached PAT nor a hung askpass can
 *     cross-pollinate or stall.
 *   - SSH / enterprise / bare-push shapes fall through to the
 *     Bearer path instead of mis-rewriting a URL we don't understand.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPushEnv,
  buildPushSpawnArgs,
  buildReadOnlyEnv,
  buildTransientPushUrl,
  extractSetUpstreamPlan,
  findRemoteArg,
  isPushCommand,
  parseGithubHttps,
} from '../../scripts/lib/git-as-push-auth.mjs';

const FAKE_TOKEN = 'ghs_test_installation_token_0123456789';

describe('isPushCommand', () => {
  it('returns true for bare push', () => {
    expect(isPushCommand(['push'])).toBe(true);
  });

  it('returns true for `push <args>`', () => {
    expect(isPushCommand(['push', '-u', 'origin', 'feat/x'])).toBe(true);
  });

  it('returns true for `-C <dir> push` (skips git-level value-taking flag)', () => {
    expect(isPushCommand(['-C', '/tmp/repo', 'push', 'origin'])).toBe(true);
  });

  it('returns true for `-c <name=value> push` (config override before subcommand)', () => {
    expect(isPushCommand(['-c', 'http.proxy=http://example.com', 'push', 'origin'])).toBe(true);
  });

  it('returns true for `--config-env <name=envvar> push` (env-derived config override)', () => {
    expect(isPushCommand(['--config-env', 'http.extraHeader=MY_ENV', 'push', 'origin'])).toBe(true);
  });

  it('returns true for `--git-dir <path> push`', () => {
    expect(isPushCommand(['--git-dir', '/tmp/repo/.git', 'push', 'origin'])).toBe(true);
  });

  it('returns true for `--work-tree <path> push`', () => {
    expect(isPushCommand(['--work-tree', '/tmp/repo', 'push', 'origin'])).toBe(true);
  });

  it('returns true for inline `--git-dir=<path> push` (single token)', () => {
    expect(isPushCommand(['--git-dir=/tmp/repo/.git', 'push', 'origin'])).toBe(true);
  });

  it('returns true for combined `-C <dir> -c <kv> push`', () => {
    expect(isPushCommand(['-C', '/tmp/repo', '-c', 'foo=bar', 'push', 'origin'])).toBe(true);
  });

  it('returns false for fetch', () => {
    expect(isPushCommand(['fetch', 'origin'])).toBe(false);
  });

  it('returns false for pull', () => {
    expect(isPushCommand(['pull', '--rebase'])).toBe(false);
  });

  it('returns false for empty args', () => {
    expect(isPushCommand([])).toBe(false);
  });
});

describe('findRemoteArg', () => {
  it('finds explicit origin', () => {
    const r = findRemoteArg(['push', 'origin', 'feat/x']);
    expect(r).toEqual({ remoteIndex: 1, remote: 'origin' });
  });

  it('finds a non-origin remote', () => {
    const r = findRemoteArg(['push', 'upstream', 'main']);
    expect(r).toEqual({ remoteIndex: 1, remote: 'upstream' });
  });

  it('skips boolean flags', () => {
    const r = findRemoteArg(['push', '-u', '--force', 'origin', 'feat/x']);
    expect(r).toEqual({ remoteIndex: 3, remote: 'origin' });
  });

  it('skips value-taking --repo separate arg', () => {
    const r = findRemoteArg(['push', '--repo', 'other', 'origin', 'feat/x']);
    expect(r).toEqual({ remoteIndex: 3, remote: 'origin' });
  });

  it('skips value-taking --receive-pack separate arg', () => {
    const r = findRemoteArg(['push', '--receive-pack', '/usr/bin/git-receive-pack', 'origin']);
    expect(r).toEqual({ remoteIndex: 3, remote: 'origin' });
  });

  it('treats inline --flag=value as a single token', () => {
    const r = findRemoteArg(['push', '--repo=other', 'origin', 'feat/x']);
    expect(r).toEqual({ remoteIndex: 2, remote: 'origin' });
  });

  it('returns null on bare push', () => {
    expect(findRemoteArg(['push'])).toBe(null);
  });

  it('returns null when only flags are present', () => {
    expect(findRemoteArg(['push', '--force', '--tags'])).toBe(null);
  });

  it('honours `--` end-of-options', () => {
    const r = findRemoteArg(['push', '--', 'origin', 'feat/x']);
    expect(r).toEqual({ remoteIndex: 2, remote: 'origin' });
  });
});

describe('parseGithubHttps', () => {
  it('accepts https://github.com/owner/repo', () => {
    expect(parseGithubHttps('https://github.com/stephengardner/layered-autonomous-governance'))
      .toEqual({ owner: 'stephengardner', repo: 'layered-autonomous-governance' });
  });

  it('accepts https://github.com/owner/repo.git', () => {
    expect(parseGithubHttps('https://github.com/a/b.git'))
      .toEqual({ owner: 'a', repo: 'b' });
  });

  it('accepts trailing slash', () => {
    expect(parseGithubHttps('https://github.com/a/b.git/'))
      .toEqual({ owner: 'a', repo: 'b' });
  });

  it('accepts dots in names (per GitHub allowed chars)', () => {
    expect(parseGithubHttps('https://github.com/my.org/my.repo.git'))
      .toEqual({ owner: 'my.org', repo: 'my.repo' });
  });

  it('rejects SSH remote', () => {
    expect(parseGithubHttps('git@github.com:owner/repo.git')).toBe(null);
  });

  it('rejects enterprise host', () => {
    expect(parseGithubHttps('https://git.corp.example.com/owner/repo.git')).toBe(null);
  });

  it('rejects http (no TLS)', () => {
    expect(parseGithubHttps('http://github.com/owner/repo')).toBe(null);
  });

  it('rejects malformed URL', () => {
    expect(parseGithubHttps('not-a-url')).toBe(null);
  });

  it('rejects empty / null / non-string', () => {
    expect(parseGithubHttps('')).toBe(null);
    expect(parseGithubHttps(null)).toBe(null);
    expect(parseGithubHttps(undefined)).toBe(null);
    expect(parseGithubHttps(123)).toBe(null);
  });
});

describe('buildTransientPushUrl', () => {
  it('builds the documented x-access-token form', () => {
    const u = buildTransientPushUrl({ owner: 'o', repo: 'r', token: 't123' });
    expect(u).toBe('https://x-access-token:t123@github.com/o/r.git');
  });

  it('always appends .git (match git-receive-pack contract)', () => {
    const u = buildTransientPushUrl({ owner: 'a', repo: 'b', token: 'x' });
    expect(u.endsWith('.git')).toBe(true);
  });
});

describe('buildPushSpawnArgs', () => {
  const origin = 'https://github.com/stephengardner/layered-autonomous-governance';

  it('rewrites the remote positional with x-access-token URL', () => {
    const next = buildPushSpawnArgs(
      ['push', 'origin', 'feat/x'],
      origin,
      FAKE_TOKEN,
    );
    expect(next).not.toBe(null);
    expect(next[0]).toBe('push');
    expect(next[1]).toBe(
      `https://x-access-token:${FAKE_TOKEN}@github.com/stephengardner/layered-autonomous-governance.git`,
    );
    expect(next[2]).toBe('feat/x');
  });

  it('preserves flags before the remote', () => {
    const next = buildPushSpawnArgs(
      ['push', '-u', 'origin', 'feat/x'],
      origin,
      FAKE_TOKEN,
    );
    expect(next).not.toBe(null);
    expect(next[0]).toBe('push');
    expect(next[1]).toBe('-u');
    expect(next[2]).toMatch(/^https:\/\/x-access-token:/);
    expect(next[3]).toBe('feat/x');
  });

  it('preserves flags after the remote', () => {
    const next = buildPushSpawnArgs(
      ['push', 'origin', 'feat/x', '--force-with-lease'],
      origin,
      FAKE_TOKEN,
    );
    expect(next).not.toBe(null);
    expect(next[3]).toBe('--force-with-lease');
  });

  it('returns null for bare push (caller falls through)', () => {
    expect(buildPushSpawnArgs(['push'], origin, FAKE_TOKEN)).toBe(null);
  });

  it('returns null for SSH remote (caller falls through)', () => {
    expect(
      buildPushSpawnArgs(['push', 'origin', 'x'], 'git@github.com:o/r.git', FAKE_TOKEN),
    ).toBe(null);
  });

  it('returns null for enterprise remote (caller falls through)', () => {
    expect(
      buildPushSpawnArgs(['push', 'origin', 'x'], 'https://git.corp/o/r.git', FAKE_TOKEN),
    ).toBe(null);
  });

  it('returns null when resolveRemoteUrl returned null', () => {
    expect(buildPushSpawnArgs(['push', 'origin', 'x'], null, FAKE_TOKEN)).toBe(null);
  });
});

describe('buildPushEnv (push does NOT set Authorization: Bearer)', () => {
  const env = buildPushEnv();

  it('sets GIT_TERMINAL_PROMPT=0 (fail fast, no askpass hang)', () => {
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('sets credential.helper to empty string (no ambient PAT race)', () => {
    const idx = Number(env.GIT_CONFIG_COUNT);
    const keys = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    const values = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_VALUE_${i}`]);
    const helperIdx = keys.indexOf('credential.helper');
    expect(helperIdx).toBeGreaterThanOrEqual(0);
    expect(values[helperIdx]).toBe('');
  });

  it('does NOT set http.extraHeader (Bearer would 401 on receive-pack)', () => {
    const idx = Number(env.GIT_CONFIG_COUNT);
    const keys = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    expect(keys).not.toContain('http.extraHeader');
    // Also ensure no lingering value key references it (defensive
    // against a miscounted GIT_CONFIG_COUNT).
    for (const k of Object.keys(env)) {
      if (k.startsWith('GIT_CONFIG_VALUE_')) {
        expect(env[k]).not.toMatch(/Authorization:\s+Bearer/i);
      }
    }
  });
});

describe('buildReadOnlyEnv (fetch / pull / clone / etc.)', () => {
  const env = buildReadOnlyEnv(FAKE_TOKEN);

  it('sets GIT_TERMINAL_PROMPT=0', () => {
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('carries the Bearer extraHeader', () => {
    const idx = Number(env.GIT_CONFIG_COUNT);
    const keys = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    const values = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_VALUE_${i}`]);
    const headerIdx = keys.indexOf('http.extraHeader');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(values[headerIdx]).toBe(`Authorization: Bearer ${FAKE_TOKEN}`);
  });

  it('also sets credential.helper=""', () => {
    const idx = Number(env.GIT_CONFIG_COUNT);
    const keys = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    const values = Array.from({ length: idx }, (_, i) => env[`GIT_CONFIG_VALUE_${i}`]);
    const helperIdx = keys.indexOf('credential.helper');
    expect(helperIdx).toBeGreaterThanOrEqual(0);
    expect(values[helperIdx]).toBe('');
  });

  it('token never appears in a key (only in the value pair)', () => {
    for (const k of Object.keys(env)) {
      if (k.startsWith('GIT_CONFIG_KEY_')) {
        expect(env[k]).not.toContain(FAKE_TOKEN);
      }
    }
  });
});

describe('extractSetUpstreamPlan', () => {
  it('returns null when -u is absent', () => {
    expect(extractSetUpstreamPlan(['push', 'origin', 'my-branch'])).toBe(null);
  });

  it('returns null when push has no remote (bare push)', () => {
    expect(extractSetUpstreamPlan(['push', '-u'])).toBe(null);
  });

  it('strips -u and returns remoteName + branchHint', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', 'my-branch']);
    expect(plan).not.toBe(null);
    expect(plan!.strippedArgs).toEqual(['push', 'origin', 'my-branch']);
    expect(plan!.remoteName).toBe('origin');
    expect(plan!.branchHint).toBe('my-branch');
  });

  it('strips --set-upstream (long form) equivalently', () => {
    const plan = extractSetUpstreamPlan(['push', '--set-upstream', 'origin', 'my-branch']);
    expect(plan).not.toBe(null);
    expect(plan!.strippedArgs).toEqual(['push', 'origin', 'my-branch']);
    expect(plan!.remoteName).toBe('origin');
    expect(plan!.branchHint).toBe('my-branch');
  });

  it('handles refspec with src:dst form (branchHint is src side)', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', 'feat/x:refs/heads/feat/x']);
    expect(plan!.branchHint).toBe('feat/x');
  });

  it('returns branchHint=null when refspec is absent', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin']);
    expect(plan).not.toBe(null);
    expect(plan!.branchHint).toBe(null);
  });

  it('handles -u positioned after the remote', () => {
    const plan = extractSetUpstreamPlan(['push', 'origin', '-u', 'my-branch']);
    expect(plan).not.toBe(null);
    expect(plan!.strippedArgs).toEqual(['push', 'origin', 'my-branch']);
    expect(plan!.remoteName).toBe('origin');
    expect(plan!.branchHint).toBe('my-branch');
  });

  it('strips leading + from force-refspec branchHint', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', '+feat/x']);
    expect(plan).not.toBe(null);
    expect(plan!.branchHint).toBe('feat/x');
  });

  it('strips leading + from force-refspec src side and captures dst as mergeRef', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', '+feat/x:release-x']);
    expect(plan).not.toBe(null);
    expect(plan!.branchHint).toBe('feat/x');
    expect(plan!.mergeRef).toBe('refs/heads/release-x');
  });

  it('captures dst side of src:dst refspec as mergeRef', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', 'feat/x:release-x']);
    expect(plan!.mergeRef).toBe('refs/heads/release-x');
  });

  it('preserves refs/-prefixed dst as-is', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', 'feat/x:refs/heads/release-x']);
    expect(plan!.mergeRef).toBe('refs/heads/release-x');
  });

  it('mergeRef is null when no : in refspec', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', 'feat/x']);
    expect(plan!.mergeRef).toBe(null);
  });

  it('refspec of just `+` (no source name) yields branchHint=null', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', '+']);
    expect(plan!.branchHint).toBe(null);
  });

  it('non-array input returns null', () => {
    // @ts-expect-error -- exercising the runtime guard
    expect(extractSetUpstreamPlan(null)).toBe(null);
    // @ts-expect-error
    expect(extractSetUpstreamPlan(undefined)).toBe(null);
  });
});

describe('extractSetUpstreamPlan: token-leak prevention', () => {
  // The wrapper feeds the stripped args through buildPushSpawnArgs to
  // get the URL-rewritten spawn argv. Verify that the URL substitution
  // proceeds correctly on the stripped form, AND that the original
  // unstripped form would have left -u immediately before the URL --
  // which is exactly the shape that causes git to persist the URL
  // (with embedded token) as branch.<name>.remote.
  const FAKE = 'ghs_fake_token_xyz';
  const ORIGIN = 'https://github.com/o/r';

  it('stripped args route through buildPushSpawnArgs cleanly (URL substituted, no -u)', () => {
    const plan = extractSetUpstreamPlan(['push', '-u', 'origin', 'my-branch']);
    expect(plan).not.toBe(null);
    const rewritten = buildPushSpawnArgs(plan!.strippedArgs, ORIGIN, FAKE);
    expect(rewritten).not.toBe(null);
    expect(rewritten!).not.toContain('-u');
    expect(rewritten!).not.toContain('--set-upstream');
    expect(rewritten!.join(' ')).toContain(`x-access-token:${FAKE}@`);
  });

  it('regression-guard: -u left in the rewritten argv WOULD pair with the URL (the bug)', () => {
    // This documents the leak-shape so a future revert that drops the
    // strip step fails this test. It does NOT exercise the wrapper;
    // it just shows what the broken argv looks like.
    const buggyArgs = ['push', '-u', 'origin', 'my-branch'];
    const buggyRewrite = buildPushSpawnArgs(buggyArgs, ORIGIN, FAKE);
    expect(buggyRewrite).not.toBe(null);
    // -u immediately before the substituted URL is the shape git
    // records as `branch.<name>.remote = <full URL with token>`.
    const idxU = buggyRewrite!.indexOf('-u');
    expect(idxU).toBeGreaterThan(-1);
    expect(buggyRewrite![idxU + 1]).toContain('x-access-token:');
  });
});

describe('token exposure: push URL carries token on argv but env does not', () => {
  const origin = 'https://github.com/o/r';
  const next = buildPushSpawnArgs(['push', 'origin', 'x'], origin, FAKE_TOKEN);
  const env = buildPushEnv();

  it('the transient URL argv token matches the minted token', () => {
    expect(next).not.toBe(null);
    expect(next!.join(' ')).toContain(`x-access-token:${FAKE_TOKEN}@`);
  });

  it('the push env does NOT contain the token in any key or value', () => {
    // This is the central safety claim for the push path: argv
    // exposes the token to `ps` for a few seconds, and env (where
    // we DO control secret placement) stays token-free.
    for (const [k, v] of Object.entries(env)) {
      expect(k).not.toContain(FAKE_TOKEN);
      if (typeof v === 'string') {
        expect(v).not.toContain(FAKE_TOKEN);
      }
    }
  });
});
