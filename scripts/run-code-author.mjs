#!/usr/bin/env node
/**
 * The code-author Actor driver.
 *
 * Boots the CodeAuthorActor with a real FileHost, the code-author
 * principal, and the framework-standard runActor driver. This
 * revision is inert by design: the actor loads + validates the
 * four `pol-code-author-*` fence atoms, reports the fence state,
 * and halts. It closes the last graduation gate from the fence
 * ADR (the fence atoms now have a live consumer) without yet
 * shipping a code-generation loop behind them.
 *
 * Safety rails already in place through the fence atoms:
 *   - Fence load is fail-closed on presence, taint, and
 *     supersession. The actor halts rather than running under
 *     a broken fence.
 *   - `.lag/STOP` is honoured through runActor's kill switch.
 *   - Budget defaults to 1 iteration, 30s deadline: a fence-only
 *     skeleton should never need more.
 *
 * Usage:
 *   node scripts/run-code-author.mjs
 *   node scripts/run-code-author.mjs --max-iterations 1
 *   node scripts/run-code-author.mjs --preflight-only
 *
 * The script does NOT consume an operator env var. Principal
 * provenance is rooted at the code-author principal stored in
 * `.lag/principals/code-author.json` (created by the bootstrap,
 * which does enforce LAG_OPERATOR_ID); the runner's responsibility
 * is loading that already-rooted principal and starting the loop.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createFileHost } from '../dist/adapters/file/index.js';
import { runActor } from '../dist/runtime/actors/index.js';
import {
  CodeAuthorActor,
  loadCodeAuthorFence,
  CodeAuthorFenceError,
} from '../dist/runtime/actors/code-author/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const CODE_AUTHOR_ID = 'code-author';

function parseArgs(argv) {
  const args = {
    maxIterations: 1,
    deadlineMs: 30_000,
    preflightOnly: false,
  };
  const parsePositiveInt = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`ERROR: ${flag} expects a positive integer, got "${raw}".`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-iterations') args.maxIterations = parsePositiveInt(argv[++i], '--max-iterations');
    else if (a === '--deadline-ms') args.deadlineMs = parsePositiveInt(argv[++i], '--deadline-ms');
    else if (a === '--preflight-only') args.preflightOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-code-author.mjs [options]\n'
        + '  --preflight-only    load + validate fence; skip runActor (CI smoke mode).\n'
        + '  --max-iterations N  default 1 (actor halts on first iteration in this revision).\n'
        + '  --deadline-ms N     default 30000.',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = await createFileHost({ rootDir: STATE_DIR });

  const principal = await host.principals.get(CODE_AUTHOR_ID);
  if (!principal) {
    console.error(
      `[run-code-author] ERROR: principal '${CODE_AUTHOR_ID}' not found in ${STATE_DIR}.\n`
      + '  Run: LAG_OPERATOR_ID=<id> node scripts/bootstrap-code-author-canon.mjs',
    );
    process.exit(1);
  }

  // Preflight: surface the fence state before runActor is even invoked.
  // A preflight failure is the same fail-closed signal the actor would
  // produce inside observe, but caught at the runner boundary so CI and
  // smoke-test scripts get a precise exit code instead of an actor halt
  // with a stacktrace in the audit log.
  let fence;
  try {
    fence = await loadCodeAuthorFence(host.atoms);
  } catch (err) {
    if (err instanceof CodeAuthorFenceError) {
      console.error(`[run-code-author] ABORT: ${err.message}`);
    } else {
      // err may be a non-Error rejection (string, {code}, etc). Prefer
      // stack when present and fall back to String(err) so a plain
      // object never surfaces as "[object Object]" in the log.
      console.error(`[run-code-author] ABORT: unexpected fence-load error: ${err instanceof Error ? err.stack : String(err)}`);
    }
    process.exit(1);
  }

  console.log(`[run-code-author] fence loaded. principal=${principal.id} signed_by=${principal.signed_by}`);
  console.log(`[run-code-author]   per-pr cost cap: $${fence.perPrCostCap.max_usd_per_pr} (include_retries=${fence.perPrCostCap.include_retries})`);
  console.log(`[run-code-author]   ci required checks: ${fence.ciGate.required_checks.join(', ')} (require_all=${fence.ciGate.require_all}, max_age=${fence.ciGate.max_check_age_ms}ms)`);
  console.log(`[run-code-author]   signed-pr-only: require_app_identity=${fence.signedPrOnly.require_app_identity}, direct_writes=${fence.signedPrOnly.allowed_direct_write_paths.length === 0 ? 'none' : fence.signedPrOnly.allowed_direct_write_paths.join(',')}`);
  console.log(`[run-code-author]   revocation on stop: ${fence.writeRevocationOnStop.on_stop_action} (draft_layer=${fence.writeRevocationOnStop.draft_atoms_layer}, atom_type=${fence.writeRevocationOnStop.revocation_atom_type})`);
  if (fence.warnings.length > 0) {
    console.warn(`[run-code-author] fence warnings (${fence.warnings.length}):`);
    for (const w of fence.warnings) console.warn(`  - ${w}`);
  }

  if (args.preflightOnly) {
    console.log('[run-code-author] preflight ok; --preflight-only set, skipping runActor.');
    return;
  }

  const actor = new CodeAuthorActor();
  const result = await runActor(actor, {
    host,
    principal,
    adapters: {},
    budget: {
      maxIterations: args.maxIterations,
      deadlineMs: args.deadlineMs,
    },
    origin: 'scheduled',
    // Millisecond-only session ids collide under coarse clocks, fixed
    // test clocks, or rapid re-invocation. 6-hex nonce matches the
    // mkKillSwitchTrippedAtomId discipline shipped in #72; future
    // parallel-runner revisions inherit uniqueness for free.
    killSwitchSessionId: `run-code-author-${Date.now()}-${randomBytes(3).toString('hex')}`,
  });

  console.log(`[run-code-author] halted: ${result.haltReason} after ${result.iterations} iteration(s)`);
}

main().catch((err) => {
  console.error('[run-code-author] FAILED:', err?.stack ?? err);
  process.exit(1);
});
