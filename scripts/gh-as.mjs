#!/usr/bin/env node
/**
 * gh-as: run a gh CLI command under a provisioned bot identity.
 *
 * Usage:
 *   node scripts/gh-as.mjs <role> <gh-args...>
 *
 * Examples:
 *   node scripts/gh-as.mjs lag-cto pr create --title "..." --body "..."
 *   node scripts/gh-as.mjs lag-pr-landing api repos/o/r/pulls/1/comments
 *
 * Mints a fresh installation token for <role> via gh-token-for.mjs,
 * sets it as GH_TOKEN in the child process environment, and execs
 * `gh <gh-args...>`. The child's stdout/stderr are piped through so
 * the caller sees gh's output verbatim.
 *
 * The token exists only for the duration of the child process;
 * it is not written to disk, not logged, and not inherited by the
 * parent shell. Each invocation is a fresh short-lived token (GitHub
 * Apps cap installation tokens at ~1 hour).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
  const ghArgs = process.argv.slice(3);
  if (!role || ghArgs.length === 0) {
    console.error('Usage: node scripts/gh-as.mjs <role> <gh-args...>');
    console.error('Example: node scripts/gh-as.mjs lag-cto pr create --title T --body B');
    process.exit(2);
  }

  const store = createCredentialsStore(STATE_DIR);
  const loaded = await store.load(role);
  if (loaded === null) {
    console.error(`[gh-as] no credentials for role '${role}'. Run: node bin/lag-actors.js sync`);
    process.exit(2);
  }
  if (loaded.record.installationId === undefined) {
    console.error(`[gh-as] role '${role}' provisioned but not installed on a repo.`);
    console.error(`Install: https://github.com/apps/${loaded.record.slug}/installations/new`);
    console.error(`Then:    node bin/lag-actors.js demo-pr --role ${role} --repo <owner/repo>`);
    process.exit(2);
  }

  const token = await fetchInstallationToken({
    appId: loaded.record.appId,
    privateKey: loaded.privateKey,
    installationId: loaded.record.installationId,
  });

  // Exec gh with GH_TOKEN overridden for this child only. GH_TOKEN
  // beats any cached `gh auth` state; the parent shell is unaffected.
  // On Windows, spawning "gh" resolves gh.exe via PATH.
  const child = spawn('gh', ghArgs, {
    env: {
      ...process.env,
      GH_TOKEN: token.token,
      // Defensive: some deployments have GITHUB_TOKEN set too.
      GITHUB_TOKEN: token.token,
    },
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`[gh-as] failed to spawn gh: ${err?.message ?? err}`);
    process.exit(1);
  });
}

await main();
