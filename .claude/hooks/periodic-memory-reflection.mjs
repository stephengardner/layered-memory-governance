#!/usr/bin/env node
/**
 * PostToolUse hook: every Nth tool call, ask Claude to reflect on
 * whether anything from the last batch is worth persisting as
 * memory (user / feedback / project / reference) or as a canon atom
 * via the /decide skill.
 *
 * Why this hook exists
 * --------------------
 * design/session-memory-backbone.md chose `SessionEnd` as the V0
 * automatic-ingest trigger (with `PreCompact` added in V1) and
 * explicitly rejected per-turn capture as "noisy". That ADR is still
 * the right call for AUTOMATIC content ingestion: running an LLM
 * classifier on every tool turn would burn budget on operational
 * chatter.
 *
 * But session-end capture has a blind spot: a long autonomous run
 * that ends via compaction or crash loses mid-session directives,
 * lessons, and preferences unless the agent chose to save them
 * WHILE they were fresh. The PreCompact trigger helps, but it is
 * emergency-triggered; by the time it fires the operator's
 * in-the-moment nudge may already have been summarised out of
 * context.
 *
 * This hook is the complement: a cheap, periodic, agent-directed
 * NUDGE (not an automatic extractor). Every N tool calls (default
 * 25), it injects a short prompt into Claude's context asking:
 * "anything from the last batch worth saving?". If yes, Claude
 * saves via the auto-memory system or `/decide`. If nothing stands
 * out, Claude ignores the prompt and continues.
 *
 * The cost asymmetry matters: one injected line of prompt per 25
 * tool calls is negligible. The upside is catching the atoms that
 * the SessionEnd pipeline would miss because they never made it
 * into the extractable transcript (e.g. operator directives stated
 * in a parallel slack/telegram channel that Claude heard about but
 * hasn't yet atomized).
 *
 * Mechanism
 * ---------
 * PostToolUse fires after every tool call. The hook maintains a
 * per-session counter at `.lag/session-memory-reflection/<id>.json`.
 * When `count % EVERY === 0`, the hook emits a JSON payload with
 * `hookSpecificOutput.additionalContext` that Claude sees as an
 * additional system-style instruction on its next reply.
 *
 * Noise control:
 *   - Default N=25 strikes a balance between "often enough to catch
 *     mid-session atoms" and "rare enough to not drown the agent
 *     in reflection prompts".
 *   - Per-session reset (a new session_id starts a fresh counter).
 *   - Tunable via env LAG_MEMORY_REFLECTION_EVERY (integer > 0).
 *   - Opt-out via env LAG_MEMORY_REFLECTION_DISABLED=1.
 *
 * Safety:
 *   - Safe-session-id regex gates the counter-file path so the
 *     hook cannot be tricked into writing outside the guard dir.
 *   - Fail-open: any parse/IO/env error exits 0 silently. The hook
 *     must never wedge a session.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag', 'session-memory-reflection');

const DEFAULT_EVERY = 25;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function getEvery() {
  const raw = process.env['LAG_MEMORY_REFLECTION_EVERY'];
  if (raw === undefined || raw === '') return DEFAULT_EVERY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVERY;
  return n;
}

function disabled() {
  const raw = process.env['LAG_MEMORY_REFLECTION_DISABLED'];
  return raw === '1' || raw === 'true';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function bumpCounter(sessionId) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    return null;
  }
  const path = resolve(STATE_DIR, `${sessionId}.json`);
  let count = 0;
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.count === 'number' && parsed.count >= 0) {
        count = parsed.count;
      }
    } catch {
      // Corrupt / unreadable - reset.
      count = 0;
    }
  }
  count += 1;
  try {
    writeFileSync(path, JSON.stringify({ count }, null, 2), 'utf8');
  } catch {
    return null;
  }
  return count;
}

function reflectionPrompt(count, every) {
  return [
    `[memory-reflection] Tool call #${count} (nudge every ${every}). **Default: skip this reminder.** Most nudges should no-op.`,
    '',
    'Only act when something HARD happened since the last nudge:',
    '',
    '- The operator STATED a preference/fact (not you inferred) -> auto-memory (user / feedback / project).',
    '- The operator STATED a hard governance rule -> `/decide` (rare; canon writes are load-bearing - skill gate still applies).',
    '- You hit an external system you will touch again -> auto-memory (reference).',
    '',
    'If none of those apply: take no action. Keep going.',
  ].join('\n');
}

async function main() {
  if (disabled()) {
    process.exit(0);
  }

  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Only count tool-call events. Claude Code also fires PostToolUse
  // for non-Bash tools; that is exactly what we want (Edit, Write,
  // Agent dispatches all count as "work units").
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    // No safe session id - we cannot store counter state. Exit
    // silently rather than invent a path.
    process.exit(0);
  }

  const every = getEvery();
  const count = bumpCounter(sessionId);
  if (count === null) process.exit(0);

  if (count % every !== 0) process.exit(0);

  const additionalContext = reflectionPrompt(count, every);
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch(() => process.exit(0));
