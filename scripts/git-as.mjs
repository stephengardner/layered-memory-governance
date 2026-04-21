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
 * 1. Mint a short-lived installation token for <role> via the same
 *    credentials store gh-as.mjs uses (dist/actors/provisioning +
 *    dist/external/github-app).
 * 2. Pass the token to git via `-c http.extraHeader=Authorization:
 *    Bearer <token>`. GitHub accepts App installation tokens in the
 *    Bearer form on HTTPS clone/push URLs, so we don't need to
 *    rewrite remote URLs.
 * 3. Neutralize any existing credential helper (-c credential.helper=)
 *    so the operator's cached PAT doesn't race with the bearer header.
 * 4. Set GIT_TERMINAL_PROMPT=0 so git fails fast rather than opening
 *    a credential prompt if auth somehow fails.
 *
 * The token is scoped to this subprocess only; the outer shell's git
 * config, credential cache, and environment remain unchanged.
 *
 * Scope
 * -----
 * Tuned for `git push`. Reading operations (fetch, clone, ls-remote)
 * work with the same override but usually don't need bot attribution.
 * Commands that don't talk to the remote (add, commit, rebase, diff)
 * also work but the wrapper is pointless for them - git-as mints a
 * token and does no local-only optimization. Prefer raw git for
 * local-only work.
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

async function main() {
  const role = process.argv[2];
  const gitArgs = process.argv.slice(3);
  if (!role || gitArgs.length === 0) {
    console.error('Usage: node scripts/git-as.mjs <role> <git-args...>');
    console.error('Example: node scripts/git-as.mjs lag-ceo push -u origin my-branch');
    process.exit(2);
  }

  const store = createCredentialsStore(STATE_DIR);
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

  // Breadcrumb on stderr (stdout stays clean for tooling that reads
  // git's output - `git push` isn't usually piped but keep the
  // convention consistent with gh-as.mjs).
  console.error(`[git-as] using installation token for role '${role}' (expires ~1h)`);

  const overrides = [
    '-c', `http.extraHeader=Authorization: Bearer ${token.token}`,
    // Empty credential.helper suppresses the system helper for this
    // invocation; the bearer header above is the only auth source.
    '-c', 'credential.helper=',
  ];

  let exitCode = 0;
  try {
    const result = await execa('git', [...overrides, ...gitArgs], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: 'inherit',
      reject: false,
    });
    if (result.signalDescription) {
      console.error(`[git-as] git child terminated by signal ${result.signalDescription}`);
      exitCode = 1;
    } else {
      exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
    }
  } catch (err) {
    console.error(`[git-as] failed to spawn git: ${err?.message ?? err}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

await main();
