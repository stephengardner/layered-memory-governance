/**
 * Fence-seed drift-guard tests.
 *
 * The seeder trusts atom-id identity for idempotency; without a drift
 * guard, a tampered or upgraded fence atom sitting in the store would
 * survive rebuild silently. These tests pin the guard shape: fields
 * load-bearing for provenance + policy integrity are compared against
 * the canonical shape, and any mismatch throws loudly.
 *
 * Drift is simulated via a minimal AtomStore stub rather than poking
 * at MemoryAtomStore internals: `MemoryAtomStore.put` rejects duplicate
 * ids (the invariant the drift-guard defends), so we cannot use it to
 * stage a pre-existing drifted atom. The stub returns the drifted atom
 * on the first `get` and verifies the seeder did not attempt to
 * overwrite via `put`.
 */

import { describe, expect, it } from 'vitest';

import {
  FENCE_ATOM_IDS,
  seedFenceAtoms,
} from '../../../src/examples/virtual-org-bootstrap/fence-seed.js';
import { MemoryAtomStore } from '../../../src/adapters/memory/atom-store.js';
import type { AtomStore } from '../../../src/substrate/interface.js';
import type { Atom, AtomId, PrincipalId } from '../../../src/substrate/types.js';

const OPERATOR = 'test-operator' as PrincipalId;

/**
 * Build a store pre-seeded with the canonical fence atoms, then
 * return its current snapshot of a given atom id. Used so each drift
 * test starts from a known-good shape and mutates exactly one field.
 */
async function canonicalAtom(id: AtomId): Promise<Atom> {
  const store = new MemoryAtomStore();
  await seedFenceAtoms(store, OPERATOR);
  const atom = await store.get(id);
  if (atom === null) {
    throw new Error(`test setup: canonical fence atom ${id} missing`);
  }
  return atom;
}

/**
 * Return the canonical (non-drifted) shape for every fence atom id,
 * keyed by id.
 */
async function canonicalFenceAtoms(): Promise<ReadonlyMap<string, Atom>> {
  const store = new MemoryAtomStore();
  await seedFenceAtoms(store, OPERATOR);
  const out = new Map<string, Atom>();
  for (const id of FENCE_ATOM_IDS) {
    const atom = await store.get(id as AtomId);
    if (atom === null) throw new Error(`test setup: canonical fence atom ${id} missing`);
    out.set(id, atom);
  }
  return out;
}

/**
 * Minimal AtomStore stub. Pre-staged with the canonical fence atoms
 * for every id except the one passed as `drifted` (which returns the
 * drifted shape instead). Records any `put` attempt so the assertion
 * can refuse a silent overwrite. Every other method no-ops or throws;
 * the seeder only touches `get` + `put`.
 */
async function driftStubFor(drifted: Atom): Promise<{
  readonly store: AtomStore;
  readonly puts: Atom[];
}> {
  const canonical = await canonicalFenceAtoms();
  const puts: Atom[] = [];
  const store: AtomStore = {
    async get(id: AtomId): Promise<Atom | null> {
      if (id === drifted.id) return drifted;
      return canonical.get(String(id)) ?? null;
    },
    async put(atom: Atom): Promise<AtomId> {
      puts.push(atom);
      return atom.id;
    },
    async query() {
      return { atoms: [], nextCursor: null };
    },
    async search() {
      return [];
    },
    async update() {
      throw new Error('not implemented for test');
    },
    async batchUpdate() {
      return 0;
    },
    async embed() {
      return [];
    },
    similarity() {
      return 0;
    },
    contentHash() {
      return '';
    },
  };
  return { store, puts };
}

describe('seedFenceAtoms drift guard', () => {
  it('is a no-op when existing atoms match the canonical shape', async () => {
    const store = new MemoryAtomStore();
    await seedFenceAtoms(store, OPERATOR);
    // Re-run: must not throw, must not overwrite.
    await expect(seedFenceAtoms(store, OPERATOR)).resolves.toBeUndefined();
    for (const id of FENCE_ATOM_IDS) {
      const atom = await store.get(id as AtomId);
      expect(atom, `fence atom ${id} vanished after re-seed`).not.toBeNull();
    }
  });

  it('throws on content drift', async () => {
    const canonical = await canonicalAtom('pol-code-author-signed-pr-only' as AtomId);
    const drifted: Atom = { ...canonical, content: 'tampered content' };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });

  it('throws on principal_id drift', async () => {
    const canonical = await canonicalAtom('pol-code-author-ci-gate' as AtomId);
    const drifted: Atom = {
      ...canonical,
      principal_id: 'other-principal' as PrincipalId,
    };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });

  it('throws on provenance.derived_from drift', async () => {
    const canonical = await canonicalAtom('pol-code-author-per-pr-cost-cap' as AtomId);
    const drifted: Atom = {
      ...canonical,
      provenance: { ...canonical.provenance, derived_from: [] },
    };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });

  it('throws on metadata.policy drift', async () => {
    const canonical = await canonicalAtom('pol-code-author-per-pr-cost-cap' as AtomId);
    const policyExisting = (canonical.metadata as Record<string, unknown>)['policy'] as Record<string, unknown>;
    const drifted: Atom = {
      ...canonical,
      metadata: {
        ...(canonical.metadata as Record<string, unknown>),
        policy: { ...policyExisting, max_usd_per_pr: 9999.99 },
      },
    };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });

  it('throws on provenance.kind drift', async () => {
    const canonical = await canonicalAtom(
      'pol-code-author-write-revocation-on-stop' as AtomId,
    );
    const drifted: Atom = {
      ...canonical,
      provenance: { ...canonical.provenance, kind: 'agent-inferred' },
    };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });

  it('mentions the drifted atom id and fields in the error message', async () => {
    const canonical = await canonicalAtom('pol-code-author-signed-pr-only' as AtomId);
    const drifted: Atom = { ...canonical, content: 'tampered content' };
    const { store } = await driftStubFor(drifted);
    try {
      await seedFenceAtoms(store, OPERATOR);
      throw new Error('expected drift error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('pol-code-author-signed-pr-only');
      expect(msg).toMatch(/content/);
    }
  });

  it('throws when existing atom is superseded (non-empty superseded_by)', async () => {
    const canonical = await canonicalAtom('pol-code-author-signed-pr-only' as AtomId);
    const drifted: Atom = {
      ...canonical,
      superseded_by: ['some-replacement-atom-id' as AtomId],
    };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });

  it('throws when existing atom has unexpected supersedes entries', async () => {
    const canonical = await canonicalAtom('pol-code-author-ci-gate' as AtomId);
    const drifted: Atom = {
      ...canonical,
      supersedes: ['unexpected-prior-atom-id' as AtomId],
    };
    const { store, puts } = await driftStubFor(drifted);
    await expect(seedFenceAtoms(store, OPERATOR)).rejects.toThrow(/drift/i);
    expect(puts).toHaveLength(0);
  });
});
