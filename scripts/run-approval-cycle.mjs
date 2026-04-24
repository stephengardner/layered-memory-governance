#!/usr/bin/env node
/**
 * Approval-cycle daemon: the canonical "move plans forward" runner.
 *
 * One pass, in fixed order, over the four ticks that advance a plan
 * from proposed to succeeded:
 *
 *   1. runAutoApprovePass         proposed -> approved
 *                                  for single-principal low-stakes allowlist
 *                                  (pol-plan-auto-approve-low-stakes).
 *   2. runPlanApprovalTick        proposed -> approved (or abandoned)
 *                                  for distinct-principal consensus
 *                                  (pol-plan-multi-reviewer-approval).
 *   3. runPlanStateReconcileTick  executing|approved -> succeeded|abandoned
 *                                  when a pr-observation carries a
 *                                  terminal merge_state_status.
 *   4. runDispatchTick            approved -> executing
 *                                  via SubActorRegistry.invoke.
 *
 * Order matters: auto-approve + multi-reviewer-approve BEFORE dispatch
 * so a plan that gained consensus this tick also gets dispatched this
 * tick (no wait for the next loop). Reconcile lands mid-pass because a
 * plan that succeeded/abandoned this tick SHOULD NOT be re-dispatched
 * by step 4; the reconcile pass flips its state out of `approved`
 * first.
 *
 * Script defaults to --once (single pass, exit). Non-zero exit only on
 * tick-thrown errors. The daemon mode (long-running loop with a sleep
 * between passes) is a follow-up; shipping --once first keeps the
 * surface minimal and matches how run-pr-landing.mjs / run-cto-self-
 * audit-continue.mjs compose.
 *
 * Dispatch requires a SubActorRegistry populated with invokers. For
 * V0 this script registers:
 *   - `auditor-actor` via runAuditor (read-only, always safe to invoke)
 *   - (extension hook: operators register additional invokers by
 *     forking this script for their deployment shape, since invoker
 *     registration is instance-policy, not framework mechanism)
 *
 * Usage:
 *   node scripts/run-approval-cycle.mjs --root-dir .lag --principal-id operator
 *   node scripts/run-approval-cycle.mjs --root-dir .lag --principal-id operator --once
 *
 * `--root-dir` is required (avoid defaulting to a repo-shaped path
 * that could surprise an operator running from a different cwd).
 * `--principal-id` is required whenever dispatch could happen; it
 * names the operator-or-agent principal used for dispatch audit
 * logs. The script does not assume a default.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  SubActorRegistry,
  runAuditor,
  runAutoApprovePass,
  runDispatchTick,
  runPlanApprovalTick,
} from '../dist/actor-message/index.js';
import { runPlanStateReconcileTick } from '../dist/runtime/plans/pr-merge-reconcile.js';

function parseArgs(argv) {
  const args = {
    rootDir: null,
    principalId: null,
    once: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root-dir' && i + 1 < argv.length) args.rootDir = argv[++i];
    else if (a === '--principal-id' && i + 1 < argv.length) args.principalId = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: node scripts/run-approval-cycle.mjs --root-dir <path> [--principal-id <id>] [--once]',
        '',
        'Runs one pass of the approval cycle, in order:',
        '  1. runAutoApprovePass          (single-principal allowlist)',
        '  2. runPlanApprovalTick         (distinct-principal consensus)',
        '  3. runPlanStateReconcileTick   (pr-merge writeback)',
        '  4. runDispatchTick             (approved -> executing)',
        '',
        'Options:',
        '  --root-dir <path>      Required. The LAG state dir (e.g. .lag).',
        '  --principal-id <id>    Principal id used for dispatch audit logs.',
        '                         Required when dispatch could fire; treat as',
        '                         required for safety.',
        '  --once                 Run one pass and exit (default).',
        '',
        'Exit codes:',
        '  0  all ticks completed without throwing',
        '  1  a tick threw; see stderr',
        '  2  argument error',
      ].join('\n'));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.rootDir === null) {
    console.error('ERROR: --root-dir <path> is required.');
    process.exit(2);
  }
  if (args.principalId === null) {
    console.error(
      'ERROR: --principal-id <id> is required. Dispatch needs a principal for audit\n'
      + 'logs; pass your operator or a dedicated daemon principal id.',
    );
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = resolve(args.rootDir);
  if (!existsSync(rootDir)) {
    console.error(`ERROR: --root-dir ${rootDir} does not exist.`);
    process.exit(2);
  }

  const host = await createFileHost({ rootDir });

  // Register invokers. V0 ships with the auditor (read-only, always
  // safe). Deployments with additional sub-actors fork this script
  // and append registrations; registration is instance policy, not
  // framework mechanism.
  const registry = new SubActorRegistry();
  registry.register('auditor-actor', async (payload, corr) => runAuditor(host, payload, corr));

  const startedAt = new Date().toISOString();
  console.log(`[approval-cycle] started at ${startedAt} root=${rootDir} principal=${args.principalId}`);

  // Track whether any tick threw; non-zero exit on the first throw
  // preserves "exit 0 iff clean". We STILL try each tick so a failure
  // in, say, auto-approve does not silently skip consensus. The
  // collected error is re-thrown at the end.
  /** @type {Error|null} */
  let firstError = null;

  // 1. Single-principal allowlist path.
  try {
    const r = await runAutoApprovePass(host);
    console.log(`[approval-cycle] auto-approve       scanned=${r.scanned} approved=${r.approved}`);
  } catch (err) {
    console.error(`[approval-cycle] auto-approve FAILED: ${err?.message ?? err}`);
    firstError = firstError ?? err;
  }

  // 2. Distinct-principal consensus path.
  try {
    const r = await runPlanApprovalTick(host);
    console.log(
      '[approval-cycle] plan-approval      '
      + `scanned=${r.scanned} eligible=${r.eligible} approved=${r.approved} rejected=${r.rejected} stale=${r.stale}`,
    );
  } catch (err) {
    console.error(`[approval-cycle] plan-approval FAILED: ${err?.message ?? err}`);
    firstError = firstError ?? err;
  }

  // 3. PR-merge writeback (executing|approved -> succeeded|abandoned).
  try {
    const r = await runPlanStateReconcileTick(host);
    console.log(
      '[approval-cycle] plan-reconcile     '
      + `scanned=${r.scanned} matched=${r.matched} transitioned=${r.transitioned} claimConflicts=${r.claimConflicts}`,
    );
  } catch (err) {
    console.error(`[approval-cycle] plan-reconcile FAILED: ${err?.message ?? err}`);
    firstError = firstError ?? err;
  }

  // 4. Dispatch approved plans.
  try {
    const r = await runDispatchTick(host, registry);
    console.log(
      '[approval-cycle] dispatch           '
      + `scanned=${r.scanned} dispatched=${r.dispatched} failed=${r.failed}`,
    );
  } catch (err) {
    console.error(`[approval-cycle] dispatch FAILED: ${err?.message ?? err}`);
    firstError = firstError ?? err;
  }

  const endedAt = new Date().toISOString();
  console.log(`[approval-cycle] finished at ${endedAt} (once=${args.once ? 'true' : 'false'})`);
  if (firstError !== null) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[approval-cycle] FAILED: ${err?.message ?? err}`);
  console.error(err?.stack ?? '');
  process.exit(1);
});
