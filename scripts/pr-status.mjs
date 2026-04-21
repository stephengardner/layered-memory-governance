#!/usr/bin/env node
/**
 * pr-status: canonical multi-surface read of a GitHub PR's review state.
 *
 * Existence rationale: session agents kept making decisions on partial
 * observations (e.g., polling one status API and missing that CodeRabbit
 * had completed a review on a different surface). See canon directive
 * `dev-multi-surface-review-observation` for the belief layer, and
 * `arch-pr-state-observation-via-actor-only` for the long-term shape.
 * This CLI is the short-term mechanism: one command, one output shape,
 * every surface covered, no way to accidentally read a subset.
 *
 * Wraps `PrReviewAdapter.getPrReviewStatus(pr)` (the composite read
 * shipped alongside this script) and pretty-prints the snapshot so the
 * operator and the agent see the same thing. The PreToolUse hook
 * `.claude/hooks/enforce-pr-status-composite.mjs` blocks ad-hoc
 * `gh pr view` / `gh api .../pulls/...` state reads and redirects here,
 * so the agent's tool surface forces composite reads by default.
 *
 * Usage:
 *   node scripts/pr-status.mjs <pr-number> [--owner owner] [--repo repo]
 *   node scripts/pr-status.mjs 52
 *
 * Resolves owner/repo via `gh repo view` if not passed, matching the
 * run-pr-landing.mjs convention.
 *
 * Output: human-readable text. Stdout only; stderr is reserved for
 * wrapper diagnostics (token mint, operator-action atom log from
 * gh-as.mjs, etc.) so piping into `| grep` or `| less` works cleanly.
 *
 * Design note (long-term direction):
 *   The sanctioned long-term shape per
 *   `arch-pr-state-observation-via-actor-only` is that the pr-landing
 *   actor IS the PR observer: session agents do not poll state
 *   directly, they consume the actor's output (escalation actor-message
 *   atom + PR comment via Gap 1). This script is a stepping stone:
 *   it uses the same composite read the actor uses, but invokes it
 *   directly from the session instead of through the actor loop. A
 *   follow-up will add `run-pr-landing.mjs --observe-only` which runs
 *   the actor's observation step + writes the atom (audit trail) +
 *   returns the atom id. This script will then become a thin wrapper
 *   around that invocation, keeping the operator's "show me state"
 *   ergonomic unchanged while routing every observation through the
 *   actor + atom trail.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { GitHubPrReviewAdapter } from '../dist/actors/pr-review/index.js';
import { createGhClient } from '../dist/external/github/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { prNumber: null, owner: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/pr-status.mjs <pr-number> [--owner o --repo r]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else if (args.prNumber === null) {
      const n = Number(a);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`ERROR: pr-number must be a positive integer, got "${a}".`);
        process.exit(2);
      }
      args.prNumber = n;
    } else {
      console.error(`Unexpected positional argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function resolveOwnerRepo(args) {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  const result = await execa('gh', ['repo', 'view', '--json', 'owner,name'], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`Could not resolve owner/repo via gh; pass --owner and --repo explicitly. stderr: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  return { owner: parsed.owner.login, repo: parsed.name };
}

/**
 * Render a single CheckRun / status line. Uniform format across the
 * two legacy vs check-runs surfaces so an operator reading the output
 * does not have to mentally map state names.
 */
function renderCheck(name, status, conclusion) {
  const s = conclusion ?? status ?? '?';
  return `  - ${name.padEnd(40)} ${s}`;
}

function renderReview(r) {
  const ts = r.submittedAt || '?';
  const body = r.body ? ` — ${r.body.slice(0, 80).replace(/\n/g, ' ')}` : '';
  return `  - ${r.author.padEnd(32)} ${r.state.padEnd(20)} ${ts}${body}`;
}

function renderComment(c) {
  const loc = c.path
    ? `${c.path}${c.line !== undefined ? ':' + c.line : ''}`
    : `comment ${c.id}`;
  const head = c.body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '(empty)';
  const stripped = head.replace(/^\*\*/, '').replace(/\*\*$/, '');
  return `  - ${loc.padEnd(48)} ${c.author.padEnd(20)} ${stripped.slice(0, 80)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prNumber === null) {
    console.error('ERROR: pr-number is required (first positional argument).');
    process.exit(2);
  }
  const { owner, repo } = await resolveOwnerRepo(args);
  const pr = { owner, repo, number: args.prNumber };

  const client = createGhClient();
  const adapter = new GitHubPrReviewAdapter({ client });

  const status = await adapter.getPrReviewStatus(pr);

  // Header section: the single-line "at a glance" operators want to
  // see first, then every surface below it. Always render every
  // section (even when empty) so the absence of data is distinguishable
  // from the absence of the section in the output.
  console.log(`PR ${owner}/${repo}#${pr.number}`);
  console.log(`  mergeable          ${status.mergeable === null ? 'UNKNOWN' : status.mergeable}`);
  console.log(`  mergeStateStatus   ${status.mergeStateStatus ?? '?'}`);
  if (status.partial) {
    console.log(`  partial            true (${status.partialSurfaces.length} surfaces failed)`);
    for (const s of status.partialSurfaces) console.log(`    - ${s}`);
  }

  console.log('');
  console.log(`submitted reviews (${status.submittedReviews.length}):`);
  if (status.submittedReviews.length === 0) console.log('  (none)');
  for (const r of status.submittedReviews) console.log(renderReview(r));

  console.log('');
  console.log(`check-runs (${status.checkRuns.length}):`);
  if (status.checkRuns.length === 0) console.log('  (none)');
  for (const c of status.checkRuns) console.log(renderCheck(c.name, c.status, c.conclusion));

  console.log('');
  console.log(`legacy statuses (${status.legacyStatuses.length}):`);
  if (status.legacyStatuses.length === 0) console.log('  (none)');
  for (const s of status.legacyStatuses) console.log(renderCheck(s.context, s.state, null));

  console.log('');
  console.log(`unresolved line comments (${status.lineComments.length}):`);
  if (status.lineComments.length === 0) console.log('  (none)');
  for (const c of status.lineComments) console.log(renderComment(c));

  console.log('');
  console.log(`body-scoped nits (${status.bodyNits.length}):`);
  if (status.bodyNits.length === 0) console.log('  (none)');
  for (const c of status.bodyNits) console.log(renderComment(c));

  // Exit code signals the broad readiness outcome so shell consumers
  // can gate on it. Matches the run-pr-landing exit convention:
  //   0 = CLEAN (mergeable + no blocking surfaces)
  //   1 = BLOCKED / partial (decision needed)
  //   2 = UNKNOWN (mergeable state still computing)
  if (status.partial) process.exit(1);
  if (status.mergeable === null || status.mergeStateStatus === null) process.exit(2);
  if (status.mergeStateStatus === 'CLEAN') process.exit(0);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[pr-status] FAILED: ${err?.message ?? err}`);
  process.exit(2);
});
