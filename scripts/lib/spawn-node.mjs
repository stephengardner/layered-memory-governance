/**
 * spawn-node: shared helper for spawning child node processes that must
 * inherit the current process's node interpreter rather than whatever
 * `node` resolves to via PATH.
 *
 * Why: bare `node` in PATH on nvm-managed hosts can resolve to an older
 * shim (e.g. nvm-windows v12 fallback) that fails to parse modern ES
 * features (optional-chaining, nullish-coalescing, top-level-await) the
 * spawned scripts use. Pinning `process.execPath` keeps the spawned
 * child on the same major as the dispatcher.
 *
 * Surface: a single `spawnNode(args, options)` thin wrapper around
 * `execa` that forwards arguments and options unchanged, pinning the
 * binary to `process.execPath`. Returns the execa Promise so callers
 * can `await` it and propagate timeouts, exit codes, and stderr the
 * same way they would for any other execa call.
 *
 * Validation: `validateSpawnNodeArgs` is exported as a pure helper so
 * unit tests can pin the contract without spawning a subprocess. The
 * args contract is "non-empty array of strings", matching what
 * `child_process.spawn` accepts; non-array or empty input is the kind
 * of bug a caller should hear about loudly rather than silently
 * spawn-with-no-arguments.
 *
 * Substrate posture: this module lives in `scripts/lib/` (deployment
 * shell, NOT framework) per the substrate-not-prescription canon.
 * Framework code under `src/` continues to know nothing about
 * deployment-side spawn ergonomics.
 *
 * Extracted at N=3 per dev-no-code-duplication-extract-at-2 after
 * the same `execa(process.execPath, ...)` block landed in
 * scripts/invokers/autonomous-dispatch.mjs (twice),
 * scripts/intend.mjs, and scripts/lib/pr-observation-refresher.mjs.
 */

import { execa } from 'execa';

/**
 * Loud validation guard. Returns true on success; throws Error with a
 * descriptive message on any malformed input. Exported so unit tests
 * can pin the contract without spawning a subprocess.
 *
 * @param {unknown} args
 * @returns {true}
 */
export function validateSpawnNodeArgs(args) {
  if (!Array.isArray(args)) {
    throw new Error(`spawnNode: args must be an array (got ${args === null ? 'null' : typeof args})`);
  }
  if (args.length === 0) {
    throw new Error('spawnNode: args must be a non-empty array; first entry should be the script path');
  }
  for (let i = 0; i < args.length; i += 1) {
    if (typeof args[i] !== 'string') {
      throw new Error(`spawnNode: args[${i}] must be a string (got ${typeof args[i]})`);
    }
  }
  return true;
}

/**
 * Spawn a child node process pinned to the current interpreter
 * (`process.execPath`).
 *
 * Equivalent to `execa(process.execPath, args, options)` but
 * centralized so flag, cwd, and rationale comments stay in one place.
 *
 * @param {readonly string[]} args
 *   Argv passed to the spawned node. First entry is conventionally
 *   the script path; subsequent entries are the script's own argv.
 * @param {import('execa').Options} [options]
 *   Forwarded to execa unchanged. Common shapes from current call
 *   sites: `{ stdio: 'inherit' }`, `{ stdio: 'inherit', cwd }`,
 *   `{ stdio: 'inherit', cwd, timeout }`.
 * @returns {ReturnType<typeof execa>}
 *   The execa Promise. Awaiting yields the result; rejection carries
 *   the underlying ExecaError (stderr, exit code, signal).
 */
export function spawnNode(args, options) {
  validateSpawnNodeArgs(args);
  return execa(process.execPath, args, options);
}
