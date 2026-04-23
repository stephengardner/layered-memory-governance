#!/usr/bin/env node
/**
 * update-branch-if-stale: detect a PR with a stale base branch and
 * merge main into its head via the GitHub App that authored it, so
 * CodeRabbit re-reviews and the merge gate re-evaluates.
 *
 * Problem this script mechanizes
 * ------------------------------
 * An autonomous org opens multiple PRs off main. One lands; main
 * advances. The others still reference the old base. CodeRabbit's
 * re-review logic does not fire on base-advances alone, and
 * `mergeStateStatus` flips to `BEHIND` with no bot-safe recovery
 * path. Operators historically click "Update branch" in the UI; this
 * script is the bot-safe equivalent.
 *
 * Mechanism
 * ---------
 * 1. `gh pr view <pr> --json mergeStateStatus,headRefOid,baseRefName`.
 * 2. Decide action from state via a pure function (`decideAction`).
 * 3. If action is `update`, `POST /repos/{owner}/{repo}/pulls/{pr}/update-branch`
 *    via `scripts/gh-as.mjs <role>`. The role defaults to `lag-ceo`;
 *    operators can pass `--actor=<role>` to attribute the merge to a
 *    different App.
 * 4. Emit a machine-readable JSON report on stdout so callers can
 *    chain without reparsing log prose. See the detailed "Exit
 *    codes" block below for the full failure-mode mapping.
 *
 * Bot-identity by construction
 * ----------------------------
 * The update-branch REST endpoint performs the merge commit under
 * whatever token is used to invoke it. Routing through gh-as means
 * the commit author is the App, not the operator — consistent with
 * canon "never act on GitHub under operator identity".
 *
 * Usage
 * -----
 *   node scripts/update-branch-if-stale.mjs <pr>
 *   node scripts/update-branch-if-stale.mjs <pr> --actor=lag-pr-landing
 *
 * Exit codes
 * ----------
 *   0: the PR is already fresh OR the update request was accepted
 *   1: the `gh pr view` read failed OR the update-branch POST failed
 *      (read stderr for the call that failed)
 *   2: invalid arguments (missing / non-numeric PR, unrecognized
 *      flag, invalid --actor role shape) OR the PR reported an
 *      `mergeStateStatus` value this script does not recognize
 *      (stdout JSON has the unrecognized value for audit)
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideAction } from './lib/update-branch-decider.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GH_AS = resolve(REPO_ROOT, 'scripts', 'gh-as.mjs');

// `decideAction` is re-exported so operators invoking the script
// programmatically can still import { decideAction } from this
// path; the canonical definition lives in ./lib/update-branch-decider.mjs
// (separated so tests can import it without the CLI shebang, which
// vitest's transformer stumbles on when importing a `#!`-headed
// .mjs on Windows CI).
export { decideAction };

function fetchPrState(prNumber) {
  const r = spawnSync(
    'gh',
    [
      'pr', 'view', String(prNumber),
      '--json', 'mergeStateStatus,headRefOid,baseRefName,number,isDraft,url',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`gh pr view failed (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
  }
  return JSON.parse(r.stdout);
}

function invokeUpdateBranch(prNumber, role) {
  // The gh-as wrapper injects the installation token as GH_TOKEN, so
  // gh respects the App identity on REST writes. We don't need to
  // hand-compute owner/repo; gh resolves them from the current
  // working directory's remote.
  const r = spawnSync(
    'node',
    [
      GH_AS, role, 'api',
      '-X', 'POST',
      `repos/{owner}/{repo}/pulls/${prNumber}/update-branch`,
      '--silent',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(
      `update-branch failed (exit ${r.status}): ${r.stderr.slice(0, 400) || r.stdout.slice(0, 400)}`,
    );
  }
  return true;
}

function parseArgs(argv) {
  const prRaw = argv[0];
  if (prRaw === undefined) {
    throw new Error('usage: update-branch-if-stale.mjs <pr> [--actor=<role>]');
  }
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`invalid PR number: ${JSON.stringify(prRaw)}`);
  }
  let actor = 'lag-ceo';
  for (const a of argv.slice(1)) {
    if (a.startsWith('--actor=')) {
      actor = a.slice('--actor='.length);
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(actor)) {
        throw new Error(`invalid --actor role: ${JSON.stringify(actor)}`);
      }
    } else {
      throw new Error(`unrecognized arg: ${JSON.stringify(a)}`);
    }
  }
  return { pr, actor };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[update-branch-if-stale] ${err.message}`);
    return 2;
  }
  let state;
  try {
    state = fetchPrState(args.pr);
  } catch (err) {
    console.error(`[update-branch-if-stale] ${err.message}`);
    return 1;
  }
  const action = decideAction(state);
  const report = {
    pr: args.pr,
    url: state.url,
    actor: args.actor,
    mergeStateStatus: state.mergeStateStatus,
    headRefOid: state.headRefOid,
    baseRefName: state.baseRefName,
    action: action.kind,
    reason: action.reason,
  };
  if (action.kind === 'noop') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  if (action.kind === 'unknown') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 2;
  }
  // action.kind === 'update'
  try {
    invokeUpdateBranch(args.pr, args.actor);
  } catch (err) {
    const failed = { ...report, error: err.message };
    process.stdout.write(JSON.stringify(failed, null, 2) + '\n');
    return 1;
  }
  process.stdout.write(JSON.stringify({ ...report, requestAccepted: true }, null, 2) + '\n');
  return 0;
}

// Only run when invoked directly (not when imported by tests).
const isDirect = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirect) {
  process.exit(main());
}
