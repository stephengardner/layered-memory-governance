// Pure helpers for git-as.mjs push auth routing. Extracted into
// their own shebang-free module so the test can static-import them
// (PR #123 landed the same pattern after observing vitest's Windows
// transformer rejecting shebang-headed .mjs imports; we adopt it
// here defensively without re-running that diagnosis).
//
// The CLI wrapper (scripts/git-as.mjs) composes these helpers with
// spawnSync-style side effects.

/**
 * Parse a `git push` arg list to find the positional remote.
 * Returns { remoteIndex, remote } where remoteIndex is the 0-based
 * position inside gitArgs, or null if no remote is specified (bare
 * `git push` -- git falls back to the branch's upstream in that
 * case and the caller uses the Bearer path).
 *
 * git push option grammar (what we need to skip correctly):
 *   push [<options>] [<remote> [<refspec>...]]
 *
 * Options can be:
 *   - boolean: --force, --tags, --atomic, -u, -f, ...
 *   - value-taking-separate: --repo <name>, --receive-pack <cmd>, ...
 *   - value-inline: --repo=<name>, --receive-pack=<cmd>, ...
 *
 * Only the two value-taking options that consume the next arg need
 * explicit handling; inline `--flag=val` forms are a single token.
 */
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec']);

export function findRemoteArg(gitArgs) {
  let i = gitArgs.indexOf('push') + 1;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (a === '--') return { remoteIndex: i + 1, remote: gitArgs[i + 1] ?? null };
    if (a.startsWith('-')) {
      if (PUSH_VALUE_OPTIONS.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return { remoteIndex: i, remote: a };
  }
  return null;
}

/**
 * True if gitArgs' first positional is `push`. Matches bare `push`
 * and skips preceding git-level options (rare in practice, but
 * `-C <dir> push` is legal).
 */
export function isPushCommand(gitArgs) {
  for (const a of gitArgs) {
    if (a === 'push') return true;
    if (a.startsWith('-')) continue;
    return false;
  }
  return false;
}

/**
 * Match an `https://github.com/<owner>/<repo>(.git)?(/)?` URL and
 * return its canonical owner/repo. Returns null for SSH, enterprise
 * hosts, or malformed URLs so the caller falls through to the
 * Bearer extraHeader path for those shapes.
 *
 * Owner + repo char set matches GitHub's documented allowed chars
 * (letters, digits, hyphens, underscores, periods). Strictness stays
 * useful without over-fitting to edge cases.
 */
const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export function parseGithubHttps(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(GITHUB_HTTPS_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function buildTransientPushUrl({ owner, repo, token }) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Compute the gitArgs to actually spawn for a push. If the remote
 * resolves to an https://github.com/... URL, the remote arg position
 * is replaced with the transient x-access-token URL. Otherwise
 * returns null to signal "fall through to the Bearer path".
 *
 * Pure: no side effects. The test drives it with a table of
 * (gitArgs, resolvedRemoteUrl, token) without shelling out to git.
 */
export function buildPushSpawnArgs(gitArgs, resolvedRemoteUrl, token) {
  const remoteInfo = findRemoteArg(gitArgs);
  if (remoteInfo === null) return null;
  const parsed = parseGithubHttps(resolvedRemoteUrl ?? '');
  if (parsed === null) return null;
  const transient = buildTransientPushUrl({
    owner: parsed.owner,
    repo: parsed.repo,
    token,
  });
  const next = gitArgs.slice();
  next[remoteInfo.remoteIndex] = transient;
  return next;
}

/**
 * Produce the child-env overrides for the READ-ONLY verbs (fetch,
 * pull, clone, ls-remote, ...). GitHub accepts Bearer on these
 * endpoints, so the token flows via `http.extraHeader` and never
 * touches argv.
 */
export function buildReadOnlyEnv(token) {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

/**
 * Produce the child-env overrides for PUSH. GitHub rejects Bearer
 * on receive-pack, so extraHeader is intentionally absent; the
 * token reaches git via the transient URL argv position (see
 * buildPushSpawnArgs). credential.helper= still clears the ambient
 * helper, and GIT_TERMINAL_PROMPT=0 still fails fast on misconfig.
 */
export function buildPushEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}
