#!/usr/bin/env node
/**
 * cr-trigger: post `@coderabbitai review` as the LAG_OPS_PAT machine user.
 *
 * Usage:
 *   set -a && . .env && set +a
 *   node scripts/cr-trigger.mjs <pr-number> [--owner <o>] [--repo <r>]
 *
 * Why: canon `dev-cr-triggers-via-machine-user` requires CR triggers
 * to be authored by the machine user (LAG_OPS_PAT). CodeRabbit's
 * anti-loop ignores @-mentions from GitHub App / [bot] accounts, so
 * triggers from `gh-as lag-ceo pr comment` are silently dropped.
 *
 * Exit codes:
 *   0  trigger posted (returns the comment URL on stdout)
 *   1  bad usage
 *   2  HTTP / network failure
 */

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
  console.error('cr-trigger: LAG_OPS_PAT not set. Run: set -a && . .env && set +a');
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
