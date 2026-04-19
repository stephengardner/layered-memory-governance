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
const MIRROR_ALL_SENTINEL = path.join(QUEUE_DIR, 'mirror-all');
const LAST_MIRRORED_PATH = path.join(QUEUE_DIR, 'last-mirrored-uuid.txt');
const NO_AUTO_ACK_SENTINEL = path.join(QUEUE_DIR, 'no-auto-ack');
const SENT_LOG_PATH = path.join(QUEUE_DIR, 'sent-log.jsonl');

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

    // Step 1a: if a prior inject left a marker, parse my last assistant
    //          response and write it to the outbox for the daemon.
    //          (TG-origin turn: always mirrored regardless of mode.)
    let outboundSentFromMarker = false;
    const marker = readJsonOrNull(MARKER_PATH);
    if (marker && transcriptPath) {
      try {
        const replyInfo = findLastAssistant(transcriptPath);
        if (replyInfo && replyInfo.text.trim().length > 0) {
          writeOutbox({
            chatId: marker.chatId,
            text: replyInfo.text,
            respondedTo: marker.handles || [],
            at: new Date().toISOString(),
            origin: 'tg-response',
          });
          persistLastMirrored(replyInfo.uuid);
          outboundSentFromMarker = true;
        }
      } catch (err) {
        process.stderr.write(`[lag-tg-stop] outbox write failed: ${err.message}\n`);
      }
      try {
        fs.rmSync(MARKER_PATH, { force: true });
      } catch { /* ignore */ }
    }

    // Step 1b: mirror-all mode. If the sentinel file exists and we did
    //          not just mirror via the marker path, push the latest
    //          assistant reply to Telegram regardless of origin. Uses a
    //          last-mirrored-uuid state file to skip the same turn twice.
    if (!outboundSentFromMarker && fs.existsSync(MIRROR_ALL_SENTINEL) && transcriptPath) {
      try {
        const replyInfo = findLastAssistant(transcriptPath);
        const lastSent = readTextOrNull(LAST_MIRRORED_PATH);
        if (
          replyInfo
          && replyInfo.text.trim().length > 0
          && replyInfo.uuid !== lastSent
        ) {
          // Default chat id: read from the sentinel file if it contains a
          // number, else fall back to env or no chatId (daemon uses its
          // configured default).
          const sentinelContent = fs.readFileSync(MIRROR_ALL_SENTINEL, 'utf8').trim();
          const parsedChatId = Number(sentinelContent);
          const payload = {
            text: replyInfo.text,
            at: new Date().toISOString(),
            origin: 'terminal-mirror',
          };
          if (Number.isFinite(parsedChatId) && parsedChatId > 0) {
            payload.chatId = parsedChatId;
          }
          writeOutbox(payload);
          persistLastMirrored(replyInfo.uuid);
        }
      } catch (err) {
        process.stderr.write(`[lag-tg-stop] mirror-all write failed: ${err.message}\n`);
      }
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
    const messagesMeta = []; // [{text, tgMessageId, tgDate, replyToMessageId, boundQuestionId}]
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
        messagesMeta.push({
          text: data.text,
          tgMessageId: data.tgMessageId,
          tgDate: data.tgDate,
          replyToMessageId: data.replyToMessageId,
          boundQuestionId: data.boundQuestionId,
        });
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

    // Auto-ack: push an immediate "received, working on it" message so
    // the operator knows work has started. Default ON; disable by
    // creating the no-auto-ack sentinel file. Summarizes the injected
    // messages without quoting them in full (keeps ack short).
    if (!fs.existsSync(NO_AUTO_ACK_SENTINEL)) {
      try {
        const ackText = formatAck(messages);
        writeOutbox({
          text: ackText,
          at: new Date().toISOString(),
          origin: 'auto-ack',
          ...(chatId !== null ? { chatId } : {}),
        });
      } catch (err) {
        process.stderr.write(`[lag-tg-stop] auto-ack write failed: ${err.message}\n`);
      }
    }

    // Phase 50a: read recent outbound log so we can annotate the
    // inbound messages with causality context (did this reply come
    // BEFORE or AFTER our last question? is it an explicit reply-to?).
    const sentLog = readSentLogTail(SENT_LOG_PATH, 20);
    const causalityNotes = computeCausality(messagesMeta, sentLog);

    // Format the systemMessage-style reinject.
    const bodyLines = [];
    bodyLines.push(
      'LAG: the following message(s) arrived on Telegram from the operator while you were working. ' +
      'Respond to them directly; your reply will be sent back over Telegram automatically.',
    );
    if (causalityNotes.length > 0) {
      bodyLines.push('');
      bodyLines.push('Causality context (Phase 50a):');
      for (const note of causalityNotes) {
        bodyLines.push(`- ${note}`);
      }
    }
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
 * Read the tail of the sent-log (one JSON object per line). Returns
 * newest-first up to `limit` entries.
 */
function readSentLogTail(p, limit) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    const parsed = [];
    for (const line of tail) {
      try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return parsed.reverse(); // newest-first
  } catch {
    return [];
  }
}

/**
 * For each inbound message, compute a causality note describing how
 * it lines up against recent outbound messages. Returns an array of
 * human-readable notes to include in the systemMessage so the agent
 * can reason about Q/A binding.
 */
function computeCausality(messagesMeta, sentLog) {
  const notes = [];
  if (sentLog.length === 0) return notes;
  const mostRecent = sentLog[0];
  const mostRecentSentMs = Date.parse(mostRecent.tgSentAt || mostRecent.sentAt || '');
  for (let i = 0; i < messagesMeta.length; i++) {
    const m = messagesMeta[i];
    if (!m.tgMessageId) continue;
    // Auto-bound by daemon (Phase 50b-live): message is already linked
    // to a pending question atom; agent sees the definitive binding.
    if (m.boundQuestionId) {
      notes.push(
        `AUTO-BOUND: Inbound #${m.tgMessageId} linked to pending question ${m.boundQuestionId} via bindAnswer(). Question transitioned to 'answered'; audit recorded.`,
      );
      continue;
    }
    // Explicit reply-to wins.
    if (typeof m.replyToMessageId === 'number') {
      const target = sentLog.find(s => s.messageId === m.replyToMessageId);
      if (target) {
        notes.push(
          `Inbound #${m.tgMessageId} explicitly replies-to outbound #${target.messageId} ("${(target.textPreview || '').slice(0, 80)}...")`,
        );
      } else {
        notes.push(
          `Inbound #${m.tgMessageId} replies-to unknown message #${m.replyToMessageId} (not in recent sent-log; may be older or manual).`,
        );
      }
      continue;
    }
    // Timestamp sanity.
    const inboundMs = m.tgDate ? Date.parse(m.tgDate) : NaN;
    if (!Number.isFinite(inboundMs) || !Number.isFinite(mostRecentSentMs)) continue;
    if (inboundMs < mostRecentSentMs) {
      const delta = Math.round((mostRecentSentMs - inboundMs) / 1000);
      notes.push(
        `TEMPORAL WARNING: Inbound #${m.tgMessageId} arrived with Telegram date ${delta}s BEFORE our most recent outbound #${mostRecent.messageId} ("${(mostRecent.textPreview || '').slice(0, 80)}..."). This reply likely addresses an EARLIER question. Consider asking for clarification if binding is ambiguous.`,
      );
    } else {
      notes.push(
        `Inbound #${m.tgMessageId} arrived after our most recent outbound #${mostRecent.messageId}; timestamps consistent with answering it.`,
      );
    }
  }
  return notes;
}

function readTextOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeOutbox(payload) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const outFile = path.join(OUTBOX_DIR, `${tsSlug}-${rand}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/**
 * Build a short "received, working on it" ack. For a single short
 * message, echo the first ~80 chars so the operator sees LAG parsed
 * the right thing. For long or multiple messages, just summarize.
 */
function formatAck(messages) {
  const count = messages.length;
  const prefix = 'Got it. Working on it now, will respond here when the work settles.';
  if (count === 0) return prefix;
  const first = messages[0].trim();
  if (count === 1 && first.length <= 120) {
    return `Got it: "${first.replace(/\s+/g, ' ')}". Working on it now; reply incoming.`;
  }
  return `Got it (${count} message${count > 1 ? 's' : ''}, ${first.slice(0, 60).replace(/\s+/g, ' ')}...). Working on it now; reply incoming.`;
}

function persistLastMirrored(uuid) {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.writeFileSync(LAST_MIRRORED_PATH, uuid || '', 'utf8');
  } catch (err) {
    process.stderr.write(`[lag-tg-stop] last-mirrored write failed: ${err.message}\n`);
  }
}

/**
 * Walk the session jsonl and return {text, uuid} of the most recent
 * assistant message (concatenated `text` blocks of the last turn).
 * Returns null if none found.
 *
 * Skips turns produced by this hook itself (the systemMessage turn)
 * so we capture the actual response Claude gave, not the reinject.
 */
function findLastAssistant(transcriptPath) {
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
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : '';
    if (typeof content === 'string') {
      if (content.trim().length > 0) return { text: content, uuid };
      continue;
    }
    if (Array.isArray(content)) {
      const parts = [];
      for (const b of content) {
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
      if (parts.length > 0) return { text: parts.join('\n\n'), uuid };
    }
  }
  return null;
}

// Retained for backward compatibility.
function findLastAssistantText(transcriptPath) {
  const r = findLastAssistant(transcriptPath);
  return r ? r.text : null;
}
