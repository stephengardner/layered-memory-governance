#!/usr/bin/env node
/**
 * Approval-cycle daemon: the canonical "move plans forward" runner.
 *
 * One pass, in fixed order, over the five ticks that advance a plan
 * from proposed to succeeded:
 *
 *   0. runIntentAutoApprovePass   proposed -> approved
 *                                  for intent-backed single-principal path
 *                                  (most-specific gate, runs first).
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
 * Dispatch requires a SubActorRegistry populated with invokers. This
 * script always registers `auditor-actor` (read-only, always safe to
 * invoke). Deployments with additional sub-actors (e.g. `code-author`,
 * which is on the multi-reviewer allowlist by default) pass
 * `--invokers <path-to.mjs>` pointing at a module whose default export
 * is `async (host, registry) => void` and registers the invokers.
 * Instance-specific registration lives outside the runner; the runner
 * stays canonical.
 *
 * Forgetting the seam is not silent: `runDispatchTick` will see the
 * unregistered sub-actor, throw from `SubActorRegistry.invoke`, and
 * transition the plan to `failed` with an operator-escalation atom.
 * That's a loud failure mode, not a hidden one, so the operator can
 * see the missing registration in their audit log and add it.
 *
 * Usage:
 *   node scripts/run-approval-cycle.mjs --root-dir .lag
 *   node scripts/run-approval-cycle.mjs --root-dir .lag --invokers ./invokers.mjs
 *   node scripts/run-approval-cycle.mjs --root-dir .lag --principal-id operator
 *
 * `--root-dir` is required (avoid defaulting to a repo-shaped path
 * that could surprise an operator running from a different cwd).
 * `--principal-id` is optional and is printed on the startup log for
 * deployment-level telemetry only; the ticks themselves attribute
 * audit events to the plan/observation principal, so a runner-level
 * principal would not be consumed.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createFileHost } from '../dist/adapters/file/index.js';
import { ClaudeCliLLM } from '../dist/adapters/claude-cli/index.js';
import {
  SubActorRegistry,
  runAuditor,
  runAutoApprovePass,
  runDispatchTick,
  runIntentAutoApprovePass,
  runPlanApprovalTick,
} from '../dist/actor-message/index.js';
import { runPlanStateReconcileTick } from '../dist/runtime/plans/pr-merge-reconcile.js';
import {
  LLM_REQUIRING_SUB_ACTORS,
  checkLlmCompatibility,
} from './lib/approval-cycle-gate.mjs';

const SUPPORTED_LLMS = new Set(['claude-cli', 'memory']);

function parseArgs(argv) {
  const args = {
    rootDir: null,
    principalId: null,
    invokersPath: null,
    llm: 'claude-cli',
    once: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root-dir' && i + 1 < argv.length) args.rootDir = argv[++i];
    else if (a === '--principal-id' && i + 1 < argv.length) args.principalId = argv[++i];
    else if (a === '--invokers' && i + 1 < argv.length) args.invokersPath = argv[++i];
    else if (a === '--llm' && i + 1 < argv.length) args.llm = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: node scripts/run-approval-cycle.mjs --root-dir <path> [--principal-id <id>] [--invokers <path>] [--llm <adapter>] [--once]',
        '',
        'Runs one pass of the approval cycle, in order:',
        '  0. runIntentAutoApprovePass    (intent-backed single-principal)',
        '  1. runAutoApprovePass          (single-principal allowlist)',
        '  2. runPlanApprovalTick         (distinct-principal consensus)',
        '  3. runPlanStateReconcileTick   (pr-merge writeback)',
        '  4. runDispatchTick             (approved -> executing)',
        '',
        'Options:',
        '  --root-dir <path>      Required. The LAG state dir (e.g. .lag).',
        '  --principal-id <id>    Optional. Printed on the startup log for',
        '                         deployment-level telemetry; not consumed by',
        '                         the ticks (each tick attributes audit events',
        '                         to the plan/observation principal).',
        '  --invokers <path>      Optional. Path to an .mjs module whose default',
        '                         export is `async (host, registry) => void`.',
        '                         Called after the built-in auditor registration;',
        '                         register deployment-specific sub-actor invokers',
        '                         there (e.g. code-author) so this canonical',
        '                         runner does not need to be forked. Without the',
        '                         seam, plans that delegate to an unregistered',
        '                         sub-actor will be marked failed by',
        '                         runDispatchTick.',
        "  --llm <adapter>        Optional. Which LLM adapter to wire onto the",
        "                         host. 'claude-cli' (default) reuses the user's",
        "                         existing Claude Code OAuth (no API key needed)",
        "                         and is what dispatched sub-actors with their",
        "                         own LLM-backed steps -- e.g. code-author's",
        "                         drafter -- need to function. 'memory' wires",
        "                         the deterministic stub used by unit tests; the",
        "                         daemon refuses to start if 'memory' is selected",
        "                         AND the registry contains a sub-actor that",
        "                         requires a real LLM (today: code-author).",
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
  if (!SUPPORTED_LLMS.has(args.llm)) {
    console.error(`ERROR: --llm must be one of [${Array.from(SUPPORTED_LLMS).join(', ')}]; got '${args.llm}'.`);
    process.exit(2);
  }
  // --principal-id is intentionally optional: the ticks read principal
  // ids off the plan / observation atoms themselves (see
  // src/runtime/actor-message/plan-approval.ts + plan-dispatch.ts),
  // so a runner-level principal is telemetry, not authorization.
  // Requiring it here would be UX friction with no governance payoff
  // (bootstrap owns operator-provenance verification).
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = resolve(args.rootDir);
  if (!existsSync(rootDir)) {
    console.error(`ERROR: --root-dir ${rootDir} does not exist.`);
    process.exit(2);
  }

  // LLM seam: dispatched sub-actors that have their own LLM-backed
  // step (e.g. code-author's drafter calls `host.llm.judge`) need a
  // real adapter on the host. The default 'claude-cli' path reuses
  // the user's existing Claude Code OAuth -- zero-config for an
  // indie developer; a deployment that wants a different adapter
  // forks this script (the seam is the param, not the constructor).
  // 'memory' is the test stub; selecting it on a daemon that will
  // dispatch code-author would crash the drafter at runtime, so we
  // gate on the registered set after invokers load (below).
  // Deployment-side posture for the autonomous flow:
  //   - 60-minute spawn timeout: dispatched drafters routinely produce
  //     multi-file diffs that exceed the framework's conservative
  //     3-minute floor. Per-invocation options.timeout_ms still wins.
  //   - max effort: tell Claude CLI to allocate maximum reasoning depth.
  //     Combined with the drafter's `framingMode: 'code-author'` and the
  //     Opus default model in scripts/invokers/autonomous-dispatch.mjs,
  //     this gives the drafter the budget headroom to emit a complete
  //     diff after extended thinking instead of burning the entire
  //     output ceiling on deliberation. Per-invocation options.effort
  //     still wins.
  // NOTE: This posture is local to this runner. Other ClaudeCliLLM
  // construction sites (e.g. the bridge adapter, virtual-org examples)
  // pass through caller-supplied claudeCli opts and do NOT inherit
  // these defaults; deployments that fork into a custom runner must
  // re-establish the timeout + effort posture explicitly or accept
  // the framework's conservative floors.
  const INSTANCE_LLM_DEFAULT_TIMEOUT_MS = 3_600_000;
  const INSTANCE_LLM_DEFAULT_EFFORT = 'max';
  const llm = args.llm === 'claude-cli'
    ? new ClaudeCliLLM({
        defaultTimeoutMs: INSTANCE_LLM_DEFAULT_TIMEOUT_MS,
        defaultEffort: INSTANCE_LLM_DEFAULT_EFFORT,
      })
    : undefined;
  const host = await createFileHost({ rootDir, llm });

  // Register invokers. V0 ships with the auditor (read-only, always
  // safe). Deployments with additional sub-actors pass --invokers
  // pointing at an .mjs module that adds registrations; registration
  // is instance policy, not framework mechanism. This seam means the
  // canonical runner does not need to be forked to ship code-author,
  // custom sub-actors, etc.
  const registry = new SubActorRegistry();
  registry.register('auditor-actor', async (payload, corr) => runAuditor(host, payload, corr));

  if (args.invokersPath !== null) {
    const modPath = resolve(args.invokersPath);
    if (!existsSync(modPath)) {
      console.error(`ERROR: --invokers ${modPath} does not exist.`);
      process.exit(2);
    }
    // Windows-safe: convert absolute fs path to file:// URL before
    // import() so dynamic import does not misinterpret a `C:` drive
    // letter as a URL scheme.
    const mod = await import(new URL(`file:///${modPath.replace(/\\/g, '/')}`).href);
    if (typeof mod.default !== 'function') {
      console.error(
        `ERROR: --invokers module must default-export `
        + `\`async (host, registry) => void\` (got ${typeof mod.default}).`,
      );
      process.exit(2);
    }
    await mod.default(host, registry);
  }

  // Loud-fail when the operator opts into the test stub but the
  // registry contains a sub-actor whose drafter / judgment step
  // calls host.llm. Fail at startup with an actionable hint rather
  // than at dispatch-time with a cryptic "MemoryLLM has no
  // registered response for key <hash>" thrown deep inside the
  // executor chain. Gate logic + sub-actor list live in
  // scripts/lib/approval-cycle-gate.mjs so the test suite can
  // exercise the decision without spawning the CLI.
  const registeredIds = LLM_REQUIRING_SUB_ACTORS.filter((id) => registry.has(id));
  const incompat = checkLlmCompatibility({ llm: args.llm, registeredIds });
  if (incompat !== null) {
    console.error(`ERROR: ${incompat.message}`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const principalTag = args.principalId === null ? 'unset' : args.principalId;
  console.log(`[approval-cycle] started at ${startedAt} root=${rootDir} principal=${principalTag} llm=${args.llm}`);

  // Track whether any tick threw; non-zero exit on the first throw
  // preserves "exit 0 iff clean". We STILL try each tick so a failure
  // in, say, auto-approve does not silently skip consensus. The
  // collected error is re-thrown at the end.
  /** @type {Error|null} */
  let firstError = null;

  // 0. Intent-backed single-principal path (most-specific gate, runs first).
  try {
    const intentResult = await runIntentAutoApprovePass(host);
    console.log(`[approval-cycle] intent-approve     scanned=${intentResult.scanned} approved=${intentResult.approved} rejected=${intentResult.rejected ?? 0}${intentResult.halted ? ' [HALTED by kill-switch]' : ''}`);
    if (intentResult.halted) return;
  } catch (err) {
    console.error(`[approval-cycle] intent-approve FAILED: ${err?.message ?? err}`);
    firstError = firstError ?? err;
  }

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
