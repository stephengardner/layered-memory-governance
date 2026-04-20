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

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'start': await start(); return;
    case 'stop': await stop(); return;
    case 'status': await status(); return;
    case 'restart':
      await stop();
      await start();
      return;
    case undefined:
    case '-h':
    case '--help':
      console.log(`Usage: lag-tg <start|stop|status|restart>

  start      start the LAG Telegram daemon in the background (idempotent)
  stop       send SIGTERM to the recorded pid and clear the lockfile
  status     report running | stopped | stale
  restart    stop + start

Lockfile:  ${PID_FILE}
Log file:  ${LOG_FILE}
Script:    ${DAEMON_SCRIPT}`);
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
