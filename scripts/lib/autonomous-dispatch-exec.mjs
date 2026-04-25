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
 * otherwise (caller falls back to `gh repo view`).
 */
export function parseRepoSlug(slug) {
  if (typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  if (!trimmed.includes('/')) return null;
  const [owner, repo] = trimmed.split('/', 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Detect a push command in a git argv that may carry git-level `-c`
 * options before the verb. The shared `isPushCommand` helper bails as
 * soon as it sees a non-flag positional, so it misclassifies
 * `-c user.name=foo push origin` (the shape git-ops produces) as a
 * read. Search the args for the literal `push` token instead; false
 * positives are unreachable because git-ops only constructs argvs
 * shaped like `[-c, kv, -c, kv, <verb>, ...]` and never lets a
 * refspec land before the verb.
 */
export function looksLikeGitPush(args) {
  if (!Array.isArray(args)) return false;
  return args.includes('push');
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
    return {
      args: rewritten ?? args,
      env: { ...inheritedEnv, ...callerEnv, ...buildPushEnv() },
    };
  }
  return {
    args,
    env: { ...inheritedEnv, ...callerEnv, ...buildReadOnlyEnv(token) },
  };
}
