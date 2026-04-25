import { describe, it, expect } from 'vitest';
import type { Atom, AtomId, PrincipalId } from '../../src/substrate/types.js';
import type { AgentSessionMeta, AgentTurnMeta, BlobRef } from '../../src/substrate/types.js';

describe('AtomType union: agent-session + agent-turn', () => {
  it('accepts agent-session as a type', () => {
    const a: Atom = {
      schema_version: 1,
      id: 'agent-session-test' as AtomId,
      content: 'session content',
      type: 'agent-session',
      layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'test-principal' }, derived_from: [] },
      confidence: 1,
      created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'test-principal' as PrincipalId,
      taint: 'clean',
      metadata: { agent_session: { model_id: 'claude-opus-4-7', adapter_id: 'claude-code-agent-loop', workspace_id: 'ws-1', started_at: '2026-04-25T00:00:00.000Z', terminal_state: 'completed', replay_tier: 'content-addressed', budget_consumed: { turns: 5, wall_clock_ms: 12000 } } satisfies AgentSessionMeta },
    };
    expect(a.type).toBe('agent-session');
  });

  it('accepts agent-turn as a type', () => {
    const t: Atom = {
      schema_version: 1,
      id: 'agent-turn-test' as AtomId,
      content: 'turn content',
      type: 'agent-turn',
      layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'test-principal' }, derived_from: ['agent-session-test' as AtomId] },
      confidence: 1,
      created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'test-principal' as PrincipalId,
      taint: 'clean',
      metadata: { agent_turn: { session_atom_id: 'agent-session-test' as AtomId, turn_index: 0, llm_input: { inline: 'input' }, llm_output: { inline: 'output' }, tool_calls: [], latency_ms: 1200 } satisfies AgentTurnMeta },
    };
    expect(t.type).toBe('agent-turn');
  });

  it('BlobRef is a branded type that requires the brand', () => {
    const b: BlobRef = 'sha256:abc' as BlobRef;
    expect(typeof b).toBe('string');
  });
});

