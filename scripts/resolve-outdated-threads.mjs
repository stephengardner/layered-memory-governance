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
 * Lists review threads on the given PR via GraphQL, classifies them
 * via classifyReviewThreads, and resolves the outdated-and-unresolved
 * bucket. Threads still anchored to live code (unresolved + not
 * outdated) are left alone -- those still need a human (or a CR-side
 * acknowledgement) because the suggestion may still apply.
 *
 * Usage:
 *   node scripts/resolve-outdated-threads.mjs <pr-number> [--dry-run]
 *
 * Identity: routes through gh-as.mjs lag-ceo so the resolution is
 * attributed to the operator-proxy bot. The machine user (LAG_OPS_PAT)
 * is reserved for CR triggers; thread resolution is a routine PR
 * action.
 *
 * Repo identity: derived from `gh repo view --json nameWithOwner` so
 * a forked LAG can run this without editing source. The gh-as
 * sub-call throws if gh-as is not configured for the lag-ceo role; the
 * caller sees a non-zero exit with the underlying error.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReviewThreads, parseResolveArgs } from './lib/resolve-threads.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const GH_AS = resolve(REPO_ROOT, 'scripts/gh-as.mjs');

const HELP = 'usage: node scripts/resolve-outdated-threads.mjs <pr-number> [--dry-run]';

const LIST_QUERY = `query($owner:String!, $name:String!, $n:Int!, $cursor:String){
  repository(owner:$owner, name:$name){
    pullRequest(number:$n){
      reviewThreads(first:100, after:$cursor){
        nodes{ id isResolved isOutdated path }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){
    thread{ id isResolved }
  }
}`;

/*
 * Cap on pagination iterations. A theoretical-only safety net: if the
 * server ever returns hasNextPage=true with an unchanged endCursor (or
 * keeps returning hasNextPage=true past any reasonable count) the loop
 * exits and the script fails hard rather than spinning forever or
 * silently truncating inside an actor flow.
 */
const MAX_PAGES = 50;

/**
 * Single shared invocation point for `node scripts/gh-as.mjs lag-ceo …`.
 * All gh-as calls in this script flow through here so a future actor
 * cannot accidentally introduce a third copy of the execFileSync
 * shape; per canon `dev-extract-helpers-at-N-2`.
 */
function ghAsCeo(extraArgs) {
  return execFileSync('node', [GH_AS, 'lag-ceo', ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: REPO_ROOT,
  });
}

function ghApi(apiArgs) {
  return ghAsCeo(['api', ...apiArgs]);
}

/**
 * Discover the current repo's nameWithOwner via gh-as. Avoids
 * hardcoding org-specific literals so this script is reusable in
 * forks of the LAG substrate without source edits.
 */
function getRepoNameWithOwner() {
  const out = ghAsCeo(['repo', 'view', '--json', 'nameWithOwner']);
  const parsed = JSON.parse(out);
  if (!parsed?.nameWithOwner || typeof parsed.nameWithOwner !== 'string' || !parsed.nameWithOwner.includes('/')) {
    throw new Error(`gh repo view returned unexpected nameWithOwner: ${JSON.stringify(parsed)}`);
  }
  return parsed.nameWithOwner;
}

function main() {
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

  /*
   * Paginate to avoid silent truncation on PRs with more than 100
   * review threads. A truncated read could leave outdated threads
   * unresolved, which is exactly the merge-gate failure this script
   * exists to prevent. MAX_PAGES + same-cursor detection bound the
   * loop against pathological server responses; truncation is then
   * surfaced as a hard failure (unless --dry-run, where the operator
   * is iterating and a soft warning is more useful).
   */
  const allThreads = [];
  let cursor = null;
  let pageCount = 0;
  let truncated = false;
  while (pageCount < MAX_PAGES) {
    const queryArgs = [
      'graphql',
      '-f', `query=${LIST_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${repoName}`,
      '-F', `n=${parsed.pr}`,
    ];
    if (cursor !== null) queryArgs.push('-f', `cursor=${cursor}`);
    const listOut = ghApi(queryArgs);
    const data = JSON.parse(listOut);
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.error(
        `[resolve-outdated-threads] GraphQL errors on pr=${parsed.pr}:`,
        JSON.stringify(data.errors, null, 2),
      );
      process.exit(1);
    }
    const page = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) break;
    if (Array.isArray(page.nodes)) allThreads.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    const nextCursor = page.pageInfo.endCursor;
    if (nextCursor === cursor) {
      console.error(`[resolve-outdated-threads] cursor stuck at ${cursor}; aborting pagination`);
      truncated = true;
      break;
    }
    cursor = nextCursor;
    pageCount += 1;
  }
  if (pageCount >= MAX_PAGES) {
    console.error(`[resolve-outdated-threads] hit MAX_PAGES=${MAX_PAGES}; threads may be truncated`);
    truncated = true;
  }

  const { resolveTargets, stillCurrent, alreadyResolved } = classifyReviewThreads(allThreads);
  console.log(
    `[resolve-outdated-threads] pr=${parsed.pr} repo=${nwo} total=${allThreads.length} ` +
    `outdated=${resolveTargets.length} still-current=${stillCurrent.length} ` +
    `already-resolved=${alreadyResolved.length}` +
    (truncated ? ' (TRUNCATED)' : '') +
    (parsed.dryRun ? ' (DRY-RUN)' : ''),
  );

  /*
   * Hard-fail on truncation when running for real. A truncated read
   * could leave outdated threads unresolved, which is the exact
   * merge-gate failure this script exists to prevent. Dry-run keeps
   * the soft-warning path so operators can see the diagnostic without
   * blocking their inspection.
   */
  if (truncated && !parsed.dryRun) {
    console.error('[resolve-outdated-threads] truncation detected; refusing to proceed (run with --dry-run to inspect)');
    process.exit(1);
  }
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
    if (Array.isArray(r?.errors) && r.errors.length > 0) {
      console.error(
        `    -> GraphQL errors resolving ${t.id}:`,
        JSON.stringify(r.errors, null, 2),
      );
      process.exit(1);
    }
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
   *   1 - resolve mutation failed for at least one target,
   *       GraphQL error, or truncated read (in non-dry-run)
   *   2 - usage / arg error
   */
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('[resolve-outdated-threads] error:', err);
  process.exit(1);
}
