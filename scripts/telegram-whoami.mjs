#!/usr/bin/env node
/**
 * Telegram "whoami" helper.
 *
 * Usage:
 *   1. Create a bot via @BotFather, set TELEGRAM_BOT_TOKEN in your .env.
 *   2. Send any message to your bot (e.g. "hi").
 *   3. Run: node scripts/telegram-whoami.mjs
 *   4. Paste the printed chat id into TELEGRAM_CHAT_ID in .env.
 *
 * Reads TELEGRAM_BOT_TOKEN from the environment. Loads .env if present.
 * Calls getUpdates once and prints the chat id of the newest private
 * message received by the bot. No state persisted.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set. Put it in .env or export it.');
    process.exit(1);
  }

  const url = `https://api.telegram.org/bot${token}/getUpdates?limit=20&timeout=0`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) {
    console.error(`Telegram API error: ${json.error_code ?? 'unknown'} ${json.description ?? ''}`);
    process.exit(1);
  }
  const updates = json.result || [];
  if (updates.length === 0) {
    console.log('No recent updates. Send any message to your bot first, then re-run.');
    console.log('If you already did and still see this, /start the bot to re-enable getUpdates delivery.');
    return;
  }

  // Collect unique chat ids from the window.
  const chats = new Map();
  for (const u of updates) {
    const m = u.message || u.callback_query?.message;
    if (!m || !m.chat) continue;
    chats.set(m.chat.id, {
      id: m.chat.id,
      type: m.chat.type,
      title: m.chat.title || `${m.chat.first_name || ''} ${m.chat.last_name || ''}`.trim() || m.chat.username || '(unknown)',
    });
  }

  console.log('Recent chats that messaged your bot:');
  for (const c of chats.values()) {
    console.log(`  chat_id=${c.id}  type=${c.type}  who=${c.title}`);
  }
  const first = chats.values().next().value;
  if (first) {
    console.log('');
    console.log(`Most likely the one you want:`);
    console.log(`  TELEGRAM_CHAT_ID=${first.id}`);
    console.log('');
    console.log('Paste that into your .env, then restart the daemon.');
  }
}

main().catch(err => {
  console.error('telegram-whoami failed:', err);
  process.exit(1);
});
