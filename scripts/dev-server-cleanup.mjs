#!/usr/bin/env node
/**
 * Pre-flight cleanup of stale tsx-watch / vite dev-server children
 * before a fresh `npm run dev` in apps/console/.
 *
 * Long /loop runs leak `tsx watch` (and possibly `vite`) processes
 * that survive their parent launcher when SIGTERM is dropped or the
 * watchdog crashes; the next launcher start does not clean them up
 * and both compete for port 9081 (or 9080), leaving the second
 * launcher in a silently-broken state. This entry point implements
 * the launcher-side mitigation required by the loop-watchdog memory
 * note: read the PID record (b), kill any live PIDs, then run a
 * defensive OS scan (a) for matching command-lines that escaped the
 * record (unclean shutdowns, manually-deleted PID file, fresh
 * worktree without an inherited record).
 *
 * Wired as the `predev` script in apps/console/package.json so
 * `npm run dev` in that subtree always runs through this pre-flight
 * before spawning concurrently. Also runnable directly:
 *
 *   node scripts/dev-server-cleanup.mjs
 *
 * The cleanup is best-effort: a failed scan, a kill that times out,
 * or a missing PID record never aborts `npm run dev`. The launcher
 * proceeds and dev-server start surface their own errors (port
 * conflict, etc.) the operator already understands. The goal is to
 * remove the most common silent failure (orphaned tsx watcher
 * holding port 9081) without introducing a new one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupOrphans } from './lib/dev-server-cleanup.mjs';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo root = parent of `scripts/`. The launcher resolves the PID
// records under `apps/console/.lag-dev-servers/` so a fresh
// worktree gets its own records (each worktree has its own
// apps/console/ subtree) without polluting the primary checkout.
//
// We use a per-launcher record directory rather than a single
// shared JSON file to avoid the lost-update race that an unlocked
// read-merge-write would suffer when `concurrently` spawns the
// `dev:server` and `dev:web` wrappers within the same millisecond.
const REPO_ROOT = resolve(__dirname, '..');
const PID_DIR = resolve(REPO_ROOT, 'apps', 'console', '.lag-dev-servers');
// The matched entry path. The Console's tsx-watch child is
// invoked as `tsx watch server/index.ts` from `apps/console/`,
// so the absolute path on disk includes both the repo root and
// `apps/console/server/index.ts`.
const ENTRY = 'apps/console/server/index.ts';

async function execImpl(cmd, args) {
  // wmic / ps stdout can run hundreds of KB on a busy host; bump
  // the buffer so a noisy machine does not throw ENOBUFS and skip
  // the scan path. Returns { stdout, stderr } per execFileP; the
  // lib consumer reads `.stdout` directly.
  return execFileP(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

async function main() {
  const summary = await cleanupOrphans({
    pidDir: PID_DIR,
    repoRoot: REPO_ROOT,
    entry: ENTRY,
    execImpl,
  });

  const lines = [];
  if (summary.recordedKilled.length > 0) {
    lines.push(`killed recorded pids: ${summary.recordedKilled.join(', ')}`);
  }
  if (summary.scannedKilled.length > 0) {
    lines.push(`killed scanned pids: ${summary.scannedKilled.join(', ')}`);
  }
  if (summary.errors.length > 0) {
    lines.push(`errors: ${summary.errors.join('; ')}`);
  }
  if (lines.length === 0) {
    lines.push('no stale dev-server processes found');
  }

  // Single tagged line so the log is greppable from a long
  // concurrently-prefixed dev session.
  for (const line of lines) {
    process.stdout.write(`[lag-dev-cleanup] ${line}\n`);
  }
}

main().catch((err) => {
  // Cleanup must never block the dev server from starting; log
  // and exit 0 so npm proceeds to `dev:server` + `dev:web`.
  process.stderr.write(`[lag-dev-cleanup] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(0);
});
