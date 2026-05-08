#!/usr/bin/env node
/**
 * intend: CLI for the operator to declare autonomous-solve intent.
 * Writes an operator-intent atom through the file-backed host;
 * optionally seeds a question + invokes CTO via --trigger.
 *
 * Zero imports from src/. Uses dist/adapters/file.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createFileHost } from '../dist/adapters/file/index.js';
import { parseIntendArgs, computeExpiresAt, buildIntentAtom, buildCtoSpawnArgs, shellQuote } from './lib/intend.mjs';
import { spawnNode } from './lib/spawn-node.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

async function main() {
  const parsed = parseIntendArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[intend] ${parsed.reason}`);
    console.error('usage: node scripts/intend.mjs --request "<text>" --scope <tooling|docs|framework|canon> --blast-radius <none|docs|tooling|framework|l3-canon-proposal> --sub-actors <code-author[,auditor-actor]> [--min-confidence 0.75] [--expires-in 24h] [--dry-run] [--trigger]');
    process.exit(2);
  }
  const args = parsed.args;
  if (existsSync(resolve(STATE_DIR, 'STOP'))) {
    console.error('[intend] .lag/STOP present; kill-switch is armed. Remove it to proceed.');
    process.exit(3);
  }
  const operatorPrincipalId = process.env.LAG_OPERATOR_ID;
  if (!operatorPrincipalId) {
    console.error('[intend] LAG_OPERATOR_ID is not set. Export the operator principal id first.');
    process.exit(2);
  }
  const now = new Date();
  const expiresAt = computeExpiresAt(args.expiresIn, now);
  const nonce = randomBytes(6).toString('hex');
  const atom = buildIntentAtom({
    request: args.request,
    scope: args.scope,
    blastRadius: args.blastRadius,
    subActors: args.subActors,
    minConfidence: args.minConfidence,
    expiresAt,
    operatorPrincipalId,
    now,
    nonce,
  });

  if (args.dryRun) {
    console.log('[intend] --dry-run; would write:');
    console.log(JSON.stringify(atom, null, 2));
    process.exit(0);
  }

  // Auto-build dist BEFORE writing the intent atom so a stale-dist
  // failure mode cannot produce an orphan intent. CTO + every pipeline
  // stage adapter loads framework + adapter code via dist/ at runtime
  // (per the package exports + subpath imports map). A trigger that
  // spawns CTO against stale dist runs by-N-commits-old code; the
  // 2026-05-08 dogfeed surfaced this when a schema fix landed in src/
  // but dist/ still held the old shape, and the live system failed
  // validation against rules that were already fixed in source.
  //
  // Gated on args.trigger because a no-trigger invocation only writes
  // the intent atom (a write-and-walk-away path that does not load
  // dist/) and rebuilding would be wasted work.
  //
  // Escape hatch: `LAG_INTEND_SKIP_BUILD=1` disables this for fast
  // operator-side iteration when dist is known current. The default is
  // fail-loud-on-build-failure: a typecheck or build error halts the
  // trigger before any atom is written, so a syntax error in src/ does
  // not produce an orphan intent.
  if (args.trigger && process.env.LAG_INTEND_SKIP_BUILD !== '1') {
    console.log('[intend] rebuilding dist before trigger (set LAG_INTEND_SKIP_BUILD=1 to skip)');
    // Pass BOTH tsconfigs explicitly so a stale `dist/` from a src/
    // change AND a stale `dist/examples/` from an adapter change both
    // refresh in one tsc invocation. tsc handles incremental builds
    // (.tsbuildinfo files) so an up-to-date project is a no-op.
    //
    // Why both: tsconfig.json compiles `src/` -> `dist/` (framework);
    // tsconfig.examples.json compiles `examples/` -> `dist/examples/`
    // (planning-stage adapters + skill bundles). The pipeline loads
    // from BOTH at runtime (per package exports + the `#runtime/...`
    // subpath imports map). A single tsconfig leaves the other half
    // stale.
    const buildResult = await spawnNode(
      [
        resolve(REPO_ROOT, 'node_modules/typescript/bin/tsc'),
        '-b',
        resolve(REPO_ROOT, 'tsconfig.json'),
        resolve(REPO_ROOT, 'tsconfig.examples.json'),
      ],
      { stdio: 'inherit', reject: false },
    );
    if (buildResult.failed) {
      const buildCode = buildResult.exitCode ?? 1;
      console.error(`[intend] dist rebuild failed (code=${buildResult.exitCode ?? 'signal'} signal=${buildResult.signal ?? 'none'}); intent NOT written, trigger aborted.`);
      process.exit(buildCode);
    }
    console.log('[intend] dist rebuild succeeded');
  }

  const host = await createFileHost({ rootDir: STATE_DIR });
  await host.atoms.put(atom);
  console.log(`[intend] wrote ${atom.id} (expires ${expiresAt})`);

  // Operator override of --invokers wins; otherwise default to the
  // canonical autonomous-dispatch registrar. The operator's intent
  // declares allowed_sub_actors (which always includes code-author
  // for autonomous-solve), so the run-cto-actor child must register
  // that sub-actor on its SubActorRegistry or the dispatch-stage will
  // fail-loud at the end of the deep pipeline with "principal
  // code-author is not registered". Without a default the operator
  // would have to remember the flag on every trigger, and the indie-
  // floor "just run intend.mjs --trigger and it works" story falls
  // over. The canonical invokers module is the same one
  // run-approval-cycle.mjs uses, so the intent-trigger path and the
  // daemon path share one wiring path. Deployments override via
  // `intend.mjs --invokers <path>`; this is the pluggable seam, not a
  // hardcoded coupling.
  const defaultInvokersPath = resolve(REPO_ROOT, 'scripts/invokers/autonomous-dispatch.mjs');
  const invokersPath = args.invokersPath !== null
    ? resolve(args.invokersPath)
    : defaultInvokersPath;
  const runCtoActorPath = resolve(REPO_ROOT, 'scripts/run-cto-actor.mjs');
  // Pipeline-mode override: indie-floor default is single-pass per
  // dec-default-pipeline-mode-single-pass, so a zero-env `intend
  // --trigger` runs single-pass through CTO. Deployments that want
  // every trigger to flow through the 5-stage substrate-deep pipeline
  // export `LAG_PIPELINE_MODE=substrate-deep` in their environment;
  // operators reading this can flip the dial back to single-pass for a
  // one-shot by `LAG_PIPELINE_MODE= node scripts/intend.mjs --trigger`.
  // The flag passes through to run-cto-actor verbatim; an unsupported
  // value fails-loud at buildCtoSpawnArgs rather than silently falling
  // back, so a typo (`subastrate-deep`) surfaces at the boundary.
  const pipelineMode = process.env.LAG_PIPELINE_MODE;
  const ctoSpawnArgs = buildCtoSpawnArgs({
    runCtoActorPath,
    request: args.request,
    atomId: atom.id,
    invokersPath,
    ...(pipelineMode ? { mode: pipelineMode } : {}),
  });

  if (args.trigger) {
    console.log(`[intend] triggering CTO with intent id: ${atom.id}`);
    // Spawn through scripts/lib/spawn-node.mjs so the CTO child
    // inherits this script's node version. Bare `node` resolves to
    // whatever the shell PATH points at, which on nvm-managed hosts
    // can be an older version that fails to parse the modern ES
    // features the spawned scripts use.
    const result = await spawnNode(ctoSpawnArgs, { stdio: 'inherit', reject: false });
    // result.failed is the discriminator, NOT exitCode. In execa v9
    // a signal-killed (SIGKILL/SIGTERM) child or a spawn-time error
    // (e.g. ENOENT for a missing scripts/run-cto-actor.mjs) leaves
    // exitCode === undefined; an `exitCode ?? 0` fallback would
    // silently treat those failures as success and intend would
    // exit clean while the intent atom sits orphaned without ever
    // having engaged the CTO. Surface the signal too so a SIGKILL
    // is distinguishable from a clean non-zero exit in operator
    // logs.
    if (result.failed) {
      const childCode = result.exitCode ?? 1;
      console.error(`[intend] run-cto-actor failed (code=${result.exitCode ?? 'signal'} signal=${result.signal ?? 'none'}); intent ${atom.id} was written but CTO did not complete cleanly.`);
      process.exit(childCode);
    }
  } else {
    // Render the same argv the trigger path would have spawned so a
    // manual re-run matches byte-for-byte (including --invokers).
    // process.execPath pins to this script's interpreter; bare `node`
    // would reintroduce the PATH/shim mismatch on nvm-managed hosts.
    // shellQuote wraps tokens that contain shell-special characters
    // ($, backticks, backslashes, embedded quotes) so the printed
    // command is paste-safe for arbitrary intent text.
    const flagsEcho = ctoSpawnArgs.slice(1).map(shellQuote).join(' ');
    console.log(`[intend] no --trigger; invoke manually:\n  ${shellQuote(process.execPath)} ${shellQuote(runCtoActorPath)} ${flagsEcho}`);
  }
}

main().catch((err) => {
  console.error(`[intend] ${err.message}`);
  process.exit(1);
});
