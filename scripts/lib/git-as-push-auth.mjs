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
 * Git-level (pre-subcommand) flags that consume the next argv entry.
 * Used by isPushCommand to skip over flag values when locating the
 * subcommand. Inline `--flag=value` forms are a single token and
 * already pass through the .startsWith('-') branch.
 *
 * `-c name=value` is included even though the value is `name=value`
 * (a single token) because git's grammar still treats it as a
 * separate argument; missing it would mis-classify
 * `git -c http.proxy=... push origin foo` as a non-push command.
 */
const GIT_LEVEL_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--list-cmds',
]);

/**
 * True if gitArgs' first positional is `push`. Matches bare `push`
 * and skips preceding git-level options including value-taking
 * flags like `-C <dir>`. Inline forms (`--git-dir=path`) are single
 * tokens and don't need the value-skip path.
 */
export function isPushCommand(gitArgs) {
  let i = 0;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (a === 'push') return true;
    if (a.startsWith('-')) {
      if (GIT_LEVEL_VALUE_OPTIONS.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
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
 * Detect `-u` / `--set-upstream` in a `git push` arg list and return
 * a plan for replacing the user's intent without leaking the
 * transient x-access-token URL into `.git/config`.
 *
 * Why this exists
 * ---------------
 * `buildPushSpawnArgs` substitutes the remote NAME (e.g. `origin`)
 * with a transient URL `https://x-access-token:<token>@github.com/...`
 * so the receive-pack endpoint accepts our Basic auth. Git's `-u`
 * flag (alias of `--set-upstream`) tells git to record the remote
 * as the branch's upstream. With the URL substituted into argv, git
 * records the FULL URL  --  including the embedded token  --  into
 * `branch.<name>.remote` of `.git/config`. The token then persists
 * on disk for hours past the push, in a file the operator's editor
 * + IDE + linter all read.
 *
 * The fix this helper enables: strip `-u` from the spawn argv and
 * record (remoteName, branchHint) so the wrapper can set the upstream
 * AFTER a successful push using `git config branch.<name>.remote
 * <remote-name>`  --  which references the named remote rather than the
 * transient URL.
 *
 * Returns null when `-u` is absent. Otherwise:
 *   { strippedArgs, remoteName, branchHint }
 *
 * `branchHint` is the source side of the first refspec after the
 * remote (the form `<src>:<dst>` is split on `:`), or null if no
 * refspec was provided. The wrapper resolves a null hint via
 * `git rev-parse --abbrev-ref HEAD` (the current branch).
 */
const SET_UPSTREAM_FLAGS = new Set(['-u', '--set-upstream']);

export function extractSetUpstreamPlan(gitArgs) {
  if (!Array.isArray(gitArgs)) return null;
  const remoteInfoBefore = findRemoteArg(gitArgs);
  if (remoteInfoBefore === null) return null;
  const stripped = [];
  let hadFlag = false;
  for (const arg of gitArgs) {
    if (SET_UPSTREAM_FLAGS.has(arg)) {
      hadFlag = true;
      continue;
    }
    stripped.push(arg);
  }
  if (!hadFlag) return null;
  // After strip, indices shift left; re-find the remote slot.
  const remoteInfoAfter = findRemoteArg(stripped);
  if (remoteInfoAfter === null) return null;
  const refspec = stripped[remoteInfoAfter.remoteIndex + 1] ?? null;
  // Source side of the refspec (before `:`). Strip a leading `+` so a
  // force-refspec like `+feat/x:release-x` yields `feat/x` (not
  // `+feat/x`, which would interpolate into an invalid config key
  // `branch.+feat/x.remote`).
  let branchHint = null;
  let mergeRef = null;
  if (typeof refspec === 'string' && refspec.length > 0) {
    const colonIdx = refspec.indexOf(':');
    const rawSrc = colonIdx >= 0 ? refspec.slice(0, colonIdx) : refspec;
    const rawDst = colonIdx >= 0 ? refspec.slice(colonIdx + 1) : null;
    const srcStripped = rawSrc.startsWith('+') ? rawSrc.slice(1) : rawSrc;
    branchHint = srcStripped.length > 0 ? srcStripped : null;
    // Destination side: if the refspec was `src:dst`, capture `dst`
    // so the wrapper can write `branch.<src>.merge = refs/heads/<dst>`
    // -- matching what native `-u` would do. If `dst` already starts
    // with `refs/heads/` use it verbatim; otherwise wrap it. If no
    // `:` was present, leave mergeRef null and the wrapper falls
    // back to `refs/heads/<branchHint>`.
    if (rawDst !== null && rawDst.length > 0) {
      mergeRef = rawDst.startsWith('refs/') ? rawDst : `refs/heads/${rawDst}`;
    }
  }
  return {
    strippedArgs: stripped,
    remoteName: remoteInfoAfter.remote,
    branchHint,
    mergeRef,
  };
}

/**
 * Produce the child-env overrides for the READ-ONLY verbs (fetch,
 * pull, clone, ls-remote, ...). GitHub accepts Bearer on these
 * endpoints, so the token flows via `http.extraHeader` and never
 * touches argv.
 *
 * The empty `GIT_ASKPASS` / `SSH_ASKPASS` fields neutralize ambient
 * askpass helpers some shells inherit (notably MSYS git-bash, which
 * exports `SSH_ASKPASS` pointing at a GUI helper that hangs ~30s
 * waiting for a TTY when invoked from a non-interactive child).
 * Empty strings make git skip both helpers, then `GIT_TERMINAL_PROMPT=0`
 * fails fast instead of hanging on a prompt that never arrives.
 */
export function buildReadOnlyEnv(token) {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
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
 *
 * `GIT_ASKPASS` / `SSH_ASKPASS` are neutralized for the same reason
 * as buildReadOnlyEnv: prevent inherited helper scripts from hanging
 * on a TTY that the wrapper's child never has.
 */
export function buildPushEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}
