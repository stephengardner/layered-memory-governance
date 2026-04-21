#!/usr/bin/env node
/**
 * bootstrap-all-canon: run every bootstrap-*-canon script idempotently.
 *
 * Existence rationale: canon atoms declared in `bootstrap-*.mjs` scripts
 * are only live in the operator's `.lag/` atom store when someone runs
 * the script. Session 2026-04-21 surfaced this concretely: a new atom
 * (`arch-pr-state-observation-via-actor-only`) was edited into
 * `bootstrap-decisions-canon.mjs`, the edit landed on main, but the
 * script was never executed — so the CTO actor's next planning run
 * correctly flagged the cited canon as absent from its data.
 *
 * This wrapper runs every bootstrap script as a subprocess, in a
 * deterministic order, passing through LAG_OPERATOR_ID. Each script is
 * idempotent-per-atom-id by design (drift detection fails loud on a
 * mutated store, no-ops when no change). The combined cost is ~1s on
 * a cold run, ~50ms when all atoms match.
 *
 * Invoked two ways:
 *   - Directly: `node scripts/bootstrap-all-canon.mjs` (operator /
 *     CI ad-hoc)
 *   - Via `.claude/hooks/seed-canon-on-session.mjs` on the first tool
 *     use per Claude Code session. The hook writes a guard file in
 *     `.lag/session-seeds/<session-id>.done` so repeat prompts do not
 *     re-run.
 *
 * Fail-fast: if LAG_OPERATOR_ID is missing the wrapper surfaces the
 * same error the downstream scripts would, once, at the entry point.
 * If a single script fails (drift, permission error, etc.), exit with
 * its status code so CI or the hook flags the failure loudly.
 *
 * Order note: `bootstrap-operator-directives.mjs` runs last because it
 * layers operator-directive atoms on top of the foundational canon.
 * Other scripts are independent of each other today; alphabetical
 * matches the intended precedence closely enough, with the directives
 * tail-call pinned explicitly.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

if (!process.env.LAG_OPERATOR_ID) {
  console.error(
    '[bootstrap-all] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-principal-id>\n'
    + '  (the downstream bootstrap scripts need this to sign atoms with the operator principal)',
  );
  process.exit(2);
}

const order = (() => {
  const all = readdirSync(SCRIPTS_DIR)
    .filter((f) => /^bootstrap-.*-canon\.mjs$|^bootstrap-operator-directives\.mjs$/.test(f))
    .filter((f) => f !== 'bootstrap-all-canon.mjs')
    .sort();
  // Operator-directives tail-call: it layers on top of everything else
  // and is the most likely to change between sessions.
  const rest = all.filter((f) => f !== 'bootstrap-operator-directives.mjs');
  const tail = all.filter((f) => f === 'bootstrap-operator-directives.mjs');
  return [...rest, ...tail];
})();

console.log(`[bootstrap-all] running ${order.length} bootstrap scripts in sequence`);

// Per-child timeout. Each bootstrap script is a handful of atom
// writes; cold wall time is ~300ms-1s per script. 20s per child is
// >> observed and still fails loud rather than hanging forever if a
// script gets wedged (e.g., blocked on a broken lock file). spawnSync
// on timeout: result.error = { code: 'ETIMEDOUT' }, result.signal set,
// result.status null - we handle that branch explicitly.
const PER_SCRIPT_TIMEOUT_MS = 20_000;

let started = Date.now();
for (const script of order) {
  const scriptPath = resolve(SCRIPTS_DIR, script);
  const t0 = Date.now();
  // stdio: 'inherit' so each script's own logs surface in sequence.
  // Each script is idempotent so repeat runs are safe; the signal
  // we want is "did drift surface?" which the downstream scripts
  // handle themselves (non-zero exit on drift).
  const result = spawnSync('node', [scriptPath], {
    stdio: 'inherit',
    env: process.env,
    timeout: PER_SCRIPT_TIMEOUT_MS,
  });
  const elapsed = Date.now() - t0;
  if (result.error) {
    if (result.error?.code === 'ETIMEDOUT') {
      console.error(
        `[bootstrap-all] ${script} timed out after ${PER_SCRIPT_TIMEOUT_MS}ms (signal=${result.signal ?? '?'})`,
      );
    } else {
      console.error(`[bootstrap-all] ERROR spawning ${script}: ${result.error.message}`);
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[bootstrap-all] ${script} exited with status ${result.status} after ${elapsed}ms`);
    process.exit(result.status ?? 1);
  }
  console.log(`[bootstrap-all] ${script} completed in ${elapsed}ms`);
}

const total = Date.now() - started;
console.log(`[bootstrap-all] all ${order.length} scripts completed in ${total}ms`);
