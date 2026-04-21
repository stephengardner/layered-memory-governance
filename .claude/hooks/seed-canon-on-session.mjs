#!/usr/bin/env node
/**
 * PreToolUse hook: once per Claude Code session, seed canon atoms
 * from `bootstrap-all-canon.mjs` so session agents see the authored
 * canon the moment they start operating.
 *
 * Context: session 2026-04-21 surfaced the gap. The cto-actor drafted
 * a plan and correctly flagged a cited atom as absent - the edit to
 * `bootstrap-decisions-canon.mjs` had landed on main, but the script
 * was never executed, so the canon store lagged the source. This hook
 * closes that mechanically: first tool call per session runs
 * bootstrap-all, writes a guard file, subsequent calls noop instantly.
 *
 * Fires on PreToolUse/Bash (the established matcher). Claude Code's
 * PreToolUse payload includes `session_id`, which we use as the guard
 * key. New session re-seeds; mid-session restart re-seeds (cheap +
 * idempotent). Second-plus tool calls in one session skip.
 *
 * Scope: this repo only. In another project the hook does not exist.
 * Fail-open: any crash or script failure allows the tool call.
 * Performance: cold seed ~1s; warm seed short-circuits before
 * subprocess.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_DIR = resolve(REPO_ROOT, '.lag', 'session-seeds');
const BOOTSTRAP_SCRIPT = resolve(REPO_ROOT, 'scripts', 'bootstrap-all-canon.mjs');

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    process.stderr.write('[seed-canon] no session_id in payload; skipping seed + allow\n');
    process.exit(0);
  }

  const guardPath = resolve(GUARD_DIR, `${sessionId}.done`);
  if (existsSync(guardPath)) process.exit(0);

  if (!process.env.LAG_OPERATOR_ID) {
    process.stderr.write(
      '[seed-canon] LAG_OPERATOR_ID not set; skipping canon seed for this session.\n'
      + '[seed-canon] Set it in your shell profile and restart to re-seed.\n',
    );
    tryWriteGuard(guardPath);
    process.exit(0);
  }

  const t0 = Date.now();
  const result = spawnSync('node', [BOOTSTRAP_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });
  const elapsed = Date.now() - t0;

  if (result.error) {
    process.stderr.write(`[seed-canon] failed to spawn bootstrap-all: ${result.error.message} (${elapsed}ms)\n`);
    process.exit(0);
  }
  if (result.status !== 0) {
    process.stderr.write(`[seed-canon] bootstrap-all exited with status ${result.status} (${elapsed}ms). Canon may be out of sync.\n`);
    process.exit(0);
  }

  tryWriteGuard(guardPath);
  process.stderr.write(`[seed-canon] canon seeded in ${elapsed}ms for session ${sessionId.slice(0, 8)}\n`);
  process.exit(0);
}

function tryWriteGuard(guardPath) {
  try {
    mkdirSync(dirname(guardPath), { recursive: true });
    writeFileSync(guardPath, new Date().toISOString() + '\n');
  } catch (err) {
    process.stderr.write(`[seed-canon] could not write guard ${guardPath}: ${err?.message ?? err}\n`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(() => process.exit(0));
