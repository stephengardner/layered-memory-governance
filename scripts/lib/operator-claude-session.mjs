/**
 * Pure helpers for the operator-claude-code session pulse hooks.
 *
 * The operator's `claude` terminal session is conceptually an
 * agent-session: a principal (the operator) acting through a Claude
 * Code instance. The substrate already has primitives for that shape
 * (agent-session + agent-turn atoms shipped in PR1 #166); these hooks
 * emit those atoms from claude-code lifecycle hooks so the pulse
 * dashboard reflects operator-led activity uniformly with agent-loop
 * activity.
 *
 * Substrate-pure rationale: a new `operator-session` atom type would
 * bifurcate the substrate (agent vs operator activity become two
 * surfaces, every consumer reasons about both). Reusing agent-session
 * keeps the substrate uniform; consumers that care about
 * principal-shape filter on `principal_id`, which is a query concern
 * not a schema concern.
 *
 * This module is mostly pure: most exports take primitives in,
 * produce data out, and have no I/O. The two exceptions are
 * `acquireSidecarLock` (takes a path; touches the filesystem) and
 * `readHookStdin` (takes an optional readable stream parameter,
 * defaulting to `process.stdin`; consumes the stream). Both surface
 * the I/O as an explicit parameter so tests can inject fakes; the
 * hook scripts pass the production defaults.
 */

import { open, stat, unlink } from 'node:fs/promises';

/*
 * Stale-lock threshold. A hook process that crashes mid-lock would
 * leave the .lock file behind and block every subsequent
 * PostToolUse for that session_id forever. 10s is well above the
 * actual hold-time of a healthy hook (~tens of milliseconds for a
 * single read-modify-write) and well under any cadence a human
 * would notice.
 */
const STALE_LOCK_MS = 10_000;

/**
 * @typedef {Object} HookPayload
 * @property {string} session_id    - Claude Code session UUID
 * @property {string=} transcript_path
 * @property {string=} cwd
 * @property {string=} hook_event_name
 * @property {string=} tool_name     - PostToolUse only
 * @property {boolean=} stop_hook_active - Stop only
 */

/**
 * @typedef {Object} BuildSessionInput
 * @property {string} sessionId
 * @property {string} principalId   - Required; caller must validate before call (no fallback)
 * @property {string} startedAt
 * @property {string} workspaceId
 * @property {string} modelId
 * @property {string} adapterId
 */

/**
 * Build an agent-session atom for an operator-led claude-code session.
 * Atom-id is deterministic in `sessionId` so a re-fired SessionStart
 * (e.g., on `--resume`) lands on the same atom and stays idempotent
 * under FileHost's write-or-overwrite semantics.
 *
 * Caller MUST pass a non-empty principalId. The hook layer guards
 * against missing LAG_OPERATOR_ID before reaching this function so
 * operator-led atoms cannot land under a hardcoded fallback id (the
 * exact silent-default class of bug PR #170 shipped and CR caught).
 *
 * @param {BuildSessionInput} input
 */
export function buildOperatorSessionAtom(input) {
  if (!input.principalId || input.principalId.length === 0) {
    throw new Error('buildOperatorSessionAtom: principalId is required (no fallback)');
  }
  const id = operatorSessionAtomId(input.sessionId);
  return {
    schema_version: 1,
    id,
    content: `Operator-led Claude Code session ${input.sessionId} (principal=${input.principalId}, workspace=${input.workspaceId}).`,
    type: 'agent-session',
    layer: 'L0',
    provenance: {
      kind: 'user-directive',
      source: {
        tool: 'claude-code-operator-hook',
        agent_id: input.principalId,
        session_id: input.sessionId,
      },
      derived_from: [],
    },
    confidence: 1,
    created_at: input.startedAt,
    last_reinforced_at: input.startedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'session',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: input.principalId,
    taint: 'clean',
    metadata: {
      session_id: input.sessionId,
      started_at: input.startedAt,
      workspace_id: input.workspaceId,
      agent_session: {
        model_id: input.modelId,
        adapter_id: input.adapterId,
        workspace_id: input.workspaceId,
        started_at: input.startedAt,
        /*
         * terminal_state is a placeholder at session start. The
         * canonical AgentSessionMeta enum is
         * 'completed' | 'budget-exhausted' | 'error' | 'aborted'
         * (no 'running' state by design: agent-loop sessions are
         * written ONCE on termination per
         * src/substrate/types.ts:#agent-session). For the
         * hook-driven operator path there's no equivalent
         * finalize step -- pulse infers liveness via
         * `metadata.ended_at === null`, not via terminal_state --
         * so we seed 'completed' to match the existing
         * `examples/agent-loops/claude-code/loop.ts` pattern that
         * does the same at session start and updates in finally.
         */
        terminal_state: 'completed',
        replay_tier: 'session',
        budget_consumed: { turns: 0, wall_clock_ms: 0 },
      },
    },
  };
}

export function operatorSessionAtomId(sessionId) {
  return `agent-session-op-${sessionId}`;
}

/**
 * @typedef {Object} BuildTurnInput
 * @property {string} sessionId
 * @property {string} sessionAtomId
 * @property {string} principalId   - Required; caller must validate
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {string} modelId
 * @property {number} turnIndex     - 0-based, canonical AgentTurnMeta naming
 * @property {number} toolCallsInWindow - tool calls observed since the prior heartbeat
 */

/**
 * Build an agent-turn atom representing a heartbeat-window of operator
 * activity, conforming to the canonical AgentTurnMeta shape so the
 * substrate's session-tree projection (which sorts by turn_index) and
 * any future replay-tier validators see operator turns the same as
 * agent-loop turns.
 *
 * Heartbeats have no LLM call so llm_input/llm_output/tool_calls are
 * minimal placeholders and latency_ms is 0; the actual activity-rate
 * signal lives under `extra.tool_calls_in_window` so consumers that
 * care can read it via the canonical AgentTurnMeta.extra slot
 * (operator-namespaced).
 *
 * @param {BuildTurnInput} input
 */
export function buildOperatorTurnAtom(input) {
  if (!input.principalId || input.principalId.length === 0) {
    throw new Error('buildOperatorTurnAtom: principalId is required (no fallback)');
  }
  if (typeof input.turnIndex !== 'number' || input.turnIndex < 0 || !Number.isFinite(input.turnIndex)) {
    throw new Error(`buildOperatorTurnAtom: turnIndex must be a non-negative finite number (got ${input.turnIndex})`);
  }
  return {
    schema_version: 1,
    id: `agent-turn-op-${input.sessionId}-${input.turnIndex}`,
    content: `Operator session heartbeat ${input.turnIndex} (tool_calls_in_window=${input.toolCallsInWindow}).`,
    type: 'agent-turn',
    layer: 'L0',
    provenance: {
      kind: 'user-directive',
      source: {
        tool: 'claude-code-operator-hook',
        agent_id: input.principalId,
        session_id: input.sessionId,
      },
      derived_from: [input.sessionAtomId],
    },
    confidence: 1,
    created_at: input.startedAt,
    last_reinforced_at: input.startedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'session',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: input.principalId,
    taint: 'clean',
    metadata: {
      session_id: input.sessionId,
      started_at: input.startedAt,
      completed_at: input.completedAt,
      agent_turn: {
        session_atom_id: input.sessionAtomId,
        turn_index: input.turnIndex,
        llm_input: { inline: '' },
        llm_output: { inline: 'operator-heartbeat' },
        tool_calls: [],
        latency_ms: 0,
        extra: {
          source: 'claude-code-operator-hook',
          tool_calls_in_window: input.toolCallsInWindow,
          model_id: input.modelId,
        },
      },
    },
  };
}

/**
 * Decide whether the PostToolUse hook should emit a fresh agent-turn
 * atom now, or skip and just bump the in-memory tool count. Throttle
 * keeps a 200-call session at ~3-5 atoms while preserving activity
 * rate via tool_calls_in_window.
 *
 * Pure: no clock or fs access; caller passes ms timestamps.
 *
 * @param {number|null} lastTurnAtMs
 * @param {number} nowMs
 * @param {number} throttleMs
 * @returns {boolean}
 */
export function shouldEmitTurn(lastTurnAtMs, nowMs, throttleMs) {
  if (lastTurnAtMs === null) return true;
  return nowMs - lastTurnAtMs >= throttleMs;
}

/**
 * Apply session-end fields to an existing agent-session atom. Returns
 * a new atom (does not mutate input) so callers preserve the
 * pure-function contract.
 *
 * Note: this PR does NOT call this from a Stop hook. Claude Code's
 * Stop event fires on every assistant yield, not on real session
 * termination, so finalizing on every Stop would clobber the session
 * atom mid-flight. The helper is preserved for a future SessionEnd
 * (or equivalent terminal) signal.
 *
 * @param {object} sessionAtom
 * @param {{ completedAt: string, terminalState?: 'completed'|'aborted'|'error'|'budget-exhausted' }} input
 */
export function withSessionCompletion(sessionAtom, input) {
  const terminalState = input.terminalState ?? 'completed';
  return {
    ...sessionAtom,
    last_reinforced_at: input.completedAt,
    metadata: {
      ...sessionAtom.metadata,
      ended_at: input.completedAt,
      agent_session: {
        ...(sessionAtom.metadata?.agent_session ?? {}),
        completed_at: input.completedAt,
        terminal_state: terminalState,
      },
    },
  };
}

/**
 * Read the hook's stdin payload to a string. Resolves with the full
 * utf-8 payload (or '' on EOF without data). Rejects on stream error
 * so the caller's outer try/catch can fail-open rather than crash
 * silently.
 *
 * Extracted at N=2 per canon `dev-extract-helpers-at-N-2-plus-one`
 * (each of the hook scripts otherwise carries an identical copy).
 * Takes an optional readable stream so tests can inject a fake
 * (default: `process.stdin` for production hook callers).
 *
 * @param {NodeJS.ReadableStream} [stream=process.stdin]
 * @returns {Promise<string>}
 */
export function readHookStdin(stream = process.stdin) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * Parse the hook stdin payload. Returns null on invalid input so
 * callers can fail-open (allow the session to continue) rather than
 * wedging Claude Code on a malformed hook payload.
 *
 * @param {string} raw
 * @returns {HookPayload|null}
 */
export function parseHookPayload(raw) {
  if (!raw || raw.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (typeof parsed.session_id !== 'string' || parsed.session_id.length === 0) return null;
  return parsed;
}

/**
 * Acquire an exclusive sidecar lock by O_EXCL-creating a `.lock` file
 * at `lockPath`. Retries on EEXIST with backoff so two PostToolUse
 * hooks firing concurrently for the same session serialize cleanly.
 * Returns a release function the caller MUST invoke (in finally) so
 * the lock does not outlive the holder.
 *
 * Cross-platform: `wx` flag (write + exclusive create) is honored on
 * both POSIX and NTFS by Node's `open` syscall.
 *
 * @param {string} lockPath
 * @param {{ maxRetries?: number, backoffMs?: number, staleMs?: number }} [opts]
 *   - maxRetries: how many EEXIST retries before throwing (default 50)
 *   - backoffMs: ms to sleep between retries (default 20)
 *   - staleMs: lock files older than this are reclaimed via unlink + retry (default STALE_LOCK_MS)
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
export async function acquireSidecarLock(lockPath, opts = {}) {
  const maxRetries = opts.maxRetries ?? 50;
  const backoffMs = opts.backoffMs ?? 20;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      return {
        release: async () => {
          try {
            await unlink(lockPath);
          } catch {
            // best-effort: a missing lock file means a concurrent
            // crash already cleaned it; nothing more to do
          }
        },
      };
    } catch (err) {
      lastErr = err;
      /*
       * Cross-platform contention codes when `open(path, 'wx')`
       * hits an existing or held file:
       *   - POSIX: EEXIST
       *   - Windows: EEXIST, EPERM, or EBUSY (varies with
       *     filesystem and how the prior holder closed the file)
       *
       * All three are treated as contention -- retry. A true
       * permission-denied (e.g., the operator lacks write rights
       * to the sidecar dir) WOULD also surface as EPERM here;
       * we rely on `maxRetries` (default 50 with 20ms backoff =
       * ~1s) to bound the loop and surface a clear error rather
       * than wedge.
       *
       * Earlier we tried to distinguish Windows-contention from
       * permission-denied by stat-ing the lock file: if stat said
       * the file was absent, treat as permanent. That breaks
       * under a release-race -- the prior holder's `unlink`
       * during release lands between our open's EPERM and our
       * stat, so stat sees ENOENT for what was actually just
       * contention. The simpler retry-bounded loop is correct.
       */
      const code = err && err.code;
      const isContention = code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY';
      if (!isContention) throw err;
      /*
       * Stale-lock reclamation: a crashed hook would leave the
       * .lock file behind and block every subsequent acquire
       * forever. Stat the existing lock file; if its mtime is
       * older than the stale threshold, unlink it and retry
       * immediately (no backoff sleep) so a recovery proceeds
       * fast. ENOENT during the stat means another concurrent
       * hook just released; fall through to the backoff retry
       * path. Other stat/unlink errors are best-effort: log
       * nothing, just keep retrying.
       */
      try {
        const stats = await stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) {
          try {
            await unlink(lockPath);
            continue;
          } catch {
            // best-effort: another hook may have just released
          }
        }
      } catch {
        // ENOENT (already gone) or other stat error -- fall through
      }
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  /*
   * Lock contention exhausted retries. Rather than wedge the hook
   * (which would block Claude Code), surface the error so the caller's
   * outer try/catch logs to stderr and exits 0 (fail-open).
   */
  throw new Error(`acquireSidecarLock: could not acquire ${lockPath} after ${maxRetries} retries (last: ${lastErr?.message ?? lastErr})`);
}
