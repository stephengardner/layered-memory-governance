#!/usr/bin/env node
/**
 * LAG daemon (Phase 41a).
 *
 * Ambient Telegram runtime. Long-polls for messages and escalation
 * callbacks, spawns `claude -p` per message (no API key; uses your
 * existing Claude CLI OAuth), writes atoms into `.lag/`, replies to
 * the configured chat.
 *
 * Prereqs:
 *   - TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 *   - Claude CLI installed and authenticated (`claude /login` once)
 *   - Ran `npm run build` so dist/ is up to date
 *
 * Usage:
 *   node scripts/daemon.mjs
 *   node scripts/daemon.mjs --root-dir /tmp/demo-lag
 *   node scripts/daemon.mjs --verbose
 *
 * Stop: Ctrl-C (SIGINT). The daemon unwinds its poll loop cleanly.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createFileHost } from '../dist/adapters/file/index.js';
import { LAGDaemon } from '../dist/daemon/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function parseArgs(argv) {
  const args = {
    rootDir: resolve(REPO_ROOT, '.lag'),
    canonPath: resolve(REPO_ROOT, 'CLAUDE.md'),
    verbose: false,
    resumeSession: null, // null | 'latest' | '<specific-id>'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root-dir' && i + 1 < argv.length) {
      args.rootDir = resolve(argv[++i]);
    } else if (a === '--canon-file' && i + 1 < argv.length) {
      args.canonPath = resolve(argv[++i]);
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '--resume-latest') {
      args.resumeSession = 'latest';
    } else if (a === '--resume-session' && i + 1 < argv.length) {
      args.resumeSession = argv[++i];
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/daemon.mjs [--root-dir <path>] [--canon-file <path>] [--resume-latest | --resume-session <id>] [--verbose]`);
      process.exit(0);
    }
  }
  return args;
}

/**
 * Walk ~/.claude/projects/*\/*.jsonl and return the id of the
 * most-recently-modified session. Returns null if nothing found.
 */
async function findLatestSessionId() {
  const projectsDir = join(homedir(), '.claude', 'projects');
  let best = null;
  let dirs;
  try {
    dirs = await readdir(projectsDir);
  } catch { return null; }
  for (const d of dirs) {
    const sub = join(projectsDir, d);
    let files;
    try { files = await readdir(sub); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(sub, f);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (!best || s.mtimeMs > best.mtime) {
        best = { id: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs, project: d };
      }
    }
  }
  return best;
}

async function main() {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) { console.error('TELEGRAM_BOT_TOKEN not set in .env'); process.exit(1); }
  if (!chatId) { console.error('TELEGRAM_CHAT_ID not set in .env'); process.exit(1); }

  await mkdir(args.rootDir, { recursive: true });
  const host = await createFileHost({ rootDir: args.rootDir });

  // Resolve resume session id.
  let resumeSessionId = null;
  if (args.resumeSession === 'latest') {
    const latest = await findLatestSessionId();
    if (latest) {
      resumeSessionId = latest.id;
      console.log(`  Resume:       ${latest.id}`);
      console.log(`                (from project ${latest.project})`);
    } else {
      console.log(`  Resume:       (requested latest, none found; starting fresh)`);
    }
  } else if (args.resumeSession) {
    resumeSessionId = args.resumeSession;
    console.log(`  Resume:       ${resumeSessionId}`);
  }

  const daemon = new LAGDaemon({
    host,
    botToken: token,
    chatId,
    canonFilePath: args.canonPath,
    // Run claude -p from the LAG repo root so the CLI picks up this
    // repo's CLAUDE.md natively and does not fall back to workspace
    // history in ~/.claude.json (which leaks other projects' context).
    repoRoot: REPO_ROOT,
    ...(resumeSessionId !== null ? { resumeSessionId } : {}),
    principalResolver: () => 'lag-self',
    onCallback: async (handle, disposition, responder) => {
      try {
        await host.notifier.respond(handle, disposition, responder);
      } catch (err) {
        console.error('[daemon] respond failed:', err?.message || err);
      }
    },
    invokeOptions: {
      verbose: args.verbose,
    },
    onError: (err, ctx) => {
      console.error(`[daemon] ${ctx}:`, err?.message || err);
    },
  });

  console.log(`LAG daemon starting`);
  console.log(`  Root dir:     ${args.rootDir}`);
  console.log(`  Canon file:   ${args.canonPath}`);
  console.log(`  Chat id:      ${chatId}`);
  console.log(`  Model:        claude-haiku-4-5-20251001 (default)`);
  console.log(`  Send a message on Telegram. Ctrl-C to stop.`);
  console.log('');

  daemon.start();

  const shutdown = () => {
    console.log('\nShutting down...');
    daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive. start() fires the first tick without blocking.
  await new Promise(() => {});
}

main().catch(err => {
  console.error('daemon failed:', err);
  process.exit(1);
});
