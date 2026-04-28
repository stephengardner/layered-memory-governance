/**
 * Pure helpers for the operator-claude-code session pulse hooks.
 *
 * The operator's `claude` terminal session is conceptually an
 * agent-session: a principal (the operator, via `apex-agent`) acting
 * through a Claude Code instance. The substrate already has primitives
 * for that shape (agent-session + agent-turn atoms shipped in PR1
 * #166); these hooks emit those atoms from claude-code lifecycle hooks
 * so the pulse dashboard reflects operator-led activity uniformly with
 * agent-loop activity.
 *
 * Substrate-pure rationale: a new `operator-session` atom type would
 * bifurcate the substrate (agent vs operator activity become two
 * surfaces, every consumer reasons about both). Reusing agent-session
 * keeps the substrate uniform; consumers that care about
 * principal-shape filter on `principal_id` (apex-agent vs the
 * autonomous actors), which is a query concern not a schema concern.
 *
 * This module is pure: no I/O, no env reads, no clock reads at module
 * scope. The hook scripts that call it own all side effects so vitest
 * can exercise the atom shapes without spinning up a host.
 */

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
 * @property {string} sessionId       - Claude Code session UUID; becomes part of the atom id
 * @property {string} principalId     - apex-agent for operator sessions
 * @property {string} startedAt       - ISO timestamp
 * @property {string} workspaceId     - cwd at session start (informational; tracks where the session ran)
 * @property {string} modelId         - claude model id (best-effort; not always known from a hook)
 * @property {string} adapterId       - 'claude-code-operator-hook' for operator sessions
 */

/**
 * Build an agent-session atom for an operator-led claude-code session.
 * The atom-id is deterministic in `sessionId` so a SessionStart fired
 * twice for the same Claude Code session_id (e.g., on `--resume`)
 * lands on the same atom and stays idempotent under FileHost's
 * write-or-overwrite semantics.
 *
 * @param {BuildSessionInput} input
 */
export function buildOperatorSessionAtom(input) {
  const id = operatorSessionAtomId(input.sessionId);
  return {
    schema_version: 1,
    id,
    content: `Operator-led Claude Code session ${input.sessionId} (principal=${input.principalId}, workspace=${input.workspaceId}).`,
    type: 'agent-session',
    layer: 'L0',
    provenance: {
      kind: 'human-asserted',
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
 * @property {string} sessionId       - Claude Code session UUID
 * @property {string} sessionAtomId   - The parent agent-session atom's id (for derived_from)
 * @property {string} principalId
 * @property {string} startedAt       - ISO timestamp of the heartbeat
 * @property {string} completedAt     - same as startedAt for hook-driven heartbeats
 * @property {string} modelId
 * @property {number} turnNumber      - monotonically increasing per session
 * @property {number} toolCallsInWindow - tool calls observed since the previous heartbeat
 */

/**
 * Build an agent-turn atom representing a heartbeat-window of operator
 * activity. The atom-id is deterministic in `(sessionId, turnNumber)`
 * so a re-run of the same heartbeat is idempotent.
 *
 * Each heartbeat covers a throttled time window (default 60s); the
 * `toolCallsInWindow` count carries the underlying activity rate
 * without flooding the atom-store with one atom per tool call.
 *
 * @param {BuildTurnInput} input
 */
export function buildOperatorTurnAtom(input) {
  return {
    schema_version: 1,
    id: `agent-turn-op-${input.sessionId}-${input.turnNumber}`,
    content: `Operator session heartbeat ${input.turnNumber} (tool_calls_in_window=${input.toolCallsInWindow}).`,
    type: 'agent-turn',
    layer: 'L0',
    provenance: {
      kind: 'human-asserted',
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
        turn_number: input.turnNumber,
        model_id: input.modelId,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        tool_calls: [],
      },
      tool_calls_in_window: input.toolCallsInWindow,
    },
  };
}

/**
 * Decide whether the PostToolUse hook should emit a fresh agent-turn
 * atom now, or skip and just bump the in-memory tool count.
 *
 * Throttle prevents one-atom-per-tool-call (a 200-tool session would
 * otherwise mint 200 atoms); a 60s window emits ~1 atom/minute while
 * preserving activity rate via tool_calls_in_window.
 *
 * Pure: no clock or fs access; caller passes ms timestamps.
 *
 * @param {number|null} lastTurnAtMs  - epoch ms of the last emitted turn, or null if no turn yet
 * @param {number} nowMs              - current epoch ms
 * @param {number} throttleMs         - minimum gap between turns
 * @returns {boolean}
 */
export function shouldEmitTurn(lastTurnAtMs, nowMs, throttleMs) {
  if (lastTurnAtMs === null) return true;
  return nowMs - lastTurnAtMs >= throttleMs;
}

/**
 * Apply session-end fields to an existing agent-session atom.
 * The Stop hook calls this at session termination so the dashboard's
 * "active sessions" query stops listing this session.
 *
 * Returns a new atom (does not mutate input) so callers preserve the
 * pure-function contract on the atom shape.
 *
 * @param {object} sessionAtom
 * @param {{ completedAt: string, terminalState?: 'completed'|'aborted'|'errored' }} input
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
 * Parse the hook stdin payload. Hooks receive a JSON object on stdin
 * with `session_id`, `cwd`, etc. Returns null on invalid input so
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
