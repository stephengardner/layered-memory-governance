import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSidecarLock,
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
    workspaceId: 'C:/Users/opens/memory-governance',
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
    const atom = buildOperatorSessionAtom(input);
    expect(atom.provenance.kind).toBe('human-asserted');
    expect(atom.provenance.source.session_id).toBe(SID);
    expect(atom.provenance.source.tool).toBe('claude-code-operator-hook');
  });

  it('seeds budget_consumed at zero so live-ops aggregations have a baseline', () => {
    const atom = buildOperatorSessionAtom(input);
    expect(atom.metadata.agent_session.budget_consumed).toEqual({ turns: 0, wall_clock_ms: 0 });
  });

  it('throws on missing principalId so silent-fallback attribution is impossible', () => {
    /*
     * Defense in depth: even if a hook caller forgets the env-var
     * guard, the helper itself rejects empty principal_id rather
     * than minting an atom under a hardcoded id (the bug class PR
     * #170 shipped and CR caught).
     */
    expect(() => buildOperatorSessionAtom({ ...input, principalId: '' })).toThrow(/principalId is required/);
    expect(() => buildOperatorSessionAtom({ ...input, principalId: undefined as unknown as string })).toThrow();
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
    turnIndex: 3,
    toolCallsInWindow: 17,
  };

  it('builds an agent-turn atom that derives_from the session atom', () => {
    const atom = buildOperatorTurnAtom(input);
    expect(atom.type).toBe('agent-turn');
    expect(atom.id).toBe(`agent-turn-op-${SID}-3`);
    expect(atom.provenance.derived_from).toEqual([`agent-session-op-${SID}`]);
    expect(atom.metadata.agent_turn.session_atom_id).toBe(`agent-session-op-${SID}`);
  });

  it('emits canonical AgentTurnMeta shape (turn_index 0-based, llm_input/llm_output/tool_calls/latency_ms)', () => {
    /*
     * Without this the substrate's session-tree projection (which
     * sorts by turn_index) silently breaks. CR caught the
     * non-canonical shape on round 1; pinning the field set in a
     * test prevents regression.
     */
    const atom = buildOperatorTurnAtom(input);
    const meta = atom.metadata.agent_turn;
    expect(meta.turn_index).toBe(3);
    expect(meta).toHaveProperty('llm_input');
    expect(meta).toHaveProperty('llm_output');
    expect(Array.isArray(meta.tool_calls)).toBe(true);
    expect(typeof meta.latency_ms).toBe('number');
    expect(meta.extra.tool_calls_in_window).toBe(17);
    expect(meta.extra.source).toBe('claude-code-operator-hook');
  });

  it('atom-id is deterministic in (session_id, turn_index) so re-emission is idempotent', () => {
    const a = buildOperatorTurnAtom(input);
    const b = buildOperatorTurnAtom(input);
    expect(a.id).toBe(b.id);
  });

  it('accepts turn_index=0 as the first valid turn (canonical 0-based indexing)', () => {
    const atom = buildOperatorTurnAtom({ ...input, turnIndex: 0 });
    expect(atom.id).toBe(`agent-turn-op-${SID}-0`);
    expect(atom.metadata.agent_turn.turn_index).toBe(0);
  });

  it('rejects negative turn_index', () => {
    expect(() => buildOperatorTurnAtom({ ...input, turnIndex: -1 })).toThrow(/non-negative/);
  });

  it('throws on missing principalId', () => {
    expect(() => buildOperatorTurnAtom({ ...input, principalId: '' })).toThrow(/principalId is required/);
  });
});

describe('shouldEmitTurn', () => {
  it('emits the first turn unconditionally', () => {
    expect(shouldEmitTurn(null, 1_000_000, 60_000)).toBe(true);
  });

  it('skips when within the throttle window', () => {
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
    workspaceId: 'C:/Users/opens/memory-governance',
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

describe('acquireSidecarLock', () => {
  /*
   * Real-fs integration: the lock file is created in a per-test
   * temp directory and cleaned up at the end so concurrent test
   * runs do not collide.
   */
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'op-session-lock-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('acquires + releases when no contention', async () => {
    const lock = await acquireSidecarLock(join(tmp, 'session.lock'));
    expect(typeof lock.release).toBe('function');
    await lock.release();
  });

  it('serializes concurrent acquires (second waits for first to release)', async () => {
    /*
     * The two-PostToolUse-fires-at-once case. Without the lock the
     * sidecar read-modify-write would race and two atoms with the
     * same id could be minted.
     */
    const path = join(tmp, 'session.lock');
    const a = await acquireSidecarLock(path);
    const order: string[] = [];
    const bPromise = acquireSidecarLock(path, { backoffMs: 5, maxRetries: 200 }).then((b) => {
      order.push('b-acquired');
      return b.release();
    });
    order.push('a-holding');
    await new Promise((r) => setTimeout(r, 50));
    await a.release();
    await bPromise;
    expect(order).toEqual(['a-holding', 'b-acquired']);
  });

  it('release is best-effort; missing lock file does not throw', async () => {
    const path = join(tmp, 'session.lock');
    const a = await acquireSidecarLock(path);
    await a.release();
    /*
     * Releasing a second time should not blow up: a concurrent
     * crash may have unlinked the file already.
     */
    await a.release();
  });
});

// Vitest globals shim (we use describe/it/expect/beforeEach/afterEach without
// `import { ... } from 'vitest'` for the latter two so Vitest's globals are
// available; the project's vitest config has globals: false so import them).
import { beforeEach, afterEach } from 'vitest';
