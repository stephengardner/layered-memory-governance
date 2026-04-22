#!/usr/bin/env node
/**
 * gh-token-for: emit a short-lived GitHub App installation token
 * for a provisioned actor role.
 *
 * Intended use is one of:
 *
 *   Eval-into-env (shell):
 *     $Env:GH_TOKEN = node scripts/gh-token-for.mjs lag-cto
 *     gh pr create ...                      # runs as lag-cto[bot]
 *
 *   Inline exec:
 *     $Env:GH_TOKEN = node scripts/gh-token-for.mjs lag-cto; gh api ...
 *
 *   Or via scripts/gh-as.mjs which wraps the pattern.
 *
 * The token is valid for ~1 hour per GitHub. Mint a fresh one per
 * session or per script invocation; do not cache across hours.
 *
 * The App credentials (.lag/apps/<role>.json + private key) must
 * already exist. Provisioned via `bin/lag-actors.js sync`.
 *
 * Exits non-zero if the role is not provisioned or the installation
 * token mint fails; stderr carries the reason.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCredentialsStore,
} from '../dist/runtime/actors/provisioning/index.js';
import {
  fetchInstallationToken,
} from '../dist/external/github-app/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

async function main() {
  const role = process.argv[2];
  if (!role) {
    console.error('Usage: node scripts/gh-token-for.mjs <role>');
    console.error('Example: node scripts/gh-token-for.mjs lag-cto');
    process.exit(2);
  }
  const store = createCredentialsStore(STATE_DIR);
  // store.load() can throw for a malformed .lag/apps/<role>.json, a
  // missing PEM, or an assertSafeRole violation. Keep the error
  // surface uniform with the mint step below so operators always see
  // a `[gh-token-for] ...` one-liner instead of a raw V8
  // unhandled-rejection stack depending on which step failed.
  let loaded;
  try {
    loaded = await store.load(role);
  } catch (err) {
    console.error(`[gh-token-for] failed to load credentials for '${role}': ${err?.message ?? err}`);
    process.exit(1);
  }
  if (loaded === null) {
    console.error(`[gh-token-for] no credentials for role '${role}'.`);
    console.error(`Run: node bin/lag-actors.js sync`);
    process.exit(2);
  }
  if (loaded.record.installationId === undefined) {
    console.error(`[gh-token-for] role '${role}' is provisioned but not installed on a repo.`);
    console.error(`Install via: https://github.com/apps/${loaded.record.slug}/installations/new`);
    console.error(`Then run: node bin/lag-actors.js demo-pr --role ${role} --repo <owner/repo>  # records the installation id`);
    process.exit(2);
  }
  try {
    const token = await fetchInstallationToken({
      appId: loaded.record.appId,
      privateKey: loaded.privateKey,
      installationId: loaded.record.installationId,
    });
    // Emit ONLY the token on stdout so it's cleanly consumable via
    // $Env:GH_TOKEN = node scripts/gh-token-for.mjs lag-cto
    process.stdout.write(token.token);
  } catch (err) {
    console.error(`[gh-token-for] token mint failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}

await main();
