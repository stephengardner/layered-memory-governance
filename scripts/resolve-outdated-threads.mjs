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
 *
 * Repo identity: derived from `gh repo view --json nameWithOwner` so
 * a forked LAG (small-team / org consumer) can run this without
 * editing source. Falls through cleanly when gh-as is not configured.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReviewThreads, parseResolveArgs } from './lib/resolve-threads.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const HELP = 'usage: node scripts/resolve-outdated-threads.mjs <pr-number> [--dry-run]';

const RESOLVE_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){
    thread{ id isResolved }
  }
}`;

function ghApi(extraArgs) {
  return execFileSync('node', [resolve(REPO_ROOT, 'scripts/gh-as.mjs'), 'lag-ceo', 'api', ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: REPO_ROOT,
  });
}

/**
 * Discover the current repo's nameWithOwner via gh-as. Avoids
 * hardcoding org-specific literals so this script is reusable in
 * forks of the LAG substrate without source edits.
 */
function getRepoNameWithOwner() {
  const out = execFileSync('node', [resolve(REPO_ROOT, 'scripts/gh-as.mjs'), 'lag-ceo', 'repo', 'view', '--json', 'nameWithOwner'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: REPO_ROOT,
  });
  const parsed = JSON.parse(out);
  if (!parsed?.nameWithOwner || typeof parsed.nameWithOwner !== 'string' || !parsed.nameWithOwner.includes('/')) {
    throw new Error(`gh repo view returned unexpected nameWithOwner: ${JSON.stringify(parsed)}`);
  }
  return parsed.nameWithOwner;
}

async function main() {
  const parsed = parseResolveArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(HELP);
    process.exit(2);
  }
  if (parsed.pr === null) {
    console.error(HELP);
    process.exit(2);
  }

  const nwo = getRepoNameWithOwner();
  const [owner, repoName] = nwo.split('/');
  const LIST_QUERY = `query($n:Int!, $cursor:String){
    repository(owner:"${owner}",name:"${repoName}"){
      pullRequest(number:$n){
        reviewThreads(first:100, after:$cursor){
          nodes{ id isResolved isOutdated path }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }
  }`;

  /*
   * Paginate to avoid silent truncation on PRs with more than 100
   * review threads. A truncated read could leave outdated threads
   * unresolved, which is exactly the merge-gate failure this script
   * exists to prevent.
   */
  const allThreads = [];
  let cursor = null;
  while (true) {
    const queryArgs = ['graphql', '-f', `query=${LIST_QUERY}`, '-F', `n=${parsed.pr}`];
    if (cursor !== null) queryArgs.push('-f', `cursor=${cursor}`);
    const listOut = ghApi(queryArgs);
    const data = JSON.parse(listOut);
    const page = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) break;
    if (Array.isArray(page.nodes)) allThreads.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  const { resolveTargets, stillCurrent, alreadyResolved } = classifyReviewThreads(allThreads);
  console.log(
    `[resolve-outdated-threads] pr=${parsed.pr} repo=${nwo} total=${allThreads.length} ` +
    `outdated=${resolveTargets.length} still-current=${stillCurrent.length} ` +
    `already-resolved=${alreadyResolved.length}` +
    (parsed.dryRun ? ' (DRY-RUN)' : ''),
  );
  for (const t of stillCurrent) {
    console.log(`  STILL-CURRENT (left for human): ${t.id} path=${t.path ?? '<no-path>'}`);
  }
  for (const t of resolveTargets) {
    /*
     * Differentiate dry-run output from real resolution. A unified
     * "RESOLVING" log followed by the no-op-skip is misleading;
     * "WOULD RESOLVE" matches the actual semantics of the run.
     */
    if (parsed.dryRun) {
      console.log(`  WOULD RESOLVE (dry-run): ${t.id} path=${t.path ?? '<no-path>'}`);
      continue;
    }
    console.log(`  RESOLVING outdated thread: ${t.id} path=${t.path ?? '<no-path>'}`);
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
