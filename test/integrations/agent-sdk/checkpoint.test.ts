/**
 * Agent SDK checkpoint save/load.
 *
 * `saveCheckpoint` persists a JSON-serializable messages array as an
 * observation atom (kind='agent-checkpoint') so a paused agent can
 * resume by reloading the atom and feeding its contents back into the
 * SDK. `loadCheckpoint` is the mirror read.
 *
 * These tests pin down:
 *   - saveCheckpoint writes an atom whose content is the JSON-serialized
 *     messages array, and returns the checkpoint id.
 *   - The saved atom is shape-valid: type='observation', kind metadata,
 *     principal_id set to the supplied agent id, derived_from empty,
 *     layer='L0' (transient session state).
 *   - loadCheckpoint round-trips any messages array saveCheckpoint
 *     produced.
 *   - loadCheckpoint throws when the atom does not exist.
 *   - Distinct saveCheckpoint calls produce distinct atom ids so a
 *     running agent can checkpoint repeatedly without collision.
 */
import { describe, expect, it } from 'vitest';

import { MemoryAtomStore } from '../../../src/adapters/memory/atom-store.js';
import {
  loadCheckpoint,
  saveCheckpoint,
} from '../../../src/integrations/agent-sdk/checkpoint.js';
import type { AtomId, PrincipalId } from '../../../src/substrate/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newStore(): MemoryAtomStore {
  return new MemoryAtomStore();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('saveCheckpoint', () => {
  it('writes a checkpoint atom and returns its id', async () => {
    const store = newStore();
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const id = await saveCheckpoint(store, 'agent-a' as PrincipalId, messages);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const atom = await store.get(id as AtomId);
    expect(atom).not.toBeNull();
    expect(atom!.type).toBe('observation');
    expect(atom!.principal_id).toBe('agent-a');
    expect(atom!.layer).toBe('L0');
    expect(atom!.metadata['kind']).toBe('agent-checkpoint');
    expect(JSON.parse(atom!.content)).toEqual(messages);
    expect(atom!.provenance.derived_from).toEqual([]);
  });

  it('produces distinct ids on repeated calls', async () => {
    const store = newStore();
    const id1 = await saveCheckpoint(store, 'agent-a' as PrincipalId, [{ n: 1 }]);
    await new Promise((r) => setTimeout(r, 2));
    const id2 = await saveCheckpoint(store, 'agent-a' as PrincipalId, [{ n: 2 }]);
    expect(id1).not.toBe(id2);
  });

  it('produces distinct ids under same-millisecond concurrent saves (CR #105)', async () => {
    // CR finding PRRT_kwDOSGhm98588lGe: `Date.now()` is millisecond-
    // granular, so two rapid checkpoints for the same agent in the
    // same millisecond collided on id. AtomStore.put() rejects the
    // second with ConflictError, silently losing the checkpoint.
    //
    // Drive the exact failure mode by racing N saves concurrently
    // without any deliberate interleave. If the id generator leans
    // solely on Date.now(), the Set of ids produced will be smaller
    // than the number of saves.
    const store = newStore();
    const N = 20;
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        saveCheckpoint(store, 'agent-race' as PrincipalId, [{ n: i }]),
      ),
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(N);
  });

  it('namespaces the checkpoint id with the agent id', async () => {
    const store = newStore();
    const id = await saveCheckpoint(store, 'vo-cto' as PrincipalId, []);
    expect(id).toContain('vo-cto');
  });
});

describe('loadCheckpoint', () => {
  it('round-trips saved messages', async () => {
    const store = newStore();
    const messages = [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'question two' },
    ];
    const id = await saveCheckpoint(store, 'agent-a' as PrincipalId, messages);

    const loaded = await loadCheckpoint(store, id as AtomId);
    expect(loaded).toEqual(messages);
  });

  it('throws when the checkpoint is missing', async () => {
    const store = newStore();
    await expect(
      loadCheckpoint(store, 'checkpoint-does-not-exist' as AtomId),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects non-checkpoint atoms whose content happens to be a JSON array (CR #105)', async () => {
    // CR finding PRRT_kwDOSGhm98588lGf: loadCheckpoint accepted any
    // atom whose content parsed to an array, so a mistaken id (an
    // unrelated observation or even a list-typed fact) silently
    // resumed an agent from bogus data. Tighten the load path to
    // validate the checkpoint shape (type, layer, metadata.kind).
    const store = newStore();
    const foreignId = 'observation-not-a-checkpoint' as AtomId;
    // Write a valid-in-every-way-else atom that is NOT a checkpoint:
    // content is a JSON array, but metadata.kind is NOT 'agent-checkpoint'.
    await store.put({
      schema_version: 1,
      id: foreignId,
      content: JSON.stringify([{ role: 'user', content: 'not a checkpoint' }]),
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'some-other-agent' },
        derived_from: [],
      },
      confidence: 1,
      created_at: '2026-04-22T00:00:00.000Z',
      last_reinforced_at: '2026-04-22T00:00:00.000Z',
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
      principal_id: 'some-other-agent' as PrincipalId,
      taint: 'clean',
      metadata: { kind: 'something-else' },
    });
    await expect(loadCheckpoint(store, foreignId)).rejects.toThrow(
      /not.*(agent|checkpoint)/i,
    );
  });

  it('rejects atoms whose metadata.kind is missing', async () => {
    const store = newStore();
    const id = 'observation-missing-kind' as AtomId;
    await store.put({
      schema_version: 1,
      id,
      content: JSON.stringify([]),
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'any' },
        derived_from: [],
      },
      confidence: 1,
      created_at: '2026-04-22T00:00:00.000Z',
      last_reinforced_at: '2026-04-22T00:00:00.000Z',
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
      principal_id: 'any' as PrincipalId,
      taint: 'clean',
      metadata: {},
    });
    await expect(loadCheckpoint(store, id)).rejects.toThrow(
      /not.*(agent|checkpoint)/i,
    );
  });
});
