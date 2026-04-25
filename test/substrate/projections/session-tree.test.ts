import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { buildSessionTree } from '../../../src/substrate/projections/session-tree.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-04-25T00:00:00.000Z' as Time;

function mkAtom(id: string, type: Atom['type'], derived: string[], metadata: Record<string, unknown>): Atom {
  return {
    schema_version: 1, id: id as AtomId, content: id, type, layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: derived as AtomId[] },
    confidence: 1, created_at: NOW, last_reinforced_at: NOW, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId, taint: 'clean',
    metadata,
  };
}

describe('buildSessionTree', () => {
  it('reconstructs a single-session chain', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkAtom('session-1', 'agent-session', [], { agent_session: { model_id: 'x', adapter_id: 'y', workspace_id: 'w', started_at: NOW, terminal_state: 'completed', replay_tier: 'content-addressed', budget_consumed: { turns: 2, wall_clock_ms: 1000 } } }));
    await host.atoms.put(mkAtom('turn-1', 'agent-turn', ['session-1'], { agent_turn: { session_atom_id: 'session-1', turn_index: 0, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 100 } }));
    await host.atoms.put(mkAtom('turn-2', 'agent-turn', ['session-1'], { agent_turn: { session_atom_id: 'session-1', turn_index: 1, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 200 } }));
    const tree = await buildSessionTree(host.atoms, 'session-1' as AtomId);
    expect(tree.session.id).toBe('session-1');
    expect(tree.turns.length).toBe(2);
    expect(tree.turns[0]?.id).toBe('turn-1');
    expect(tree.turns[1]?.id).toBe('turn-2');
    expect(tree.children.length).toBe(0);
  });

  it('throws when the requested session atom is missing', async () => {
    const host = createMemoryHost();
    await expect(buildSessionTree(host.atoms, 'session-missing' as AtomId)).rejects.toThrow(/not found/);
  });

  it('throws when the requested atom is not an agent-session', async () => {
    const host = createMemoryHost();
    // Use an agent-turn atom in place of an agent-session.
    await host.atoms.put(mkAtom('not-a-session', 'agent-turn', [], { agent_turn: { session_atom_id: 'x' as AtomId, turn_index: 0, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 1 } }));
    await expect(buildSessionTree(host.atoms, 'not-a-session' as AtomId)).rejects.toThrow(/not type/);
  });

  it('orders turns by turn_index, not by created_at', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkAtom('s2', 'agent-session', [], { agent_session: { model_id: 'x', adapter_id: 'y', workspace_id: 'w', started_at: NOW, terminal_state: 'completed', replay_tier: 'content-addressed', budget_consumed: { turns: 2, wall_clock_ms: 1 } } }));
    // Insert in reverse order
    await host.atoms.put(mkAtom('t-second', 'agent-turn', ['s2'], { agent_turn: { session_atom_id: 's2', turn_index: 1, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 1 } }));
    await host.atoms.put(mkAtom('t-first', 'agent-turn', ['s2'], { agent_turn: { session_atom_id: 's2', turn_index: 0, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 1 } }));
    const tree = await buildSessionTree(host.atoms, 's2' as AtomId);
    expect(tree.turns.map((t) => t.id)).toEqual(['t-first', 't-second']);
  });
});
