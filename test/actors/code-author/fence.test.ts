/**
 * Unit tests for loadCodeAuthorFence.
 *
 * Fence integrity is load-bearing: the actor runs under the four
 * `pol-code-author-*` atoms. A permissive loader would let the
 * actor operate under a policy its own governance rejects. Cover
 * the three fail-closed axes (absent / tainted / superseded) plus
 * happy path, shape validation, and forward-compatible warnings.
 */

import { describe, expect, it } from 'vitest';
import {
  FENCE_ATOM_IDS,
  loadCodeAuthorFence,
  CodeAuthorFenceError,
} from '../../../src/actors/code-author/fence.js';
import type { AtomStore } from '../../../src/substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const OPERATOR_ID = 'test-operator' as PrincipalId;
const BOOT_TIME = '2026-04-21T00:00:00.000Z' as Time;

function mkAtom(id: string, policy: Record<string, unknown>, overrides: Partial<Atom> = {}): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `fence atom ${id}`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: BOOT_TIME,
    last_reinforced_at: BOOT_TIME,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata: { policy },
    ...overrides,
  };
}

function defaultFenceAtoms(): ReadonlyMap<string, Atom> {
  return new Map<string, Atom>([
    ['pol-code-author-signed-pr-only', mkAtom('pol-code-author-signed-pr-only', {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: [],
      require_app_identity: true,
    })],
    ['pol-code-author-per-pr-cost-cap', mkAtom('pol-code-author-per-pr-cost-cap', {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: 10.0,
      include_retries: true,
    })],
    ['pol-code-author-ci-gate', mkAtom('pol-code-author-ci-gate', {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22 on ubuntu-latest', 'Node 22 on windows-latest', 'package hygiene'],
      require_all: true,
      max_check_age_ms: 600_000,
    })],
    ['pol-code-author-write-revocation-on-stop', mkAtom('pol-code-author-write-revocation-on-stop', {
      subject: 'code-author-write-revocation',
      on_stop_action: 'close-pr-with-revocation-comment',
      draft_atoms_layer: 'L0',
      revocation_atom_type: 'code-author-revoked',
    })],
  ]);
}

function mockAtomStore(atomsById: Map<string, Atom>): AtomStore {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(id: AtomId): Promise<Atom | null> {
      return atomsById.get(String(id)) ?? null;
    },
    // The fence loader only uses `get`; the other methods are stubbed
    // so we do not have to pull in a full in-memory adapter for a
    // targeted unit test.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async put() { },
    async query() { return []; },
    async capabilities() { return { exactMatch: true, prefixScan: false, vectorSearch: false }; },
    async updateConfidence() { /* noop */ },
    async markTainted() { /* noop */ },
    async supersede() { /* noop */ },
  } as unknown as AtomStore;
}

describe('loadCodeAuthorFence', () => {
  it('loads all four atoms when present, clean, and un-superseded', async () => {
    const atoms = defaultFenceAtoms();
    const fence = await loadCodeAuthorFence(mockAtomStore(new Map(atoms)));
    expect(fence.signedPrOnly.require_app_identity).toBe(true);
    expect(fence.signedPrOnly.allowed_direct_write_paths).toEqual([]);
    expect(fence.perPrCostCap.max_usd_per_pr).toBe(10);
    expect(fence.perPrCostCap.include_retries).toBe(true);
    expect(fence.ciGate.required_checks).toEqual([
      'Node 22 on ubuntu-latest',
      'Node 22 on windows-latest',
      'package hygiene',
    ]);
    expect(fence.ciGate.require_all).toBe(true);
    expect(fence.ciGate.max_check_age_ms).toBe(600_000);
    expect(fence.writeRevocationOnStop.draft_atoms_layer).toBe('L0');
    expect(fence.writeRevocationOnStop.revocation_atom_type).toBe('code-author-revoked');
    expect(fence.warnings).toEqual([]);
  });

  it('fails closed when any fence atom is absent', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.delete('pol-code-author-ci-gate');
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toMatchObject({
      name: 'CodeAuthorFenceError',
      reasons: expect.arrayContaining(['pol-code-author-ci-gate: atom not present in store']),
    });
  });

  it('fails closed when a fence atom is tainted', async () => {
    const atoms = new Map(defaultFenceAtoms());
    const existing = atoms.get('pol-code-author-per-pr-cost-cap')!;
    atoms.set('pol-code-author-per-pr-cost-cap', { ...existing, taint: 'dirty' });
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/taint=dirty/);
  });

  it('fails closed when a fence atom is superseded', async () => {
    const atoms = new Map(defaultFenceAtoms());
    const existing = atoms.get('pol-code-author-signed-pr-only')!;
    atoms.set('pol-code-author-signed-pr-only', {
      ...existing,
      superseded_by: ['pol-code-author-signed-pr-only-v2' as AtomId],
    });
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/superseded by/);
  });

  it('aggregates ALL failing atoms into a single error (not just the first)', async () => {
    // A permissive loader that threw on the first failure would let an
    // operator fix one drift, re-run, and trip on the next; the batch
    // report is load-bearing for fence maintainability.
    const atoms = new Map(defaultFenceAtoms());
    atoms.delete('pol-code-author-signed-pr-only');
    atoms.delete('pol-code-author-ci-gate');
    try {
      await loadCodeAuthorFence(mockAtomStore(atoms));
      throw new Error('expected fence load to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CodeAuthorFenceError);
      const e = err as CodeAuthorFenceError;
      expect(e.reasons).toHaveLength(2);
      expect(e.reasons.join('\n')).toContain('pol-code-author-signed-pr-only');
      expect(e.reasons.join('\n')).toContain('pol-code-author-ci-gate');
    }
  });

  it('rejects an atom with an invalid policy payload shape', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-per-pr-cost-cap', mkAtom('pol-code-author-per-pr-cost-cap', {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: -5,           // must be positive
      include_retries: 'yes' as unknown as boolean,  // must be boolean
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/fence shape validation failed/);
  });

  it('treats unexpected policy keys as non-fatal warnings (forward-compat)', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-signed-pr-only', mkAtom('pol-code-author-signed-pr-only', {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: [],
      require_app_identity: true,
      // Forward-compat addition: not in the known key set.
      future_key: 'future-value',
    }));
    const fence = await loadCodeAuthorFence(mockAtomStore(atoms));
    expect(fence.warnings).toHaveLength(1);
    expect(fence.warnings[0]).toContain('future_key');
    expect(fence.signedPrOnly.require_app_identity).toBe(true);
  });

  it('FENCE_ATOM_IDS is the exhaustive list the loader probes', () => {
    // Invariant: anything added to FENCE_ATOM_IDS must have a parser
    // in fence.ts. This test pins the list so a future addition
    // without a parser lands as a compile error plus a test diff.
    expect([...FENCE_ATOM_IDS].sort()).toEqual([
      'pol-code-author-ci-gate',
      'pol-code-author-per-pr-cost-cap',
      'pol-code-author-signed-pr-only',
      'pol-code-author-write-revocation-on-stop',
    ]);
  });

  it('does not leak a reference to the atom store (uniqueness of load)', async () => {
    // Each load opens the atoms afresh; a caller loading twice with
    // different store states must see the second state, not the
    // first. Pinned by the store.get contract, but cheap to assert.
    const atoms1 = new Map(defaultFenceAtoms());
    const atoms2 = new Map(defaultFenceAtoms());
    atoms2.set('pol-code-author-per-pr-cost-cap', mkAtom('pol-code-author-per-pr-cost-cap', {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: 25.0,
      include_retries: true,
    }));
    const f1 = await loadCodeAuthorFence(mockAtomStore(atoms1));
    const f2 = await loadCodeAuthorFence(mockAtomStore(atoms2));
    expect(f1.perPrCostCap.max_usd_per_pr).toBe(10);
    expect(f2.perPrCostCap.max_usd_per_pr).toBe(25);
  });

  it('aggregates parse-phase failures across multiple atoms (not just presence)', async () => {
    // Companion to the presence-phase aggregation test above. Seed
    // TWO present-but-malformed atoms and verify both atom ids appear
    // in the single thrown error. This pins the fence-loader's
    // batch-reporting discipline to the parse phase, not just the
    // presence/taint/supersession loop. Without this, a regression
    // where parse*() throws on the first bad atom would silently
    // hide the second one.
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-signed-pr-only', mkAtom('pol-code-author-signed-pr-only', {
      subject: 'WRONG-SUBJECT',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: [],
      require_app_identity: true,
    }));
    atoms.set('pol-code-author-ci-gate', mkAtom('pol-code-author-ci-gate', {
      subject: 'WRONG-SUBJECT-2',
      required_checks: ['Node 22 on ubuntu-latest'],
      require_all: true,
      max_check_age_ms: 600_000,
    }));
    try {
      await loadCodeAuthorFence(mockAtomStore(atoms));
      throw new Error('expected fence load to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CodeAuthorFenceError);
      const e = err as CodeAuthorFenceError;
      const joined = e.reasons.join('\n');
      expect(joined).toContain('pol-code-author-signed-pr-only');
      expect(joined).toContain('pol-code-author-ci-gate');
    }
  });

  it('rejects non-string elements in allowed_direct_write_paths (finding: silent String() coercion)', async () => {
    // Array.isArray alone passes on [123, true, {}], and the old
    // `.map(String)` would coerce those into
    // `["123", "true", "[object Object]"]`: silent policy drift that
    // the loader was nominally preventing but in fact allowing.
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-signed-pr-only', mkAtom('pol-code-author-signed-pr-only', {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: ['/ok/path', 123, { path: 'src' }] as ReadonlyArray<unknown>,
      require_app_identity: true,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/allowed_direct_write_paths: expected string\[\]/);
  });

  it('rejects non-string elements in required_checks (same class)', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-ci-gate', mkAtom('pol-code-author-ci-gate', {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22', 42, null] as ReadonlyArray<unknown>,
      require_all: true,
      max_check_age_ms: 600_000,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/required_checks: expected non-empty string\[\]/);
  });

  it('rejects blank string entries in allowed_direct_write_paths', async () => {
    // `['']` widens downstream prefix checks (empty prefix matches
    // everything); `['   ']` is almost always a canon typo that reads
    // like intent. Both must surface as explicit drift.
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-signed-pr-only', mkAtom('pol-code-author-signed-pr-only', {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: ['src/ok', '   '],
      require_app_identity: true,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/allowed_direct_write_paths: expected string\[\] with non-blank entries/);
  });

  it('rejects blank string entries in required_checks', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-ci-gate', mkAtom('pol-code-author-ci-gate', {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22 on ubuntu-latest', ''],
      require_all: true,
      max_check_age_ms: 600_000,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/required_checks: expected non-empty string\[\] with non-blank entries/);
  });

  it('rejects Infinity for max_usd_per_pr (non-finite budget)', async () => {
    // An unbounded budget is not a budget. typeof Infinity === 'number'
    // AND Infinity > 0, so the naive positive-number check passes;
    // Number.isFinite is the gate.
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-per-pr-cost-cap', mkAtom('pol-code-author-per-pr-cost-cap', {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: Infinity,
      include_retries: true,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/max_usd_per_pr: expected positive finite number/);
  });

  it('rejects NaN for max_usd_per_pr', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-per-pr-cost-cap', mkAtom('pol-code-author-per-pr-cost-cap', {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: Number.NaN,
      include_retries: true,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/max_usd_per_pr: expected positive finite number/);
  });

  it('rejects non-integer max_check_age_ms', async () => {
    // Ms precision is integer by convention; a fractional ms is
    // almost always a unit-mix typo (e.g., passing seconds to a
    // ms field). Require Number.isInteger.
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-ci-gate', mkAtom('pol-code-author-ci-gate', {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22 on ubuntu-latest'],
      require_all: true,
      max_check_age_ms: 600.5,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/max_check_age_ms: expected positive finite integer/);
  });

  it('rejects Infinity for max_check_age_ms', async () => {
    const atoms = new Map(defaultFenceAtoms());
    atoms.set('pol-code-author-ci-gate', mkAtom('pol-code-author-ci-gate', {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22 on ubuntu-latest'],
      require_all: true,
      max_check_age_ms: Infinity,
    }));
    await expect(loadCodeAuthorFence(mockAtomStore(atoms))).rejects.toThrow(/max_check_age_ms: expected positive finite integer/);
  });
});
