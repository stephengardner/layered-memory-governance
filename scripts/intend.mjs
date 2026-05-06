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
import { parseIntendArgs, computeExpiresAt, buildIntentAtom } from './lib/intend.mjs';
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

  const host = await createFileHost({ rootDir: STATE_DIR });
  await host.atoms.put(atom);
  console.log(`[intend] wrote ${atom.id} (expires ${expiresAt})`);

  if (args.trigger) {
    console.log(`[intend] triggering CTO with intent id: ${atom.id}`);
    // Spawn through scripts/lib/spawn-node.mjs so the CTO child
    // inherits this script's node version. Bare `node` resolves to
    // whatever the shell PATH points at, which on nvm-managed hosts
    // can be an older version that fails to parse the modern ES
    // features the spawned scripts use.
    const result = await spawnNode([
      resolve(REPO_ROOT, 'scripts/run-cto-actor.mjs'),
      '--request', args.request,
      '--intent-id', atom.id,
    ], { stdio: 'inherit', reject: false });
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
    // Print process.execPath for the manual fallback so a no-trigger
    // re-run pins to the same interpreter the runtime-hardening fix
    // gives the --trigger path. Bare `node` here would reintroduce
    // the same PATH/shim mismatch on nvm-managed hosts.
    console.log(`[intend] no --trigger; invoke manually:\n  ${process.execPath} scripts/run-cto-actor.mjs --request "${args.request}" --intent-id ${atom.id}`);
  }
}

main().catch((err) => {
  console.error(`[intend] ${err.message}`);
  process.exit(1);
});
