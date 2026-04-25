// Pure helpers for scripts/invokers/autonomous-dispatch.mjs.
// Extracted into a shebang-free module so the test can static-import
// them without firing the script's CLI side effects, mirroring the
// pattern landed for git-as-push-auth.mjs.

import {
  buildPushEnv,
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
 * Build the (args, env) overrides a token-authed git invocation
 * should spawn with. Pure: callers compose the tuple with execa
 * themselves and spread `process.env` so tests can inject a clean
 * env without leaking real credentials.
 *
 *   - Remote-touching verbs (push, fetch, pull, clone, ls-remote):
 *     rewrite the remote-arg position to a transient
 *     x-access-token URL via the in-file rewriteGitRemoteArg, then
 *     merge env overrides from buildPushEnv (clears the ambient
 *     credential helper so git does not prompt for a username).
 *     The Bearer http.extraHeader path used for `gh api` does NOT
 *     authenticate git's smart-http on Windows; the URL-embedded
 *     x-access-token form is the only auth method that works
 *     uniformly for receive-pack AND upload-pack across platforms.
 *   - Local-only verbs (status, log, rev-parse, config, ...): keep
 *     argv intact, merge the GIT_CONFIG_* env from buildReadOnlyEnv
 *     (Authorization: Bearer extraheader for the few local
 *     operations that may still hit a remote, plus credential
 *     helper clear). The remote-rewrite branch returns null for
 *     these, falling through to this path.
 *
 * The returned shape (args, env) is what execa's positional args
 * consume after the file argument.
 */
export function buildAuthedGitInvocation({
  args,
  token,
  repoOwner,
  repoName,
  inheritedEnv,
  callerEnv = {},
}) {
  // For ALL git-protocol commands that touch a remote (push, fetch,
  // pull, clone, ls-remote), rewrite the remote-arg position to a
  // transient x-access-token URL. The Bearer http.extraHeader path
  // works for `gh api` (GitHub's REST/GraphQL surface) but does NOT
  // authenticate git's smart-http protocol on Windows: GitHub
  // rejects the bearer for receive-pack AND upload-pack with a 401,
  // git falls through to the credential helper, askpass disabled
  // produces "could not read Username for 'https://github.com'".
  // The URL-embedded x-access-token form is the only auth method
  // that works uniformly across all git remote verbs on Windows +
  // Linux.
  const remoteRewrite = rewriteGitRemoteArg(args, token, repoOwner, repoName);
  if (remoteRewrite !== null) {
    return {
      args: remoteRewrite,
      env: { ...inheritedEnv, ...callerEnv, ...buildPushEnv() },
    };
  }
  // Local-only git commands (status, log, rev-parse, config, etc.)
  // need no auth. Apply the read-only env defensively to clear any
  // ambient credential helper that might prompt unexpectedly.
  return {
    args,
    env: { ...inheritedEnv, ...callerEnv, ...buildReadOnlyEnv(token) },
  };
}

/**
 * If the argv invokes a git verb that talks to a remote, return a
 * new argv with the remote-arg position rewritten to the transient
 * x-access-token URL. Otherwise return null (caller treats as
 * local-only, no auth needed).
 *
 * Walks past git-level options (`-c k=v`, `-C dir`, `--`) the same
 * way findGitVerb does so the upstream `-c user.name=...` prefix
 * git-ops emits does not misclassify the verb. The first positional
 * AFTER the verb is the remote arg for push/fetch/pull/ls-remote;
 * for clone the remote arg is the first positional after the verb
 * too. Subcommand-specific quirks (e.g. `git push --repo <name>`
 * with no positional) are not supported because git-ops never emits
 * them.
 */
const REMOTE_GIT_VERBS = new Set([
  'push',
  'fetch',
  'pull',
  'clone',
  'ls-remote',
]);

function rewriteGitRemoteArg(args, token, repoOwner, repoName) {
  if (!Array.isArray(args)) return null;
  const valueTaking = new Set(['-c', '-C']);
  let i = 0;
  let verbIndex = -1;
  while (i < args.length) {
    const a = args[i];
    if (typeof a !== 'string') return null;
    if (a === '--') {
      // Next token is the verb.
      if (i + 1 < args.length && REMOTE_GIT_VERBS.has(args[i + 1])) {
        verbIndex = i + 1;
        break;
      }
      return null;
    }
    if (a.startsWith('-')) {
      if (valueTaking.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (REMOTE_GIT_VERBS.has(a)) {
      verbIndex = i;
    }
    break;
  }
  if (verbIndex < 0) return null;

  // First positional after the verb is the remote name (or URL).
  // For clone the positional is the URL itself; rewriting it to
  // the transient form keeps the auth surface uniform.
  let remoteIndex = -1;
  for (let j = verbIndex + 1; j < args.length; j++) {
    const a = args[j];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) continue;
    remoteIndex = j;
    break;
  }
  if (remoteIndex < 0) return null;

  // Validate the remote points at the dispatch-configured repo
  // before rewriting. Accepting only:
  //   - 'origin' (the conventional remote, set by the dispatcher
  //     during clone), or
  //   - https://github.com/<owner>/<repo>(.git)? where (owner, repo)
  //     match the configured (repoOwner, repoName).
  // Anything else (a different GitHub repo, a non-GitHub host, an
  // arbitrary upstream remote name like 'upstream') falls through
  // and the caller treats the invocation as local-only. The
  // dispatch flow never legitimately addresses a non-target remote;
  // silently rewriting one would erase user intent and could
  // exfiltrate the access token to the wrong host.
  const remoteArg = args[remoteIndex];
  if (remoteArg !== 'origin') {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteArg);
    if (!match || match[1] !== repoOwner || match[2] !== repoName) {
      return null;
    }
  }

  const transient = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  const next = args.slice();
  next[remoteIndex] = transient;
  return next;
}
