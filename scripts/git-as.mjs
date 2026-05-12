#!/usr/bin/env node
/**
 * git-as: run a git command under a provisioned bot identity so the
 * HTTP authentication (who pushed, per GitHub's pusher attribution)
 * is the bot App, not the operator's cached credential-manager PAT.
 *
 * Usage:
 *   node scripts/git-as.mjs <role> <git-args...>
 *
 * Examples:
 *   node scripts/git-as.mjs lag-ceo push -u origin my-branch
 *   node scripts/git-as.mjs lag-ceo push --force-with-lease
 *
 * Why this exists
 * ---------------
 * Local git config in this repo already sets user.name / user.email
 * to the bot identity so commit authorship is correct. That fixes
 * COMMIT attribution. Independent of that, `git push` authenticates
 * to GitHub via the system credential helper (on Windows, Git
 * Credential Manager caches the operator's PAT; on macOS/Linux, osx
 * keychain or a cached token). The token used to authenticate the
 * push is what GitHub records as the "pusher" on the push event.
 *
 * Without this wrapper, every bot-authored commit gets pushed under
 * the operator's personal token - defeating the "never act on GitHub
 * under operator identity" rule for the push half of the flow.
 *
 * Mechanism
 * ---------
 * Two auth paths, selected by git subcommand:
 *
 *   - READ-ONLY (fetch, pull, clone, ls-remote, ...): pass the
 *     installation token to git via `http.extraHeader: Authorization:
 *     Bearer <token>`. Bearer works on the API-style smart-HTTP
 *     endpoints git uses for negotiation + fetch.
 *
 *   - PUSH (git-receive-pack): GitHub's receive-pack endpoint rejects
 *     Bearer with `HTTP/2 401, www-authenticate: Basic realm="GitHub"`
 *     and the documented installation-token path for git push is
 *     Basic auth with username `x-access-token` and the token as the
 *     password. We resolve the remote's URL, construct a transient
 *     `https://x-access-token:<token>@github.com/<owner>/<repo>.git`,
 *     and spawn `git push <transient-url> <refspec>` against that
 *     URL directly so the persistent remote config is never touched.
 *
 * Both paths neutralize the ambient credential helper (credential.
 * helper='') so the operator's cached PAT doesn't race the bot token,
 * and set GIT_TERMINAL_PROMPT=0 so an auth misconfiguration fails
 * fast instead of hanging on the askpass helper. The latter is
 * load-bearing: on Cursor-managed Windows hosts the shim askpass
 * stalls the push ~30s with no TTY signalling.
 *
 * Token exposure trade-off
 * ------------------------
 * The READ-ONLY path keeps the token in env (GIT_CONFIG_VALUE_0);
 * argv never carries it. The PUSH path, per the x-access-token
 * contract, embeds the token in a URL that IS passed on argv to the
 * git child - visible in `ps` for same-user processes during the
 * seconds the push runs. The exposure is scoped narrowly: only the
 * push spawn sees it, the outer shell's argv still does not, the
 * transient URL is never written to disk or to the persistent remote
 * config. Alternatives considered and rejected:
 *
 *   - Persistently rewrite the origin URL, push, then restore: widens
 *     the on-disk exposure window and breaks `git remote -v`
 *     cleanliness during the push.
 *   - credential.<url>.helper= with an inline script returning
 *     username=x-access-token: adds an order of magnitude more
 *     subprocess machinery for the same argv-free outcome git's
 *     helper protocol gives us.
 *
 * The argv-visibility trade is the narrowest shape that matches
 * GitHub's documented installation-token flow.
 *
 * Scope
 * -----
 * Tuned for `git push` and read-only ops. Non-github.com HTTPS
 * remotes fall through to the Bearer extraHeader path (the URL
 * rewrite is a no-op for enterprise hosts). SSH remotes
 * (`git@github.com:...`) also fall through; git-as does not install
 * SSH identities, so the wrapper's value there is limited to local-
 * config neutralization. Bare `git push` (no positional remote) also
 * falls through to the Bearer path, which works for fetch/pull but
 * will hit the receive-pack 401 on Cursor-managed hosts - operators
 * in that environment should pass an explicit remote.
 *
 * Fail-closed
 * -----------
 * - Missing role / unprovisioned App -> exit 2 with a recognizable
 *   [git-as] prefix.
 * - Token mint failure -> exit 1, stderr carries the API reason.
 * - git child non-zero -> forward git's exit code.
 * - git child killed by signal -> exit 1 with signal name on stderr.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  createCredentialsStore,
} from '../dist/actors/provisioning/index.js';
import {
  fetchInstallationToken,
} from '../dist/external/github-app/index.js';
import {
  buildPushEnv,
  buildPushSpawnArgs,
  extractSetUpstreamPlan,
  buildReadOnlyEnv,
  findRemoteArg,
  isPushCommand,
} from './lib/git-as-push-auth.mjs';
import { resolveStateDir } from './lib/resolve-state-dir.mjs';
import { resolveBotCredsStateDir } from './lib/resolve-bot-creds-state-dir.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolveStateDir(REPO_ROOT);

/**
 * Resolve a remote's URL by shelling out to `git remote get-url`.
 * Returns the trimmed URL or null if git reports no such remote.
 * This is a local read from .git/config; no network.
 */
async function resolveRemoteUrl(remoteName) {
  try {
    const r = await execa('git', ['remote', 'get-url', remoteName], { reject: false });
    if (r.exitCode !== 0) return null;
    const out = (r.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function main() {
  const role = process.argv[2];
  const gitArgs = process.argv.slice(3);
  if (!role || gitArgs.length === 0) {
    console.error('Usage: node scripts/git-as.mjs <role> <git-args...>');
    console.error('Example: node scripts/git-as.mjs lag-ceo push -u origin my-branch');
    process.exit(2);
  }

  // Walk-up resolution for sub-agent worktrees: when this wrapper is
  // invoked from a freshly-spawned worktree without its own
  // `.lag/apps/<role>.json`, look for the creds in the nearest
  // ancestor `.lag/`. Honors `LAG_STATE_DIR` as an explicit operator
  // override (walk-up skipped). Indie-floor default unchanged.
  const credsStateDir = resolveBotCredsStateDir(STATE_DIR, role);
  const store = createCredentialsStore(credsStateDir);
  let loaded;
  try {
    loaded = await store.load(role);
  } catch (err) {
    console.error(`[git-as] failed to load credentials for '${role}': ${err?.message ?? err}`);
    process.exit(1);
  }
  if (loaded === null) {
    console.error(`[git-as] no credentials for role '${role}'. Run: node bin/lag-actors.js sync`);
    process.exit(2);
  }
  if (loaded.record.installationId === undefined) {
    console.error(`[git-as] role '${role}' provisioned but not installed on a repo.`);
    console.error(`Install: https://github.com/apps/${loaded.record.slug}/installations/new`);
    process.exit(2);
  }

  let token;
  try {
    token = await fetchInstallationToken({
      appId: loaded.record.appId,
      privateKey: loaded.privateKey,
      installationId: loaded.record.installationId,
    });
  } catch (err) {
    console.error(`[git-as] token mint failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  console.error(`[git-as] using installation token for role '${role}' (expires ~1h)`);

  // Branch by git subcommand. Push routes through URL-auth when the
  // remote is a GitHub HTTPS URL (the documented installation-token
  // flow for git smart-HTTP receive-pack); everything else uses the
  // Bearer extraHeader path.
  let spawnArgs = gitArgs;
  let spawnEnv;
  // Captured for the post-push upstream-setup step. Non-null only when
  // the user passed `-u` / `--set-upstream` AND the push was rewritten
  // through the URL-auth path. We strip the flag before spawning so
  // git does not persist the transient x-access-token URL into
  // `branch.<name>.remote` of `.git/config`  --  see extractSetUpstreamPlan
  // JSDoc for the leak mechanism.
  let postPushUpstream = null;
  if (isPushCommand(gitArgs)) {
    const remoteInfo = findRemoteArg(gitArgs);
    const remoteName = remoteInfo?.remote ?? 'origin';
    const remoteUrl = await resolveRemoteUrl(remoteName);
    const rewritten = buildPushSpawnArgs(gitArgs, remoteUrl, token.token);
    if (rewritten !== null) {
      // Push routes through URL-auth. If `-u` was present, strip it
      // from the spawn args so git does not record the URL (with
      // embedded token) as the branch's upstream remote.
      const upstreamPlan = extractSetUpstreamPlan(gitArgs);
      if (upstreamPlan !== null) {
        const reRewritten = buildPushSpawnArgs(
          upstreamPlan.strippedArgs,
          remoteUrl,
          token.token,
        );
        if (reRewritten !== null) {
          spawnArgs = reRewritten;
          postPushUpstream = {
            remoteName: upstreamPlan.remoteName,
            branchHint: upstreamPlan.branchHint,
          };
        } else {
          // Defensive fallback: re-rewrite failed (should be impossible
          // since we just rewrote successfully). Use the original
          // rewrite to preserve push behaviour; the leak risk surfaces
          // here but the alternative is a broken push.
          spawnArgs = rewritten;
        }
      } else {
        spawnArgs = rewritten;
      }
      spawnEnv = buildPushEnv();
    } else {
      // Non-GitHub-HTTPS remote or bare `git push`. The Bearer path
      // is kept so enterprise hosts / SSH aliases / bare-push invocations
      // still get credential-helper neutralization. Bare `git push`
      // on Cursor-managed hosts will still hit the receive-pack 401
      // hang; operators should pass an explicit remote.
      spawnEnv = buildReadOnlyEnv(token.token);
    }
  } else {
    spawnEnv = buildReadOnlyEnv(token.token);
  }

  let exitCode = 0;
  try {
    const result = await execa('git', spawnArgs, {
      env: { ...process.env, ...spawnEnv },
      stdio: 'inherit',
      reject: false,
    });
    if (result.signal !== undefined && result.signal !== null) {
      const label = result.signalDescription ?? result.signal;
      console.error(`[git-as] git child terminated by signal ${label}`);
      exitCode = 1;
    } else {
      exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
    }
  } catch (err) {
    console.error(`[git-as] failed to spawn git: ${err?.message ?? err}`);
    exitCode = 1;
  }

  // Post-push upstream setup. When the user passed `-u` and we routed
  // through URL-auth, we stripped `-u` from the spawn argv to avoid
  // persisting the transient x-access-token URL into `.git/config`.
  // After the push succeeds, set the upstream config manually using
  // the REMOTE NAME (e.g. `origin`), not the URL. Failure here does
  // not flip the push exit code  --  the push itself succeeded; setting
  // an upstream is operator-convenience, not correctness.
  if (exitCode === 0 && postPushUpstream !== null) {
    // Propagate `-C <dir>` from gitArgs to the post-push git calls so
    // they target the same working tree the push ran against. Without
    // this, `git-as lag-ceo -C /other/repo push -u origin foo` would
    // configure the upstream on whatever process.cwd() is, not the
    // intended repo. Bash-quoted multi-token `-C` values are passed
    // as a single argv element, so each `-C` consumes the next argv
    // element verbatim.
    const cFlags = [];
    for (let i = 0; i < gitArgs.length; i++) {
      if (gitArgs[i] === '-C' && typeof gitArgs[i + 1] === 'string') {
        cFlags.push('-C', gitArgs[i + 1]);
        i++;
      }
    }
    let branchName = postPushUpstream.branchHint;
    if (branchName === null) {
      try {
        const r = await execa(
          'git',
          [...cFlags, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { reject: false },
        );
        const stdout = typeof r.stdout === 'string' ? r.stdout.trim() : '';
        // Detached HEAD prints the literal string `HEAD`; treat that
        // as unresolved rather than writing meaningless
        // `branch.HEAD.remote` config.
        branchName = stdout.length > 0 && stdout !== 'HEAD' ? stdout : null;
      } catch {
        branchName = null;
      }
    }
    if (branchName !== null) {
      // Destination side of the refspec, when one was provided. For
      // `push -u origin feat/x:release-x` native git records
      // `branch.feat/x.merge = refs/heads/release-x`; preserve that
      // semantics by using `postPushUpstream.mergeRef` when set.
      // Otherwise fall back to `refs/heads/<branchName>` (the common
      // case, equivalent to `push -u origin feat/x`).
      const mergeRef = postPushUpstream.mergeRef !== null && postPushUpstream.mergeRef !== undefined
        ? postPushUpstream.mergeRef
        : `refs/heads/${branchName}`;
      await execa(
        'git',
        [...cFlags, 'config', `branch.${branchName}.remote`, postPushUpstream.remoteName],
        { reject: false, stdio: 'ignore' },
      );
      await execa(
        'git',
        [...cFlags, 'config', `branch.${branchName}.merge`, mergeRef],
        { reject: false, stdio: 'ignore' },
      );
      console.error(
        `[git-as] -u stripped from push to avoid token-URL leak; `
        + `set upstream to '${postPushUpstream.remoteName}/${branchName}' (merge=${mergeRef}) via 'git config'`,
      );
    } else {
      console.error(
        `[git-as] -u stripped from push to avoid token-URL leak; `
        + `could not resolve current branch (detached HEAD or rev-parse failed)  --  operator must set upstream manually`,
      );
    }
  }

  process.exit(exitCode);
}

await main();
