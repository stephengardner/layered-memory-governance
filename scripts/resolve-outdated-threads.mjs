#!/usr/bin/env node
/**
 * Resolve outdated review threads on a PR.
 *
 * GitHub branch protection treats unresolved review threads as a hard
 * merge gate. When a PR-authoring agent addresses an inline review
 * comment in code, the corresponding thread becomes "outdated" (the
 * anchored line changed) but stays in the unresolved bucket until
 * someone explicitly marks it resolved via the API.
 *
 * Multiple PRs this session (#229, #234) stalled with all CI green
 * + reviewDecision empty + mergeStateStatus=BLOCKED purely because
 * outdated threads were left unresolved. The operator flagged this
 * 2026-04-27: "this should never happen again."
 *
 * Concrete fix: this script lists review threads on the given PR via
 * GraphQL, classifies them via classifyReviewThreads, and resolves
 * the outdated-and-unresolved bucket. Threads still anchored to live
 * code (unresolved + not outdated) are LEFT alone -- those need a
 * human (or a CR-side acknowledgement) because the suggestion may
 * still apply.
 *
 * Pre-merge integration: PR-authoring agent flows (run-pr-fix,
 * run-pr-landing, agent-direct fix-pushes) call this after each
 * fix-push so the merge gate clears as soon as CI does.
 *
 * Usage:
 *   node scripts/resolve-outdated-threads.mjs <pr-number> [--dry-run]
 *
 * Identity: routes through gh-as.mjs lag-ceo so the resolution is
 * attributed to the operator-proxy bot, per canon
 * `dev-bot-identity-mandatory-for-github-actions`. The machine user
 * (LAG_OPS_PAT) is reserved for CR triggers; thread resolution is a
 * routine PR action.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReviewThreads } from './lib/resolve-threads.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const REPO_OWNER = 'stephengardner';
const REPO_NAME = 'layered-autonomous-governance';

const LIST_QUERY = `query($n:Int!){
  repository(owner:"${REPO_OWNER}",name:"${REPO_NAME}"){
    pullRequest(number:$n){
      reviewThreads(first:100){
        nodes{ id isResolved isOutdated path }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){
    thread{ id isResolved }
  }
}`;

function parseArgs(argv) {
  const args = { pr: null, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (/^\d+$/.test(a)) args.pr = Number(a);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/resolve-outdated-threads.mjs <pr-number> [--dry-run]');
      process.exit(0);
    }
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function ghApi(args) {
  return execFileSync('node', [resolve(REPO_ROOT, 'scripts/gh-as.mjs'), 'lag-ceo', 'api', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: REPO_ROOT,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.pr === null) {
    console.error('usage: node scripts/resolve-outdated-threads.mjs <pr-number> [--dry-run]');
    process.exit(2);
  }
  const listOut = ghApi([
    'graphql',
    '-f', `query=${LIST_QUERY}`,
    '-F', `n=${args.pr}`,
  ]);
  const data = JSON.parse(listOut);
  const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const { resolveTargets, stillCurrent, alreadyResolved } = classifyReviewThreads(threads);
  console.log(
    `[resolve-outdated-threads] pr=${args.pr} total=${threads.length} ` +
    `outdated=${resolveTargets.length} still-current=${stillCurrent.length} ` +
    `already-resolved=${alreadyResolved.length}` +
    (args.dryRun ? ' (DRY-RUN)' : ''),
  );
  for (const t of stillCurrent) {
    console.log(`  STILL-CURRENT (left for human): ${t.id} path=${t.path ?? '<no-path>'}`);
  }
  for (const t of resolveTargets) {
    console.log(`  RESOLVING outdated thread: ${t.id} path=${t.path ?? '<no-path>'}`);
    if (args.dryRun) continue;
    const out = ghApi([
      'graphql',
      '-f', `query=${RESOLVE_MUTATION}`,
      '-f', `id=${t.id}`,
    ]);
    const r = JSON.parse(out);
    const ok = r?.data?.resolveReviewThread?.thread?.isResolved === true;
    console.log(`    -> isResolved=${ok}`);
    if (!ok) {
      console.error(`    -> FAILED to resolve thread ${t.id}; aborting`);
      process.exit(1);
    }
  }
  /*
   * Exit code semantics:
   *   0 - all targeted threads resolved (or dry-run completed)
   *   1 - resolve mutation failed for at least one target (stops + errors)
   *   2 - usage / arg error
   */
  process.exit(0);
}

main().catch((err) => {
  console.error('[resolve-outdated-threads] error:', err);
  process.exit(1);
});
