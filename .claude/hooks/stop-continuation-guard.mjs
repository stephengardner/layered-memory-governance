#!/usr/bin/env node
/**
 * Stop hook: block a premature agent stop when the assistant's last
 * message claimed it was about to do something but did nothing.
 *
 * Problem this addresses:
 *   In auto mode the agent sometimes writes "proceeding with X" or
 *   "starting Y now" and then stops without making any tool calls.
 *   From the operator's perspective that's a silent failure: the
 *   intent was declared but not executed. The Stop event is the right
 *   place to catch it -- we can inspect the turn that's about to end
 *   and short-circuit the stop with a structured reason.
 *
 * Mechanism (Claude Code Stop hook protocol):
 *   - Receives JSON on stdin: { transcript_path, session_id, stop_hook_active }
 *   - Reads the transcript jsonl, finds the LAST assistant message
 *   - Checks two things:
 *       (a) does the text contain a continuation-claim phrase?
 *       (b) does the message have zero tool_use blocks?
 *   - If both are true AND stop_hook_active is not already true
 *     (avoid infinite re-enter), emit JSON to stdout with
 *     {"decision":"block","reason":"..."} so Claude Code forwards the
 *     reason back into the conversation and the agent continues.
 *
 * Guardrails:
 *   - stop_hook_active check prevents loops (Claude Code sets this
 *     true when the hook has already blocked once this session).
 *   - Defensive parsing: anything unexpected -> allow the stop
 *     (fail-open). This hook must never wedge a session.
 *   - Log to stderr (surfaces in /hooks debug) but do not crash.
 */

import { readFile } from 'node:fs/promises';

// Phrases that signal "I'm about to do something" without actually doing it.
// Kept tight to reduce false positives on genuine narrative sentences.
const CONTINUATION_PATTERNS = [
  /\bproceeding (with|now|to)\b/i,
  /\bstarting (phase|the|on|with|task|#)/i,
  /\bbuilding (phase|#|task)/i,
  /\blet me (now|proceed|start|build|ship|commit|push|run)/i,
  /\bi(?:['’]ll|['’]?m going to|\s+will)\s+(now|go|proceed|start|build|ship|commit|push|run|execute|continue)\b/i,
  /\bnext\s*(?:,|:)?\s*i(?:['’]ll|['’]?m going to|\s+will)\b/i,
  /\bmoving on to\b/i,
  /\bcontinuing with\b/i,
  /\bkicking off\b/i,
  /\bfiring off\b/i,
  /\bon deck\b.*\bnow\b/i,
  /\bshipping (?:that|this|it|them|the)\b.*\bnow\b/i,
];

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    // Malformed stdin -> allow the stop.
    process.exit(0);
  }

  // Avoid loops: if the Stop hook is already active in this session,
  // the previous block didn't produce tool calls either. Let it go
  // to avoid wedging.
  if (payload.stop_hook_active === true) {
    process.exit(0);
  }

  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    process.exit(0);
  }

  let transcript;
  try {
    transcript = await readFile(transcriptPath, 'utf8');
  } catch {
    process.exit(0);
  }

  const lastAssistant = findLastAssistantMessage(transcript);
  if (!lastAssistant) {
    process.exit(0);
  }

  const { text, hasToolUse } = lastAssistant;
  if (hasToolUse) {
    // The turn did SOMETHING; not a premature stop.
    process.exit(0);
  }

  const claim = detectContinuationClaim(text);
  if (claim === null) {
    // No continuation claim; the stop is legitimate.
    process.exit(0);
  }

  // Block: return the claim in the reason so the agent knows what
  // it said it would do. Claude Code prints the reason to stderr
  // and re-enters the turn with the block reason visible.
  const reason =
    `Stop blocked: the previous turn said "${claim}" but made no tool calls. ` +
    `Execute what you said you were going to do. If the work is genuinely complete, ` +
    `say so explicitly (e.g., "done" / "awaiting direction") instead of announcing an action.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

/**
 * Walk the transcript jsonl backwards and return the last assistant
 * message's combined text + whether any tool_use blocks were present.
 * Shape of Claude Code transcripts:
 *   each line is a JSON object with `role` or `type` indicating kind.
 */
function findLastAssistantMessage(transcript) {
  const lines = transcript.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isAssistantEntry(parsed)) continue;
    return extractAssistantText(parsed);
  }
  return null;
}

function isAssistantEntry(entry) {
  if (entry == null || typeof entry !== 'object') return false;
  // Modern Claude Code transcripts use nested shapes:
  //   { type: 'assistant', message: { role: 'assistant', content: [...] } }
  if (entry.type === 'assistant' && entry.message) return true;
  // Older or plain shape:
  //   { role: 'assistant', content: [...] }
  if (entry.role === 'assistant') return true;
  return false;
}

function extractAssistantText(entry) {
  const msg = entry.message && typeof entry.message === 'object' ? entry.message : entry;
  const content = msg.content;
  let text = '';
  let hasToolUse = false;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
      }
    }
  }
  return { text, hasToolUse };
}

function detectContinuationClaim(text) {
  // Take the last ~500 chars -- continuation claims live near the end.
  const tail = text.length > 500 ? text.slice(text.length - 500) : text;
  for (const pattern of CONTINUATION_PATTERNS) {
    const m = tail.match(pattern);
    if (m) return m[0].trim();
  }
  return null;
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

main().catch((err) => {
  // Fail-open: never wedge the session because of a hook bug.
  // eslint-disable-next-line no-console
  console.error('[stop-continuation-guard] unexpected error, allowing stop:', err?.message || err);
  process.exit(0);
});
