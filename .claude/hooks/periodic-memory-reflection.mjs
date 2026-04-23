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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag', 'session-memory-reflection');

const DEFAULT_EVERY = 25;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function getEvery() {
  const raw = process.env['LAG_MEMORY_REFLECTION_EVERY'];
  if (raw === undefined || raw === '') return DEFAULT_EVERY;
  // Strict integer: reject '5x', '1.5', '08', ' 5 ', etc. A
  // malformed operator override should fall back to the default
  // cadence, not silently degrade to parseInt's partial-prefix
  // interpretation.
  if (!/^[1-9]\d*$/.test(raw)) return DEFAULT_EVERY;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_EVERY;
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

/**
 * Per-session read-modify-write on the counter file must be
 * serialized. Two concurrent PostToolUse processes for the same
 * session (parallel tool calls, or Claude Code's internal fan-out)
 * would otherwise both read the same count and both write the
 * same incremented value, losing increments and shifting the
 * Nth-call cadence. The org-scale clause of
 * `dev-indie-floor-org-ceiling` makes this a load-bearing
 * correctness concern at 50+ concurrent actors.
 *
 * Implementation mirrors `.claude/hooks/seed-canon-on-session.mjs`:
 * atomic `openSync(path, 'wx')` on a sibling `.lock` file, with a
 * stale-lock reclaim so a crashed holder can't wedge the session.
 * Wait is bounded; on timeout we return null (hook fails open - no
 * prompt injected, but the tool call proceeds).
 */
// LOCK_WAIT_MS scaled up from 5s to 15s after Windows CI flaked a
// second time on the counter-serialization test despite previous
// bumps. Root cause: thundering-herd on the poll loop. 10 contenders
// polling every 25ms retry in near-lockstep; one winner per 25ms
// slice means the 10th contender can spin 9 slices minimum, plus
// scheduler jitter. A 2-core Windows runner with antivirus scanning
// the lock file can extend each openSync(wx) by tens of ms, and the
// cumulative wait exceeded 5s in the PR #117 + #122 re-runs. 15s is
// 3x the observed max under contention, still well under the hook's
// own runtime budget.
//
// The polling strategy itself also adds jitter now: after an EEXIST
// miss, the next wait is LOCK_POLL_MS_BASE + random(0, LOCK_POLL_MS_BASE).
// This breaks lockstep retries so contenders spread their next-try
// time across a window instead of all hitting the same poll tick.
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS_BASE = 20;
const LOCK_STALE_MS = 10_000;

// Codes that mean "retry, the filesystem is busy but not broken":
//   EEXIST   - the lock file already exists (another hook holds the lock)
//   EACCES   - Windows AV or another process has the file momentarily
//              handle-blocked; transient, clears within ms
//   EPERM    - Windows permission denied during AV rescan on a just-closed
//              file; transient, same class as EACCES
//   EBUSY    - Windows "file is in use" during rapid create/unlink cycles;
//              transient, same class
// Anything else (EISDIR, ENOSPC, etc.) is a real error and should bubble.
const RETRYABLE_LOCK_CODES = new Set(['EEXIST', 'EACCES', 'EPERM', 'EBUSY']);

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return true;
    } catch (err) {
      // Prior bug: this branch only retried on EEXIST and threw on any
      // other code. On Windows, AV processes scanning the just-created
      // lock file surface EACCES/EPERM/EBUSY for a few ms at a time. The
      // throw exited acquireLock early, leaving the retry budget unused
      // and dropping the increment. The "raise LOCK_WAIT_MS" bumps that
      // previously targeted this flake were masking this root cause;
      // they never helped because the retry loop didn't run at all.
      // Treat the known-transient Windows codes as equivalent to EEXIST.
      if (!RETRYABLE_LOCK_CODES.has(err?.code)) throw err;
      if (err?.code === 'EEXIST') {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
      }
      // Async sleep yields to the event loop so contending processes
      // on the same core make progress. A synchronous busy-wait here
      // pegs CPU: with 10 concurrent PostToolUse processes on a 2-core
      // Windows runner, the spin kept every contender hot and none
      // could complete their write inside LOCK_WAIT_MS, dropping all
      // increments. setTimeout/await releases the core so the lock
      // holder finishes quickly.
      //
      // Jitter: LOCK_POLL_MS_BASE * (1 + random()) sleeps somewhere
      // between base and 2*base ms, breaking the lockstep retry
      // pattern that caused the thundering-herd flake on Windows CI.
      const jitter = Math.floor(Math.random() * LOCK_POLL_MS_BASE);
      await sleep(LOCK_POLL_MS_BASE + jitter);
    }
  }
  return false;
}

function releaseLock(lockPath) {
  // Best-effort unlink with one retry. Windows AV can hold the lock
  // file for a few ms right after close, surfacing EACCES/EPERM on the
  // first unlink. If that happens and we give up, the lock file
  // lingers until LOCK_STALE_MS; any contender during that window
  // waits longer than necessary. One quick retry covers the common
  // case without introducing a second async dependency.
  try {
    unlinkSync(lockPath);
    return;
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    if (!RETRYABLE_LOCK_CODES.has(err?.code)) return;
  }
  try { unlinkSync(lockPath); } catch { /* best effort, stale reclaim handles it */ }
}

async function bumpCounter(sessionId) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    return null;
  }
  const path = resolve(STATE_DIR, `${sessionId}.json`);
  const lockPath = resolve(STATE_DIR, `${sessionId}.lock`);

  if (!(await acquireLock(lockPath))) return null;
  try {
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
  } finally {
    releaseLock(lockPath);
  }
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
  const count = await bumpCounter(sessionId);
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
