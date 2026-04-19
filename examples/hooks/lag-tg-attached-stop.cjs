#!/usr/bin/env node
/**
 * LAG Phase 42: terminal-attached Stop hook.
 *
 * Wire this as a `Stop` hook in your Claude Code settings. When the
 * LAG daemon runs in queue-only mode (node scripts/daemon.mjs
 * --queue-only), incoming Telegram messages are written to
 * <LAG_ROOT>/.lag/tg-queue/inbox/. This hook fires after each of
 * your terminal Claude turns, picks up pending messages, and
 * re-prompts Claude with them as the next turn. The response Claude
 * generates is captured on the SUBSEQUENT Stop and written to
 * <LAG_ROOT>/.lag/tg-queue/outbox/, where the daemon sends it to
 * Telegram.
 *
 * Wiring (one-time): add an entry to your settings.local.json:
 *
 *   "Stop": [
 *     {
 *       "matcher": "",
 *       "hooks": [
 *         { "type": "command", "command": "node C:/Users/opens/memory-governance/examples/hooks/lag-tg-attached-stop.cjs" }
 *       ]
 *     }
 *   ]
 *
 * Environment variables (optional):
 *   LAG_ROOT            Absolute path to the LAG repo. Defaults to the
 *                       repo that ships this hook script.
 *
 * Fail-safe: any unexpected error exits with code 0 so the hook never
 * blocks your terminal session. Missing queue dir = no-op.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Locate the LAG queue dir.
// ---------------------------------------------------------------------------

const LAG_ROOT = process.env.LAG_ROOT
  || path.resolve(__dirname, '..', '..'); // examples/hooks/ -> repo root
const QUEUE_DIR = path.join(LAG_ROOT, '.lag', 'tg-queue');
const INBOX_DIR = path.join(QUEUE_DIR, 'inbox');
const CONSUMED_DIR = path.join(QUEUE_DIR, 'consumed');
const OUTBOX_DIR = path.join(QUEUE_DIR, 'outbox');
const MARKER_PATH = path.join(QUEUE_DIR, 'active-turn.json');

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

(async function main() {
  try {
    const input = await readStdinJson();
    const stopHookActive = !!input.stop_hook_active;
    const transcriptPath = typeof input.transcript_path === 'string'
      ? input.transcript_path
      : null;

    // If we are already in a hook-induced loop, exit without injecting
    // again to avoid runaway recursion.
    if (stopHookActive) {
      process.exit(0);
    }

    // Step 1: if a prior inject left a marker, parse my last assistant
    //         response and write it to the outbox for the daemon.
    const marker = readJsonOrNull(MARKER_PATH);
    if (marker && transcriptPath) {
      try {
        const reply = findLastAssistantText(transcriptPath);
        if (reply && reply.trim().length > 0) {
          fs.mkdirSync(OUTBOX_DIR, { recursive: true });
          const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
          const outFile = path.join(OUTBOX_DIR, `${tsSlug}.json`);
          const payload = {
            chatId: marker.chatId,
            text: reply,
            respondedTo: marker.handles || [],
            at: new Date().toISOString(),
          };
          fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        }
      } catch (err) {
        // Best-effort; never fail the hook.
        process.stderr.write(`[lag-tg-stop] outbox write failed: ${err.message}\n`);
      }
      try {
        fs.rmSync(MARKER_PATH, { force: true });
      } catch { /* ignore */ }
    }

    // Step 2: check inbox for new messages. If any, consume and inject.
    if (!fs.existsSync(INBOX_DIR)) {
      process.exit(0);
    }
    const pending = fs.readdirSync(INBOX_DIR)
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort(); // ISO-like timestamps sort lexicographically
    if (pending.length === 0) {
      process.exit(0);
    }

    fs.mkdirSync(CONSUMED_DIR, { recursive: true });
    const messages = [];
    let chatId = null;
    const handles = [];
    for (const name of pending) {
      const src = path.join(INBOX_DIR, name);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(src, 'utf8'));
      } catch (err) {
        process.stderr.write(`[lag-tg-stop] skip ${name}: ${err.message}\n`);
        continue;
      }
      if (typeof data.text === 'string' && data.text.trim().length > 0) {
        messages.push(data.text);
        handles.push(name);
      }
      if (chatId === null && typeof data.chatId === 'number') {
        chatId = data.chatId;
      }
      try {
        fs.renameSync(src, path.join(CONSUMED_DIR, name));
      } catch (err) {
        // If rename fails (e.g. cross-device), fall back to copy+unlink.
        try {
          fs.copyFileSync(src, path.join(CONSUMED_DIR, name));
          fs.rmSync(src, { force: true });
        } catch (inner) {
          process.stderr.write(`[lag-tg-stop] consume failed ${name}: ${inner.message}\n`);
        }
      }
    }

    if (messages.length === 0) {
      process.exit(0);
    }

    // Leave a marker so the NEXT Stop knows this turn was TG-triggered.
    try {
      fs.mkdirSync(QUEUE_DIR, { recursive: true });
      fs.writeFileSync(MARKER_PATH, JSON.stringify({ chatId, handles, at: new Date().toISOString() }, null, 2), 'utf8');
    } catch (err) {
      process.stderr.write(`[lag-tg-stop] marker write failed: ${err.message}\n`);
    }

    // Format the systemMessage-style reinject.
    const bodyLines = [];
    bodyLines.push(
      'LAG: the following message(s) arrived on Telegram from the operator while you were working. ' +
      'Respond to them directly; your reply will be sent back over Telegram automatically.',
    );
    bodyLines.push('');
    for (const m of messages) {
      bodyLines.push(`> ${m.split('\n').join('\n> ')}`);
      bodyLines.push('');
    }

    // Emit the Stop-block decision to cause Claude to continue with this
    // content as the next turn's prompt.
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: bodyLines.join('\n').trimEnd(),
    }));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[lag-tg-stop] fatal: ${err.message}\n`);
    process.exit(0); // fail-safe: never block the terminal session
  }
})();

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

function readJsonOrNull(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Walk the session jsonl and return the text of the most recent
 * assistant message (concatenated `text` blocks of the last turn).
 * Returns null if none found.
 *
 * Skips turns produced by this hook itself (the systemMessage turn)
 * so we capture the actual response Claude gave, not the reinject.
 */
function findLastAssistantText(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return null;
  const data = fs.readFileSync(transcriptPath, 'utf8');
  const lines = data.split(/\r?\n/);
  // Walk from the end.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg) continue;
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim().length > 0) return content;
      continue;
    }
    if (Array.isArray(content)) {
      const parts = [];
      for (const b of content) {
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
      if (parts.length > 0) return parts.join('\n\n');
    }
  }
  return null;
}
