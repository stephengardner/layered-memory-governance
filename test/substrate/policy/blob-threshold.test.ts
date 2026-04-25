import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  BLOB_THRESHOLD_DEFAULT,
  BLOB_THRESHOLD_MIN,
  BLOB_THRESHOLD_MAX,
} from '../../../src/substrate/agent-budget.js';
import {
  loadBlobThreshold,
  blobThresholdAtomId,
} from '../../../src/substrate/policy/blob-threshold.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-04-25T00:00:00.000Z' as Time;

function mkPolAtom(id: AtomId, threshold: unknown, taint: 'clean' | 'tainted' = 'clean'): Atom {
  return {
    schema_version: 1, id, content: 'pol', type: 'preference', layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'operator' }, derived_from: [] },
    confidence: 1, created_at: NOW, last_reinforced_at: NOW, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'verified', last_validated_at: null },
    principal_id: 'operator' as PrincipalId, taint,
    metadata: { kind: 'pol-blob-threshold', target_principal: 'cto-actor', threshold_bytes: threshold },
  } as Atom;
}

describe('loadBlobThreshold', () => {
  it('returns BLOB_THRESHOLD_DEFAULT when no atom exists', async () => {
    const host = createMemoryHost();
    expect(await loadBlobThreshold(host.atoms, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_DEFAULT);
  });

  it('clamps threshold below minimum', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 0));
    expect(await loadBlobThreshold(host.atoms, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_MIN);
  });

  it('clamps threshold above maximum', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 100_000_000));
    expect(await loadBlobThreshold(host.atoms, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_MAX);
  });

  it('returns valid threshold inside bounds', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 8192));
    expect(await loadBlobThreshold(host.atoms, 'cto-actor' as PrincipalId, 'code-author')).toBe(8192);
  });

  it('tainted atom falls back to default', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 8192, 'tainted'));
    expect(await loadBlobThreshold(host.atoms, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_DEFAULT);
  });

  it('throws on non-number threshold (silent coercion is a security risk)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 'big'));
    await expect(loadBlobThreshold(host.atoms, 'cto-actor' as PrincipalId, 'code-author')).rejects.toThrow(/threshold/);
  });
});
