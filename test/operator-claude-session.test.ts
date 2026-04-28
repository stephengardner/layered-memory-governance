import { describe, it, expect } from 'vitest';
import {
  buildOperatorSessionAtom,
  buildOperatorTurnAtom,
  operatorSessionAtomId,
  parseHookPayload,
  shouldEmitTurn,
  withSessionCompletion,
} from '../scripts/lib/operator-claude-session.mjs';

const SID = 'a069da55-bb34-4958-b114-b203449db39f';

describe('operatorSessionAtomId', () => {
  it('is deterministic in session_id', () => {
    expect(operatorSessionAtomId(SID)).toBe(`agent-session-op-${SID}`);
    expect(operatorSessionAtomId(SID)).toBe(operatorSessionAtomId(SID));
  });
});

describe('buildOperatorSessionAtom', () => {
  const input = {
    sessionId: SID,
    principalId: 'apex-agent',
    startedAt: '2026-04-28T00:00:00.000Z',
    workspaceId: '/c/Users/opens/memory-governance',
    modelId: 'claude-opus-4-7',
    adapterId: 'claude-code-operator-hook',
  };

  it('produces an atom with type=agent-session and the substrate-uniform shape', () => {
    const atom = buildOperatorSessionAtom(input);
    expect(atom.type).toBe('agent-session');
    expect(atom.layer).toBe('L0');
    expect(atom.principal_id).toBe('apex-agent');
    expect(atom.id).toBe(`agent-session-op-${SID}`);
    expect(atom.metadata.session_id).toBe(SID);
    expect(atom.metadata.agent_session.adapter_id).toBe('claude-code-operator-hook');
  });

  it('records human-asserted provenance with the session_id in source', () => {
    /*
     * The pulse dashboard does not branch on provenance.kind, but
     * downstream queries (taint analysis, audit) do. operator-led
     * sessions are human-asserted (the operator typed); agent-loop
     * sessions are operator-seeded. Distinguishing here keeps that
     * provenance ladder load-bearing.
     */
    const atom = buildOperatorSessionAtom(input);
    expect(atom.provenance.kind).toBe('human-asserted');
    expect(atom.provenance.source.session_id).toBe(SID);
    expect(atom.provenance.source.tool).toBe('claude-code-operator-hook');
  });

  it('seeds budget_consumed at zero so live-ops aggregations have a baseline', () => {
    const atom = buildOperatorSessionAtom(input);
    expect(atom.metadata.agent_session.budget_consumed).toEqual({ turns: 0, wall_clock_ms: 0 });
  });
});

describe('buildOperatorTurnAtom', () => {
  const input = {
    sessionId: SID,
    sessionAtomId: `agent-session-op-${SID}`,
    principalId: 'apex-agent',
    startedAt: '2026-04-28T00:01:00.000Z',
    completedAt: '2026-04-28T00:01:00.000Z',
    modelId: 'claude-opus-4-7',
    turnNumber: 3,
    toolCallsInWindow: 17,
  };

  it('builds an agent-turn atom that derives_from the session atom', () => {
    const atom = buildOperatorTurnAtom(input);
    expect(atom.type).toBe('agent-turn');
    expect(atom.id).toBe(`agent-turn-op-${SID}-3`);
    expect(atom.provenance.derived_from).toEqual([`agent-session-op-${SID}`]);
    expect(atom.metadata.agent_turn.session_atom_id).toBe(`agent-session-op-${SID}`);
    expect(atom.metadata.agent_turn.turn_number).toBe(3);
  });

  it('preserves tool_calls_in_window in metadata for activity-rate analysis', () => {
    const atom = buildOperatorTurnAtom(input);
    expect(atom.metadata.tool_calls_in_window).toBe(17);
  });

  it('atom-id is deterministic in (session_id, turn_number) so re-emission is idempotent', () => {
    const a = buildOperatorTurnAtom(input);
    const b = buildOperatorTurnAtom(input);
    expect(a.id).toBe(b.id);
  });
});

describe('shouldEmitTurn', () => {
  it('emits the first turn unconditionally', () => {
    expect(shouldEmitTurn(null, 1_000_000, 60_000)).toBe(true);
  });

  it('skips when within the throttle window', () => {
    /*
     * 30s after the prior turn with a 60s window: the heartbeat
     * is suppressed. The hook still increments the in-memory
     * tool_count which the next emitted turn carries.
     */
    expect(shouldEmitTurn(1_000_000, 1_030_000, 60_000)).toBe(false);
  });

  it('emits exactly at the boundary (>= throttleMs)', () => {
    expect(shouldEmitTurn(1_000_000, 1_060_000, 60_000)).toBe(true);
  });

  it('emits past the boundary', () => {
    expect(shouldEmitTurn(1_000_000, 1_500_000, 60_000)).toBe(true);
  });
});

describe('withSessionCompletion', () => {
  const base = buildOperatorSessionAtom({
    sessionId: SID,
    principalId: 'apex-agent',
    startedAt: '2026-04-28T00:00:00.000Z',
    workspaceId: '/c/Users/opens/memory-governance',
    modelId: 'claude-opus-4-7',
    adapterId: 'claude-code-operator-hook',
  });

  it('applies completed_at + terminal_state to the agent_session metadata', () => {
    const completed = withSessionCompletion(base, {
      completedAt: '2026-04-28T01:00:00.000Z',
      terminalState: 'completed',
    });
    expect(completed.metadata.agent_session.completed_at).toBe('2026-04-28T01:00:00.000Z');
    expect(completed.metadata.agent_session.terminal_state).toBe('completed');
    expect(completed.metadata.ended_at).toBe('2026-04-28T01:00:00.000Z');
  });

  it('does not mutate the input atom', () => {
    /*
     * Pure-function contract: callers (the Stop hook) read the
     * session atom from the FileHost, apply completion, write back.
     * If withSessionCompletion mutated the input, a re-read of the
     * atom store would see the mutation regardless of write success.
     */
    withSessionCompletion(base, {
      completedAt: '2026-04-28T01:00:00.000Z',
    });
    expect(base.metadata.agent_session.completed_at).toBeUndefined();
  });

  it('defaults terminal_state to completed when caller omits it', () => {
    const completed = withSessionCompletion(base, {
      completedAt: '2026-04-28T01:00:00.000Z',
    });
    expect(completed.metadata.agent_session.terminal_state).toBe('completed');
  });
});

describe('parseHookPayload', () => {
  it('parses a well-formed Claude Code hook payload', () => {
    const raw = JSON.stringify({ session_id: SID, cwd: '/x', hook_event_name: 'PostToolUse' });
    const out = parseHookPayload(raw);
    expect(out?.session_id).toBe(SID);
  });

  it('returns null on empty stdin (fail-open: hook never wedges the session)', () => {
    expect(parseHookPayload('')).toBeNull();
    expect(parseHookPayload('   ')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseHookPayload('{not-json')).toBeNull();
  });

  it('returns null when session_id is missing or not a string', () => {
    expect(parseHookPayload('{}')).toBeNull();
    expect(parseHookPayload(JSON.stringify({ session_id: null }))).toBeNull();
    expect(parseHookPayload(JSON.stringify({ session_id: '' }))).toBeNull();
  });
});
