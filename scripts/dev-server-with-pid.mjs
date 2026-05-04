#!/usr/bin/env node
/**
 * Spawn a long-running dev-server child (tsx watch, vite, or any
 * other watcher) and record its PID into a per-launcher record
 * file. On exit, remove that file so the next pre-flight cleanup
 * sees a clean slot.
 *
 * Wraps `dev:server` in apps/console/package.json so the recorded
 * PIDs match the actual children running. When this wrapper is
 * SIGTERM'd cleanly, it forwards the signal to the child and
 * removes its record. When it crashes uncleanly (process killed by
 * SIGKILL, VM panic, OS shutdown), the per-launcher file is left
 * behind; the next dev-server-cleanup run consumes it.
 *
 * Usage:
 *   node scripts/dev-server-with-pid.mjs <cmd> [args...]
 *
 * Example (wired in apps/console/package.json):
 *   "dev:server": "node ../../scripts/dev-server-with-pid.mjs tsx watch server/index.ts"
 *
 * Why per-launcher records (not a shared file):
 *   `concurrently` spawns this wrapper for `dev:server` and
 *   `dev:web` within the same millisecond. An unlocked
 *   read-merge-write against one shared JSON would lose the first
 *   pair of PIDs whenever the second writer commits its merge
 *   based on a stale read. A unique file per launcher PID
 *   eliminates the race entirely - each writer touches a path no
 *   other writer touches.
 *
 * Cross-platform: spawns the child with `shell: false` on POSIX
 * and `shell: true` on Windows (required for `.cmd` shim
 * resolution); forwards SIGINT/SIGTERM. Does NOT use
 * `detached: true` so Ctrl+C in the parent terminal still
 * propagates through `concurrently` to the child the same way
 * the bare `tsx watch` invocation always did.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  removePidRecordFile,
  writePidRecordFile,
} from './lib/dev-server-cleanup.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const PID_DIR = resolve(REPO_ROOT, 'apps', 'console', '.lag-dev-servers');

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stderr.write(
    'usage: node scripts/dev-server-with-pid.mjs <cmd> [args...]\n',
  );
  process.exit(2);
}

const [cmd, ...cmdArgs] = argv;
// On Windows, Node's child_process.spawn requires shell:true to
// resolve `tsx` (a .cmd shim) on PATH. Without shell:true the
// invocation fails with ENOENT. POSIX is fine without shell.
const useShell = process.platform === 'win32';

const child = spawn(cmd, cmdArgs, {
  stdio: 'inherit',
  shell: useShell,
  windowsHide: true,
});

// Each launcher writes its own record file at
// `<pidDir>/<launcherPid>.json`. No shared mutable state.
function recordPids() {
  if (typeof child.pid !== 'number') return;
  writePidRecordFile(PID_DIR, process.pid, {
    pids: [process.pid, child.pid],
    startedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    entry: cmdArgs.find((a) => a.endsWith('.ts')) ?? cmdArgs.join(' '),
  });
}
recordPids();

let exiting = false;
function cleanup() {
  if (exiting) return;
  exiting = true;
  // Owner-deletes-own-file: no race against the other launcher's
  // record. If the file is already gone (predev cleanup ran while
  // we were exiting), removePidRecordFile is a no-op.
  removePidRecordFile(PID_DIR, process.pid);
}

function forward(sig) {
  return () => {
    if (child.pid && !child.killed) {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
}

process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
process.on('exit', cleanup);

child.on('exit', (code, signal) => {
  cleanup();
  // Mirror the child's exit. When killed by signal, exit code
  // 128+signum follows the convention every shell wrapper uses.
  if (signal) {
    process.exit(128 + (typeof signal === 'string' ? signalToNumber(signal) : 0));
  }
  process.exit(typeof code === 'number' ? code : 0);
});

child.on('error', (err) => {
  process.stderr.write(`[lag-dev-with-pid] spawn failed: ${err instanceof Error ? err.message : String(err)}\n`);
  cleanup();
  process.exit(1);
});

function signalToNumber(sig) {
  // Lookup table for the small set of signals that actually
  // terminate dev-server children. Anything else falls back to 0
  // so the exit code is 128 (caller can treat as "abnormal exit").
  switch (sig) {
    case 'SIGHUP': return 1;
    case 'SIGINT': return 2;
    case 'SIGTERM': return 15;
    case 'SIGKILL': return 9;
    default: return 0;
  }
}
