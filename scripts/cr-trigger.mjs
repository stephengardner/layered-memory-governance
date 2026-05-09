#!/usr/bin/env node
/**
 * cr-trigger: post `@coderabbitai review` as the LAG_OPS_PAT machine user.
 *
 * Usage:
 *   node scripts/cr-trigger.mjs <pr-number> [--owner <o>] [--repo <r>]
 *
 * The script auto-loads `.env` from the repo root via Node's built-in
 * `process.loadEnvFile` so a fresh shell (cron tick, autonomous-loop
 * pass, one-off operator invocation) does not need a manual
 * `set -a && . .env && set +a` step. Existing process env vars take
 * precedence over the .env file (Node's loadEnvFile semantics: it
 * reads but does not overwrite). Missing or unreadable .env is
 * fail-soft: the LAG_OPS_PAT-presence check below is the
 * authoritative gate and surfaces the missing-credential error.
 *
 * Why: canon `dev-cr-triggers-via-machine-user` requires CR triggers
 * to be authored by the machine user (LAG_OPS_PAT). CodeRabbit's
 * anti-loop ignores @-mentions from GitHub App / [bot] accounts, so
 * triggers from `gh-as lag-ceo pr comment` are silently dropped.
 *
 * Exit codes:
 *   0  trigger posted (returns the comment URL on stdout)
 *   1  bad usage / LAG_OPS_PAT unset
 *   2  HTTP / network failure
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.LAG_OPS_PAT) {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    process.loadEnvFile(resolve(repoRoot, '.env'));
  } catch {
    // No .env file or unreadable; the LAG_OPS_PAT check below is
    // authoritative and emits a clear missing-credential error.
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.error('usage: node scripts/cr-trigger.mjs <pr-number> [--owner <o>] [--repo <r>]');
  process.exit(1);
}

const prNumber = Number.parseInt(args[0], 10);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  console.error(`cr-trigger: invalid pr-number '${args[0]}'`);
  process.exit(1);
}

let owner = 'stephengardner';
let repo = 'layered-autonomous-governance';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--owner' && i + 1 < args.length) { owner = args[++i]; continue; }
  if (args[i] === '--repo' && i + 1 < args.length) { repo = args[++i]; continue; }
}

const token = process.env.LAG_OPS_PAT?.trim();
if (!token) {
  console.error('cr-trigger: LAG_OPS_PAT not set. Add to .env at repo root or export in env.');
  process.exit(1);
}

const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

let response;
try {
  response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'lag-cr-trigger/lag-ops',
    },
    body: JSON.stringify({ body: '@coderabbitai review' }),
  });
} catch (err) {
  const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  const label = isTimeout ? 'timeout after 15s' : 'network error';
  console.error(`cr-trigger: ${label}: ${err?.message ?? err}`);
  process.exit(2);
}

if (!response.ok) {
  let detail = '';
  try { detail = (await response.text()).slice(0, 300); } catch {}
  console.error(`cr-trigger: HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  process.exit(2);
}

let json = {};
try { json = await response.json(); } catch (err) {
  console.error(`cr-trigger: failed to parse response: ${err?.message ?? err}`);
  process.exit(2);
}
const commentUrl = json?.html_url;
if (typeof commentUrl !== 'string' || commentUrl.length === 0) {
  console.error('cr-trigger: response missing html_url; downstream tooling cannot trust the URL');
  process.exit(2);
}
console.log(commentUrl);
process.exit(0);
