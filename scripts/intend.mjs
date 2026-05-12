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
import {
  parseIntendArgs,
  computeExpiresAt,
  buildIntentAtom,
  buildCtoSpawnArgs,
  resolvePipelineMode,
  shellQuote,
} from './lib/intend.mjs';
import { spawnNode } from './lib/spawn-node.mjs';

/**
 * Documented indie-floor default reached when env LAG_PIPELINE_MODE is
 * unset AND no canon pol-planning-pipeline-default-mode atom resolves.
 * `substrate-deep` is the operator-stated default for this deployment;
 * a deployment that prefers single-pass writes the canon policy atom
 * (the framework bootstrap seeds it), so the fallback only fires on
 * deployments that have not bootstrapped pipeline canon at all.
 */
const FALLBACK_PIPELINE_MODE = 'substrate-deep';

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
  // Pipeline-mode resolution: substrate-pure source ladder per the
  // operator's standing "default-correct without env-var workaround"
  // directive. Three rungs, in priority order:
  //
  //   1. LAG_PIPELINE_MODE env override -- one-shot operator escape
  //      hatch. A typo (`subastrate-deep`) is rejected loudly so an
  //      invalid env value never silently falls back to canon and
  //      erases the operator's intent.
  //   2. Canon pol-planning-pipeline-default-mode atom -- deployment's
  //      stated default via `readPipelineDefaultModePolicy`. An
  //      org-ceiling deployment that wants substrate-deep on every
  //      trigger writes the canon atom; a solo developer who wants
  //      single-pass writes the inverse atom.
  //   3. Fallback FALLBACK_PIPELINE_MODE -- documented indie-floor
  //      default when env is unset AND no canon atom resolves (fresh
  //      checkout, bootstrap not run yet). The substrate-deep default
  //      keeps the brainstorm/spec/plan/review/dispatch audit chain
  //      load-bearing for new deployments that have not flipped the
  //      dial yet.
  //
  // The resolved mode is ALWAYS appended to argv so operator-action
  // audit-trails surface the value rather than relying on
  // run-cto-actor's downstream default; an explicit visible mode
  // beats an implicit hidden default.
  let canonMode = null;
  try {
    const { readPipelineDefaultModePolicy } = await import('../dist/runtime/planning-pipeline/policy.js');
    const policy = await readPipelineDefaultModePolicy(host);
    // atomId === null signals "reader fell through to its built-in
    // default", not "canon explicitly stated this mode". Only treat
    // the result as canon-resolved when atomId is a string; this
    // preserves the env-override -> canon -> fallback rung priority
    // for fresh deployments that have not bootstrapped pipeline canon.
    if (typeof policy?.atomId === 'string' && policy.atomId.length > 0) {
      canonMode = policy.mode ?? null;
    }
  } catch (err) {
    // A dist/ that has not been built yet (LAG_INTEND_SKIP_BUILD=1 on
    // a fresh checkout, or this script running before `npm run build`)
    // would leave the canon reader unimportable. Surface as a warning
    // and fall through to the env/fallback rungs rather than aborting
    // a trigger -- the operator's env override may still be present.
    console.error(`[intend] WARNING: could not read canon pipeline mode policy: ${err?.message ?? err}; falling through to env + fallback.`);
    canonMode = null;
  }
  const resolved = resolvePipelineMode({
    env: process.env.LAG_PIPELINE_MODE,
    canon: canonMode,
    fallback: FALLBACK_PIPELINE_MODE,
  });
  console.log(`[intend] pipeline mode: ${resolved.mode} (source=${resolved.source})`);
  const ctoSpawnArgs = buildCtoSpawnArgs({
    runCtoActorPath,
    request: args.request,
    atomId: atom.id,
    invokersPath,
    mode: resolved.mode,
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
