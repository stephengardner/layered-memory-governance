// Pure helpers for scripts/invokers/autonomous-dispatch.mjs.
// Extracted into a shebang-free module so the test can static-import
// them without firing the script's CLI side effects, mirroring the
// pattern landed for git-as-push-auth.mjs.

import {
  buildPushEnv,
  buildPushSpawnArgs,
  buildReadOnlyEnv,
} from './git-as-push-auth.mjs';

/**
 * Parse a `GH_REPO=owner/repo` env value.
 * Returns { owner, repo } when the input is well-formed, or null
 * otherwise (caller falls back to `gh repo view`). Reject over-
 * segmented inputs like `org/team/repo` instead of silently
 * truncating to `{owner:'org', repo:'team'}`; the prior
 * `split('/', 2)` form would have dispatched against the wrong
 * repo on a typo, with no diagnostic.
 */
export function parseRepoSlug(slug) {
  if (typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Detect a push command in a git argv that may carry git-level `-c`
 * options before the verb. Skip git-level flags (`-c key=val`,
 * `-C dir`, single-letter switches) and report whether the first
 * non-flag positional is `push`. This avoids the false positive a
 * naive `args.includes('push')` would emit on a benign refspec named
 * `push` (e.g. `git fetch origin push`); the shared isPushCommand
 * helper instead misclassifies `-c user.name=foo push origin` as a
 * read because it bails on the first non-`-` token, which is the gap
 * this helper exists to plug.
 *
 * Verbs are git's positional commands (push, fetch, clone, ...).
 * Anything before the verb is either a flag, a flag value, or
 * unrecognized; once we see the verb, that token decides routing.
 */
export function looksLikeGitPush(args) {
  if (!Array.isArray(args)) return false;
  return findGitVerb(args) === 'push';
}

/**
 * Walk a git argv past git-level options and return the first
 * positional token (the verb), or null if no verb is reachable.
 * Handles the two value-taking git-level options the dispatcher
 * actually emits (`-c <key>=<val>` from git-ops, `-C <dir>` from
 * tooling); other long flags are treated as boolean. Mirrors the
 * structure of findRemoteArg in git-as-push-auth.mjs.
 */
function findGitVerb(args) {
  const valueTaking = new Set(['-c', '-C']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return null;
    if (a === '--') {
      return args[i + 1] ?? null;
    }
    if (a.startsWith('-')) {
      if (valueTaking.has(a)) {
        i += 1; // skip the value
        continue;
      }
      // Inline value form (e.g. `-C=dir`, `--git-dir=.git`) is one
      // token; ignore it entirely.
      continue;
    }
    return a;
  }
  return null;
}

/**
 * Build the (file, args, options) tuple a token-authed git invocation
 * should spawn. Pure: callers compose the tuple with execa themselves.
 *
 *   - Push verbs: rewrite the remote arg to a transient
 *     x-access-token URL via buildPushSpawnArgs, then merge the env
 *     overrides from buildPushEnv (clears the ambient credential
 *     helper so git does not prompt).
 *   - Read verbs: keep argv intact, merge the GIT_CONFIG_* env from
 *     buildReadOnlyEnv (Authorization: Bearer extraheader).
 *
 * The returned shape mirrors what execa's first three positional
 * params consume; spreading `process.env` is the caller's job so
 * tests can inject a clean env without leaking real credentials.
 */
export function buildAuthedGitInvocation({
  args,
  token,
  repoOwner,
  repoName,
  inheritedEnv,
  callerEnv = {},
}) {
  if (looksLikeGitPush(args)) {
    const remoteUrl = `https://github.com/${repoOwner}/${repoName}.git`;
    const rewritten = buildPushSpawnArgs(args, remoteUrl, token);
    if (rewritten === null) {
      // The shared rewriter only knows the GitHub HTTPS shape. A
      // non-GitHub remote (SSH, enterprise, etc.) cannot accept the
      // x-access-token URL, and falling through with buildPushEnv()
      // would clear credential.helper without supplying a
      // replacement -- the push would prompt or fail with no useful
      // diagnostic. Fail loud so the caller sees the misconfiguration.
      throw new Error(
        '[autonomous-dispatch] cannot rewrite push to App-installation auth: '
        + 'remote URL did not parse as github.com HTTPS. '
        + `Inspect remote configuration for ${repoOwner}/${repoName}.`,
      );
    }
    return {
      args: rewritten,
      env: { ...inheritedEnv, ...callerEnv, ...buildPushEnv() },
    };
  }
  return {
    args,
    env: { ...inheritedEnv, ...callerEnv, ...buildReadOnlyEnv(token) },
  };
}
