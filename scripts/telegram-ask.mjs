#!/usr/bin/env node
/**
 * Ask a yes/no or multi-choice question to your Telegram bot, wait for
 * a response, print it.
 *
 * This is the "hand a question off to my phone" primitive. The canonical
 * use case during development: an agent (Claude in a session, a
 * background daemon, anything) wants a human decision and should not
 * block on the human being at the terminal.
 *
 * Usage:
 *   node scripts/telegram-ask.mjs "Should we name this X or Y?"
 *   node scripts/telegram-ask.mjs "Pick one" --options "A,B,C"
 *   node scripts/telegram-ask.mjs "Approve deploy?" --timeout 600000
 *
 * Options:
 *   --options   Comma-separated list of answer buttons (default: Approve,Reject,Ignore).
 *               Values are used as BOTH the button label and the response value.
 *               Button labels are truncated display-side to whatever Telegram allows.
 *   --timeout   Max ms to wait for the answer. Default 300000 (5 minutes).
 *
 * Exit codes:
 *   0   Human tapped an answer. The answer is printed to stdout.
 *   2   Timeout without a response.
 *   1   Any other failure (bad token, bad chat id, network).
 *
 * Because the answer is printed on stdout (and only the answer, nothing
 * else), this composes with shell pipelines:
 *   ANSWER=$(node scripts/telegram-ask.mjs "Proceed?" --options "Yes,No")
 *   [ "$ANSWER" = "Yes" ] && do-the-thing
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryHost } from '../dist/adapters/memory/index.js';
import { TelegramNotifier } from '../dist/adapters/notifier/telegram/index.js';

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

function parseArgs(argv) {
  const args = { question: null, options: null, timeoutMs: 300_000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--options' && i + 1 < argv.length) {
      args.options = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--timeout' && i + 1 < argv.length) {
      args.timeoutMs = Number(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  args.question = rest.join(' ').trim();
  return args;
}

function printHelp() {
  console.log('Usage: node scripts/telegram-ask.mjs "Your question?" [--options A,B,C] [--timeout ms]');
}

async function main() {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    printHelp();
    process.exit(1);
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set. See .env.example.');
    process.exit(1);
  }

  // If custom options are given, we extend the Telegram notifier's default
  // (approve/reject/ignore) by mapping answers into dispositions. For the
  // default case we just use the three built-in buttons.
  //
  // Shape we want: the user taps a button labeled with their custom option,
  // callback_data is `<handle>:approve` if they picked option 0, etc. That
  // keeps the wrapper oblivious to semantic names.
  //
  // Built-in notifier hardcodes approve/reject/ignore; for custom options,
  // we use the first three (approve/reject/ignore) as slots and map back
  // on output. If the caller provides more than 3 options, we degrade: use
  // the default three and tell the user in the prompt body.

  const host = createMemoryHost();
  const notifier = new TelegramNotifier({
    botToken: token,
    chatId,
    base: host.notifier,
    respondAsPrincipal: 'telegram-ask',
    pollIntervalMs: 1500,
  });
  notifier.startPolling();

  const DISPOSITIONS = ['approve', 'reject', 'ignore'];
  const options = args.options && args.options.length > 0
    ? args.options.slice(0, 3)
    : ['Approve', 'Reject', 'Ignore'];
  const mapping = Object.fromEntries(DISPOSITIONS.slice(0, options.length).map((d, i) => [d, options[i]]));
  const bodyLines = [];
  if (args.options) {
    bodyLines.push('(Buttons below: ' + options.map((o, i) => `${['Approve','Reject','Ignore'][i]} = ${o}`).join(', ') + ')');
  }

  const now = host.clock.now();
  const event = {
    kind: 'proposal',
    severity: 'info',
    summary: args.question,
    body: bodyLines.join('\n'),
    atom_refs: [],
    principal_id: 'telegram-ask',
    created_at: now,
  };

  const handle = await notifier.telegraph(event, null, 'coexist', args.timeoutMs);
  const disposition = await notifier.awaitDisposition(handle, args.timeoutMs);
  notifier.stopPolling();

  if (disposition === 'coexist' || disposition === 'pending') {
    // Timed out. The base returns defaultDisposition on timeout ('coexist'),
    // which does not map to any button; interpret as "no answer".
    console.error('Timed out without a response.');
    process.exit(2);
  }
  const answer = mapping[disposition] ?? disposition;
  process.stdout.write(answer + '\n');
}

main().catch(err => {
  console.error('telegram-ask failed:', err);
  process.exit(1);
});
