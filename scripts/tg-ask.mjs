#!/usr/bin/env node
/**
 * Ask a HIL question via Telegram with causality tracking.
 *
 * Creates a pending_question atom in .lag/ AND queues an outbox
 * message. The daemon sends the message and records the Telegram
 * message_id onto the question atom's metadata. When the HIL
 * swipe-replies on Telegram, the daemon's autoBindAnswer flips
 * the question to 'answered' and writes the answer atom with
 * provenance.derived_from = [questionId].
 *
 * Result: every HIL Q/A exchange is causally bound even across
 * delays, out-of-order messages, or simultaneous questions.
 *
 * Usage:
 *   node scripts/tg-ask.mjs "Should we deploy X now?"
 *   node scripts/tg-ask.mjs "Pick one: A or B" --expires-in-hours 2
 *   node scripts/tg-ask.mjs --related atom-id-1 --related atom-id-2 "Approve plan?"
 *
 * Prints the question atom id on stdout. Also writes to outbox so
 * the message reaches Telegram via the daemon's next drain tick.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { askQuestion } from '../dist/questions/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const OUTBOX_DIR = join(STATE_DIR, 'tg-queue', 'outbox');

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[tg-ask] ERROR: LAG_OPERATOR_ID is not set. Export it and re-run.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    content: '',
    asker: process.env.LAG_AGENT_ID || 'claude-agent',
    expiresInHours: null,
    related: [],
    chatId: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asker' && i + 1 < argv.length) {
      args.asker = argv[++i];
    } else if (a === '--expires-in-hours' && i + 1 < argv.length) {
      args.expiresInHours = Number(argv[++i]);
    } else if (a === '--related' && i + 1 < argv.length) {
      args.related.push(argv[++i]);
    } else if (a === '--chat-id' && i + 1 < argv.length) {
      args.chatId = Number(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/tg-ask.mjs "question text" [--asker <id>] [--expires-in-hours N] [--related <atom-id>]...');
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  args.content = rest.join(' ').trim();
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.content) {
    console.error('Missing question text. See --help.');
    process.exit(1);
  }

  const host = await createFileHost({ rootDir: STATE_DIR });
  const expiresAt = args.expiresInHours
    ? new Date(Date.now() + args.expiresInHours * 3600_000).toISOString()
    : undefined;

  const q = await askQuestion(host, {
    content: args.content,
    asker: args.asker,
    ...(expiresAt ? { expiresAt } : {}),
    relatedAtoms: args.related,
    metadata: {
      asked_via: 'telegram',
      expected_responder: OPERATOR_ID,
    },
  });

  // Write the outbox message with questionId so the daemon links the
  // sent message_id back onto the question atom.
  mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const outFile = join(OUTBOX_DIR, `${ts}-${rand}-ask.json`);
  const payload = {
    text: `*Question:* ${args.content}\n\n_(Reply-to this message on Telegram to bind your answer via Phase 50b. Question id: ${q.id})_`,
    at: new Date().toISOString(),
    origin: 'tg-ask',
    questionId: q.id,
    ...(args.chatId !== null ? { chatId: args.chatId } : {}),
  };
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`question atom: ${q.id}`);
  console.log(`outbox queued: ${outFile}`);
  console.log(`daemon will send and record message_id on question metadata within its next tick`);
}

main().catch((err) => {
  console.error('tg-ask failed:', err);
  process.exit(1);
});
