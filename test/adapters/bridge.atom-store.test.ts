/**
 * Unit tests for BridgeAtomStore wrapping + drawer mapping.
 *
 * Real-palace integration is in `bridge.integration.test.ts` (gated by
 * LAG_REAL_PALACE=1). This file exercises only the in-process behavior.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { mapDrawerToAtom, BridgeAtomStore } from '../../src/adapters/bridge/atom-store.js';
import type { AtomId, PrincipalId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'bridge-test' as PrincipalId;

describe('mapDrawerToAtom', () => {
  it('maps id, content, and metadata to atom shape', () => {
    const atom = mapDrawerToAtom(
      {
        id: 'drawer_123',
        document: 'we use postgres',
        metadata: {
          agent: 'alice',
          wing: 'example_backend',
          room: 'decisions',
          session_id: 'sess_42',
          timestamp: '2026-03-01T10:00:00.000Z',
        },
      },
      { defaultPrincipalId: principal, prefix: 'phx_', now: '2026-04-18T00:00:00.000Z' },
    );
    expect(atom.id).toBe('phx_drawer_123');
    expect(atom.content).toBe('we use postgres');
    expect(atom.principal_id).toBe('alice');
    expect(atom.layer).toBe('L1');
    expect(atom.provenance.kind).toBe('agent-observed');
    expect(atom.provenance.source.tool).toBe('bridge-chroma');
    expect(atom.provenance.source.session_id).toBe('sess_42');
    expect(atom.provenance.source.agent_id).toBe('alice');
    expect(atom.created_at).toBe('2026-03-01T10:00:00.000Z');
    expect(atom.taint).toBe('clean');
    expect(atom.metadata['bridge_drawer_id']).toBe('drawer_123');
    expect(atom.metadata['bridge_wing']).toBe('example_backend');
    expect(atom.metadata['bridge_room']).toBe('decisions');
  });

  it('falls back to default principal when drawer has no agent', () => {
    const atom = mapDrawerToAtom(
      { id: 'd1', document: 'text', metadata: {} },
      { defaultPrincipalId: principal },
    );
    expect(atom.principal_id).toBe(principal);
  });

  it('reads principal from alternate metadata field names', () => {
    const byAgentId = mapDrawerToAtom(
      { id: 'd1', document: 'x', metadata: { agent_id: 'bob' } },
      { defaultPrincipalId: principal },
    );
    expect(byAgentId.principal_id).toBe('bob');

    const byPrincipalId = mapDrawerToAtom(
      { id: 'd2', document: 'x', metadata: { principal_id: 'carol' } },
      { defaultPrincipalId: principal },
    );
    expect(byPrincipalId.principal_id).toBe('carol');
  });

  it('uses epoch-zero timestamp when drawer has no created_at', () => {
    const atom = mapDrawerToAtom(
      { id: 'd1', document: 'x', metadata: {} },
      { defaultPrincipalId: principal },
    );
    expect(atom.created_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('uses default prefix "phx_" when not specified', () => {
    const atom = mapDrawerToAtom(
      { id: 'abc', document: 'x', metadata: {} },
      { defaultPrincipalId: principal },
    );
    expect(atom.id).toBe('phx_abc');
  });
});

describe('BridgeAtomStore delegation', () => {
  it('delegates put/get to the backing store', async () => {
    const host = createMemoryHost();
    const bridge = new BridgeAtomStore(host.atoms, { defaultPrincipalId: principal });
    const atom = sampleAtom({ content: 'delegation test' });
    await bridge.put(atom);
    const got = await bridge.get(atom.id);
    expect(got?.content).toBe('delegation test');
  });

  it('delegates query, search, update, embed, similarity, contentHash', async () => {
    const host = createMemoryHost();
    const bridge = new BridgeAtomStore(host.atoms, { defaultPrincipalId: principal });
    await bridge.put(sampleAtom({ id: 'pd1' as AtomId, content: 'bridge delegation', layer: 'L1' }));
    const page = await bridge.query({ layer: ['L1'] }, 10);
    expect(page.atoms.length).toBe(1);
    const hits = await bridge.search('bridge', 5);
    expect(hits[0]?.atom.content).toContain('bridge');
    const updated = await bridge.update('pd1' as AtomId, { confidence: 0.99 });
    expect(updated.confidence).toBe(0.99);
    const v1 = await bridge.embed('hello');
    const v2 = await bridge.embed('hello');
    expect(bridge.similarity(v1, v2)).toBeCloseTo(1, 6);
    expect(bridge.contentHash('a')).toBe(bridge.contentHash('A'));
  });
});
