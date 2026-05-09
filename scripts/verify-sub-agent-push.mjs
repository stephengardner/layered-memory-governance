#!/usr/bin/env node
/**
 * verify-sub-agent-push: reconcile a sub-agent's claimed terminal-state
 * against actual git + GitHub ground truth.
 *
 * Pattern this closes (substrate gap #283): a sub-agent dispatched to
 * implement a task may claim DONE in its terminal report but the
 * underlying actions never landed. Concrete failure modes observed:
 *
 *   - Sub-agent commits locally but `git push` fails silently and the
 *     terminal report still says "shipped".
 *   - Sub-agent pushes but `gh pr create` fails (invalid base ref,
 *     network timeout, App-token expired) and the terminal report
 *     misses it.
 *   - Sub-agent claims a PR number that does not actually exist.
 *
 * Without parent-side reconciliation, an orphan branch sits unreviewed
 * and the operator has to manually reconcile sub-agent claims vs
 * reality. This script gives the dispatching parent a one-shot
 * verification call: pass the claimed branch + (optional) claimed PR
 * number, and the script returns a structured JSON verdict the parent
 * can act on.
 *
 * Usage:
 *   node scripts/verify-sub-agent-push.mjs --branch <name> [--expect-pr <num>]
 *
 * Exit codes:
 *   0   verified: branch exists on origin AND has commits ahead of main
 *       AND (if --expect-pr) the PR number resolves to that branch
 *   1   missing-branch: no remote ref for the branch (sub-agent never pushed)
 *   2   no-commits: branch exists but has zero commits ahead of main
 *   3   pr-missing: --expect-pr provided but no PR exists for the branch
 *   4   pr-mismatch: PR for the branch exists but its number does not
 *       match the claimed --expect-pr value
 *   5   usage error OR an underlying tooling/network failure (a git or
 *       gh-as command failed for non-semantic reasons such as auth,
 *       timeout, or a missing executable). Tooling errors are surfaced
 *       to stderr so the parent does not misclassify them as
 *       missing-branch / no-commits / pr-missing semantic verdicts.
 *
 * Stdout always emits a JSON envelope so a parent agent can parse the
 * verdict programmatically. Example:
 *
 *   {
 *     "ok": true,
 *     "branch": "feat/foo",
 *     "remote_sha": "abc123",
 *     "commits_ahead_of_main": 3,
 *     "pr": { "number": 42, "state": "OPEN", "title": "..." }
 *   }
 *
 *   {
 *     "ok": false,
 *     "code": "missing-branch",
 *     "branch": "feat/foo",
 *     "message": "no remote ref for branch on origin"
 *   }
 *
 * The script is read-only against GitHub + git; it never pushes,
 * commits, or mutates state. Safe to call from any parent without
 * additional governance scoping.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { branch: null, expectPr: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--branch') {
      i += 1;
      out.branch = argv[i] ?? null;
    } else if (a === '--expect-pr') {
      i += 1;
      const n = Number.parseInt(argv[i] ?? '', 10);
      if (Number.isInteger(n) && n > 0) out.expectPr = n;
      else return { ok: false, reason: `--expect-pr must be a positive integer (got ${argv[i]})` };
    } else if (a === '--help' || a === '-h') {
      return { ok: false, reason: 'usage' };
    } else {
      return { ok: false, reason: `unknown argument: ${a}` };
    }
  }
  if (out.branch === null) return { ok: false, reason: '--branch is required' };
  return { ok: true, args: out };
}

function emit(verdict) {
  console.log(JSON.stringify(verdict, null, 2));
}

async function fetchOriginQuiet() {
  try {
    await execa('git', ['fetch', '--quiet', 'origin'], { cwd: REPO_ROOT });
  } catch (err) {
    // Fail fast: a fetch failure means origin/main is stale, which
    // makes the commits-ahead computation unreliable and could
    // misclassify a follow-on empty ls-remote as missing-branch.
    // Surface the underlying error and exit 5 so the parent sees
    // a tooling failure, not a semantic verdict.
    failTooling('git fetch origin', err);
  }
}

/**
 * Surface an underlying tooling / network failure as exit 5 with a
 * stderr line, NOT as a `null`/`0` semantic verdict. Otherwise an auth
 * timeout on `git ls-remote` is misreported to the parent as
 * `missing-branch` and triggers an unsticking action against a phantom.
 */
function failTooling(label, err) {
  const stderr = (err && typeof err.stderr === 'string') ? err.stderr.trim() : '';
  const msg = (err && typeof err.message === 'string') ? err.message : String(err);
  console.error(`[verify-sub-agent-push] ${label} failed (tooling/network, NOT a semantic verdict): ${msg}`);
  if (stderr.length > 0) console.error(`[verify-sub-agent-push] ${label} stderr: ${stderr.slice(0, 800)}`);
  process.exit(5);
}

async function getRemoteSha(branch) {
  let result;
  try {
    result = await execa('git', ['ls-remote', '--heads', 'origin', branch], { cwd: REPO_ROOT });
  } catch (err) {
    failTooling('git ls-remote', err);
    return null;
  }
  const line = result.stdout.trim();
  if (line === '') return null;
  const sha = line.split(/\s+/)[0];
  return sha ?? null;
}

async function getCommitsAheadOfMain(remoteSha) {
  let result;
  try {
    result = await execa(
      'git',
      ['rev-list', '--count', `origin/main..${remoteSha}`],
      { cwd: REPO_ROOT },
    );
  } catch (err) {
    failTooling('git rev-list', err);
    return 0;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Bot identity used for the read-only `gh pr list` lookup. Defaults to
 * `lag-ceo` (the operator-proxy bot in this deployment) but is
 * overridable via `VERIFY_GH_ACTOR` so a different deployment running
 * this script can route the read through whatever bot identity it has
 * provisioned. Reads stay routed through `gh-as.mjs` either way; the
 * env var only swaps the actor argument it passes to the gh CLI.
 */
const GH_ACTOR = process.env['VERIFY_GH_ACTOR'] ?? 'lag-ceo';

async function getPrsForBranch(branch) {
  const ghAs = resolve(REPO_ROOT, 'scripts/gh-as.mjs');
  let result;
  try {
    result = await execa(
      'node',
      [ghAs, GH_ACTOR, 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,title,headRefName'],
      { cwd: REPO_ROOT },
    );
  } catch (err) {
    failTooling('gh-as pr list', err);
    return [];
  }
  let list;
  try {
    list = JSON.parse(result.stdout.trim() || '[]');
  } catch (err) {
    failTooling('gh-as pr list (JSON parse)', err);
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.reason !== 'usage') {
      console.error(`[verify-sub-agent-push] ${parsed.reason}`);
    }
    console.error('usage: node scripts/verify-sub-agent-push.mjs --branch <name> [--expect-pr <num>]');
    process.exit(5);
  }

  const { branch, expectPr } = parsed.args;

  await fetchOriginQuiet();

  const remoteSha = await getRemoteSha(branch);
  if (remoteSha === null) {
    emit({
      ok: false,
      code: 'missing-branch',
      branch,
      message: 'no remote ref for branch on origin (sub-agent never pushed, OR push silently failed)',
    });
    process.exit(1);
  }

  const ahead = await getCommitsAheadOfMain(remoteSha);
  if (ahead <= 0) {
    emit({
      ok: false,
      code: 'no-commits',
      branch,
      remote_sha: remoteSha,
      commits_ahead_of_main: ahead,
      message: 'branch exists on origin but has zero commits ahead of main (sub-agent pushed but produced no diff)',
    });
    process.exit(2);
  }

  const prs = await getPrsForBranch(branch);
  if (expectPr !== null) {
    if (prs.length === 0) {
      emit({
        ok: false,
        code: 'pr-missing',
        branch,
        remote_sha: remoteSha,
        commits_ahead_of_main: ahead,
        expected_pr: expectPr,
        message: 'sub-agent claimed PR was opened but no PR exists for this branch (gh pr create may have failed silently)',
      });
      process.exit(3);
    }
    // Search the full list for a matching PR. A branch can have more
    // than one PR over its lifetime (closed-then-reopened, or a stale
    // duplicate), so list[0] is not authoritative for "did the claimed
    // number land on this branch."
    const match = prs.find((p) => p.number === expectPr);
    if (match === undefined) {
      const candidates = prs.map((p) => ({ number: p.number, state: p.state, title: p.title }));
      emit({
        ok: false,
        code: 'pr-mismatch',
        branch,
        remote_sha: remoteSha,
        commits_ahead_of_main: ahead,
        expected_pr: expectPr,
        actual_prs: candidates,
        message: `sub-agent claimed PR #${expectPr} but no PR with that number exists for this branch (found: ${candidates.map((c) => `#${c.number}`).join(', ')})`,
      });
      process.exit(4);
    }
    emit({
      ok: true,
      branch,
      remote_sha: remoteSha,
      commits_ahead_of_main: ahead,
      pr: { number: match.number, state: match.state, title: match.title },
    });
    process.exit(0);
  }

  // No --expect-pr: surface the most recent PR (list[0] is gh's default
  // ordering, newest first) as informational context.
  emit({
    ok: true,
    branch,
    remote_sha: remoteSha,
    commits_ahead_of_main: ahead,
    pr: prs.length === 0 ? null : { number: prs[0].number, state: prs[0].state, title: prs[0].title },
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(`[verify-sub-agent-push] ${err.message}`);
  process.exit(5);
});
