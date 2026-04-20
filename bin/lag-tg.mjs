#!/usr/bin/env node
/**
 * lag-tg: tiny operator CLI to start/stop/status the LAG Telegram daemon.
 *
 * Uses the lifecycle primitive under the hood so a SessionStart hook
 * and an operator invocation share the same idempotent semantics.
 *
 * Usage:
 *   lag-tg start      idempotent: no-op if already running
 *   lag-tg stop       sends SIGTERM and removes the pid lockfile
 *   lag-tg status     reports running | stopped | stale with pid
 *   lag-tg restart    stop + start
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  ensureServiceRunning,
  getServiceStatus,
  stopService,
} from '../dist/lifecycle/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const PID_FILE = join(REPO_ROOT, '.lag', 'daemon.pid');
const LOG_FILE = join(REPO_ROOT, '.lag', 'daemon.log');
const DAEMON_SCRIPT = join(REPO_ROOT, 'scripts', 'daemon.mjs');
const TERMINAL_SCRIPT = join(REPO_ROOT, 'scripts', 'lag-terminal.mjs');

async function loadDotEnv() {
  try {
    const text = await readFile(resolve(REPO_ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* .env optional */
  }
}

async function start() {
  await loadDotEnv();
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('lag-tg: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (typically in .env).');
    process.exit(1);
  }
  const res = await ensureServiceRunning({
    command: process.execPath,
    args: [DAEMON_SCRIPT, '--resume-latest'],
    pidFile: PID_FILE,
    cwd: REPO_ROOT,
    logFile: LOG_FILE,
  });
  switch (res.status) {
    case 'already-running':
      console.log(`lag-tg: already running (pid ${res.pid})`);
      return;
    case 'started':
      console.log(`lag-tg: started (pid ${res.pid}); logs -> ${LOG_FILE}`);
      return;
    case 'stale-lock-reclaimed':
      console.log(`lag-tg: reclaimed stale lock (prev pid ${res.previousPid}); started pid ${res.pid}`);
      return;
    case 'failed':
      console.error(`lag-tg: failed to start: ${res.reason}`);
      process.exit(1);
  }
}

async function stop() {
  const res = await stopService({ pidFile: PID_FILE });
  switch (res.status) {
    case 'stopped':
      console.log(`lag-tg: stopped (pid ${res.pid})`);
      return;
    case 'not-running':
      console.log('lag-tg: not running');
      return;
    case 'failed':
      console.error(`lag-tg: failed to stop: ${res.reason}`);
      process.exit(1);
  }
}

async function status() {
  const res = await getServiceStatus({ pidFile: PID_FILE });
  switch (res.status) {
    case 'running':
      console.log(`lag-tg: running (pid ${res.pid})`);
      return;
    case 'stopped':
      console.log('lag-tg: stopped');
      return;
    case 'stale':
      console.log(`lag-tg: stale lockfile (pid ${res.pid} no longer alive); next start will reclaim`);
      return;
  }
}

async function terminal(rest) {
  // Foreground PTY-mirror session. Ensures no standalone daemon is
  // racing for Telegram getUpdates before exec'ing lag-terminal. Two
  // daemons polling the same bot getUpdates endpoint would have them
  // fighting over each update's ownership (only one consumer wins
  // per message) and duplicating outbound replies; abort if we can
  // not confirm the prior daemon is gone.
  const status = await getServiceStatus({ pidFile: PID_FILE });
  if (status.status === 'running') {
    console.error(`lag-tg: standalone daemon is running (pid ${status.pid}); stopping before terminal mode`);
    const stopResult = await stopService({ pidFile: PID_FILE });
    if (stopResult.status === 'failed') {
      console.error(`lag-tg: failed to stop daemon: ${stopResult.reason}`);
      console.error('lag-tg: aborting terminal mode; investigate the stuck process and retry.');
      process.exit(1);
    }
    // stopService now waits for the process to exit before returning
    // 'stopped', but be defensive: poll getServiceStatus as a
    // belt-and-braces check against a future regression where
    // stopService reports optimistically.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const check = await getServiceStatus({ pidFile: PID_FILE });
      if (check.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const final = await getServiceStatus({ pidFile: PID_FILE });
    if (final.status === 'running') {
      console.error(`lag-tg: daemon pid ${final.pid} still alive after stop + 3s grace; aborting so we do not race for getUpdates.`);
      process.exit(1);
    }
  }
  await loadDotEnv();
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('lag-tg: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (typically in .env).');
    process.exit(1);
  }
  // Exec the terminal wrapper in the foreground; its PTY session is
  // interactive so we inherit stdio verbatim.
  const child = spawn(process.execPath, [TERMINAL_SCRIPT, ...rest], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  switch (cmd) {
    case 'start': await start(); return;
    case 'stop': await stop(); return;
    case 'status': await status(); return;
    case 'restart':
      await stop();
      await start();
      return;
    case 'terminal':
      await terminal(rest);
      return;
    case undefined:
    case '-h':
    case '--help':
      console.log(`Usage: lag-tg <start|stop|status|restart|terminal>

Modes:
  start        Standalone daemon: each TG message spawns a fresh
               \`claude -p\` subprocess with the cli-renderer throbber.
               Runs detached in the background. Best when you don't
               need an interactive local Claude session.

  terminal     PTY mirror: wraps your local Claude Code session in a
               PTY. Telegram messages inject into stdin; assistant
               turns mirror to Telegram with the cli-renderer
               throbber (via jsonl tail). Runs in the foreground of
               the terminal you invoked it from.
               Forwards any remaining args to scripts/lag-terminal.mjs
               (e.g. --resume-session <id>).

Lifecycle:
  stop         send SIGTERM to the recorded pid and clear the lockfile
  status       report running | stopped | stale
  restart      stop + start

Note: only one of (start, terminal) may poll Telegram at a time.
\`terminal\` auto-stops a running daemon before taking over.

Lockfile:  ${PID_FILE}
Log file:  ${LOG_FILE}
Daemon:    ${DAEMON_SCRIPT}
Terminal:  ${TERMINAL_SCRIPT}`);
      return;
    default:
      console.error(`lag-tg: unknown subcommand: ${cmd}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('lag-tg failed:', err);
  process.exit(1);
});
