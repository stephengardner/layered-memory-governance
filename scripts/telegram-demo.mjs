#!/usr/bin/env node
/**
 * Telegram Notifier end-to-end demo.
 *
 * Usage:
 *   1. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env (see .env.example).
 *      Use `node scripts/telegram-whoami.mjs` to discover the chat id.
 *   2. Run: node scripts/telegram-demo.mjs
 *
 * What it does:
 *   - Creates an in-memory Host.
 *   - Wraps host.notifier in a TelegramNotifier with your token + chat id.
 *   - Starts polling for responses (every 2s).
 *   - Fires one test escalation. You get it on your phone with three
 *     inline buttons (Approve / Reject / Ignore).
 *   - Waits up to 120s for your tap, prints the resolved disposition.
 *
 * Proves: telegraph routes to your phone, inline keyboard works, the
 * callback response flows back into the base notifier's disposition state.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryHost } from '../dist/adapters/memory/index.js';
import { TelegramNotifier } from '../dist/adapters/notifier/telegram.js';

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
    // No .env, fall back to process.env.
  }
}

async function main() {
  await loadDotEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set in .env. Aborting.');
    process.exit(1);
  }
  if (!chatId) {
    console.error('TELEGRAM_CHAT_ID not set. Run `node scripts/telegram-whoami.mjs` first.');
    process.exit(1);
  }

  const host = createMemoryHost();
  const notifier = new TelegramNotifier({
    botToken: token,
    chatId,
    base: host.notifier,
    respondAsPrincipal: 'telegram-demo',
    pollIntervalMs: 1500,
  });
  notifier.startPolling();

  const now = host.clock.now();
  const event = {
    kind: 'proposal',
    severity: 'info',
    summary: 'LAG demo escalation',
    body: [
      'This is a one-shot test from scripts/telegram-demo.mjs.',
      '',
      'Tap one of the three buttons below. The disposition you pick will',
      'print back in your terminal and this script will exit.',
    ].join('\n'),
    atom_refs: [],
    principal_id: 'telegram-demo',
    created_at: now,
  };

  console.log('Firing escalation...');
  const handle = await notifier.telegraph(event, null, 'coexist', 120_000);
  console.log(`Handle: ${String(handle)}`);
  console.log('Check your phone. Waiting up to 120s for your tap...');

  const disposition = await notifier.awaitDisposition(handle, 120_000);
  console.log(`\nResolved: ${disposition}`);

  notifier.stopPolling();
}

main().catch(err => {
  console.error('telegram-demo failed:', err);
  process.exit(1);
});
