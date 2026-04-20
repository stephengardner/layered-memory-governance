#!/usr/bin/env node
/**
 * SessionStart hook: auto-start the LAG Telegram daemon.
 *
 * When `claude` boots in the LAG repo, this hook guarantees a Telegram
 * daemon is alive so the operator can message the agent from their
 * phone without any per-session ritual.
 *
 * Contract:
 *   - idempotent: re-starting Claude re-runs the hook, which no-ops if
 *     the daemon is already up
 *   - silent on success: only noisy when something is wrong or when a
 *     stale lock is reclaimed
 *   - opt-out: set LAG_TG_AUTOSTART=0 in your shell/.env to skip
 *   - fail-open: any internal error is logged but never blocks the
 *     session
 *
 * Wire it into Claude Code by adding to .claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "matcher": "*", "hooks": [
 *           { "type": "command",
 *             "command": "node .claude/hooks/lag-tg-autostart.mjs" }
 *         ]}
 *       ]
 *     }
 *   }
 *
 * The hook intentionally lives under .claude/hooks/ (Claude Code
 * convention). Its logic is ~15 lines because it delegates to the
 * `lifecycle` primitive shipped with LAG; if you want to see the
 * mechanism, read src/lifecycle/ensure-service-running.ts.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ensureServiceRunning } from '../../dist/lifecycle/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
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

async function main() {
  await loadDotEnv();

  // Opt-out: operator can disable with LAG_TG_AUTOSTART=0 in .env.
  const flag = (process.env.LAG_TG_AUTOSTART ?? '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return;

  // Cannot start without credentials; this is not an error, just a
  // signal that the operator hasn't configured Telegram yet.
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  const res = await ensureServiceRunning({
    command: process.execPath,
    args: [DAEMON_SCRIPT, '--resume-latest'],
    pidFile: PID_FILE,
    cwd: REPO_ROOT,
    logFile: LOG_FILE,
  });

  // Silent on already-running; noisy otherwise so the operator sees
  // what the hook did. Goes to the Claude Code session console.
  if (res.status === 'started') {
    console.error(`[lag-tg] daemon started (pid ${res.pid}); logs -> ${LOG_FILE}`);
  } else if (res.status === 'stale-lock-reclaimed') {
    console.error(`[lag-tg] reclaimed stale lock; daemon restarted (pid ${res.pid})`);
  } else if (res.status === 'failed') {
    console.error(`[lag-tg] autostart failed: ${res.reason}`);
  }
}

// Fail-open: never let a hook error block the session.
main().catch((err) => {
  console.error('[lag-tg] hook error (non-fatal):', err instanceof Error ? err.message : err);
});
