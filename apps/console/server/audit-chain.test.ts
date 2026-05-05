import { describe, it, expect } from 'vitest';
import {
  buildAuditChain,
  clampAuditChainDepth,
  DEFAULT_AUDIT_CHAIN_DEPTH,
  MAX_AUDIT_CHAIN_DEPTH,
  type AuditChainAtom,
} from './audit-chain';

/*
 * Pure-function tests for the audit-chain projection.
 *
 * Determinism: every test passes its atom corpus + maxDepth explicitly;
 * the helper is fs-free and clock-free so no fixtures or mocks are
 * needed.
 *
 * Coverage matrix:
 *   - empty seed (null)
 *   - 3-deep linear chain (seed -> A -> B -> C) returns 4 atoms + 3 edges
 *   - diamond (seed -> A,B and A -> X, B -> X) returns 4 atoms + 4 edges,
 *     X listed once
 *   - cycle protection (seed -> A -> seed) terminates without infinite loop
 *   - max_depth bound truncates and reports depth_reached
 *   - dangling derived_from (cites missing atom) reports missing_ancestors
 *   - depth clamp: bad inputs fall to default, max ceiling enforced
 */

function atom(partial: Partial<AuditChainAtom> & { id: string }): AuditChainAtom {
  return {
    type: 'plan',
    layer: 'L0',
    content: 'sample',
    principal_id: 'cto-actor',
    confidence: 0.9,
    created_at: '2026-04-29T00:00:00.000Z',
    ...partial,
  };
}

function withDerivedFrom(id: string, derivedFrom: ReadonlyArray<string>, partial: Partial<AuditChainAtom> = {}): AuditChainAtom {
  return atom({
    ...partial,
    id,
    provenance: { derived_from: derivedFrom },
  });
}

describe('buildAuditChain', () => {
  it('returns null when the seed is unknown', () => {
    const result = buildAuditChain('missing', [atom({ id: 'a' })], 5);
    expect(result).toBeNull();
  });

  it('returns just the seed (no edges) for an atom with no derived_from', () => {
    const seed = atom({ id: 'seed' });
    const result = buildAuditChain('seed', [seed], 5);
    expect(result).not.toBeNull();
    expect(result!.atoms.map((a) => a.id)).toEqual(['seed']);
    expect(result!.edges).toEqual([]);
    expect(result!.truncated.depth_reached).toBe(false);
    expect(result!.truncated.missing_ancestors).toBe(0);
  });

  it('walks a 3-deep linear chain (seed -> A -> B -> C)', () => {
    const corpus = [
      withDerivedFrom('seed', ['a'], { type: 'plan' }),
      withDerivedFrom('a', ['b'], { type: 'spec-output' }),
      withDerivedFrom('b', ['c'], { type: 'brainstorm-output' }),
      atom({ id: 'c', type: 'operator-intent' }),
    ];
    const result = buildAuditChain('seed', corpus, 10);
    expect(result).not.toBeNull();
    // Seed is always at index 0; ancestors follow in BFS order.
    expect(result!.atoms.map((a) => a.id)).toEqual(['seed', 'a', 'b', 'c']);
    expect(result!.edges).toEqual([
      { from: 'seed', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    expect(result!.truncated.depth_reached).toBe(false);
    expect(result!.truncated.missing_ancestors).toBe(0);
  });

  it('deduplicates ancestors in a diamond graph (seed -> A,B; A,B -> X)', () => {
    const corpus = [
      withDerivedFrom('seed', ['a', 'b']),
      withDerivedFrom('a', ['x']),
      withDerivedFrom('b', ['x']),
      atom({ id: 'x' }),
    ];
    const result = buildAuditChain('seed', corpus, 5);
    expect(result).not.toBeNull();
    // X is included exactly once, but BOTH edges (a->x, b->x) appear.
    const ids = result!.atoms.map((a) => a.id).sort();
    expect(ids).toEqual(['a', 'b', 'seed', 'x']);
    expect(result!.atoms).toHaveLength(4);

    const edgeSet = new Set(result!.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet).toEqual(
      new Set(['seed->a', 'seed->b', 'a->x', 'b->x']),
    );
  });

  it('terminates on a cycle and never duplicates a visited atom', () => {
    const corpus = [
      withDerivedFrom('seed', ['a']),
      withDerivedFrom('a', ['seed']), // cycle back to seed
    ];
    const result = buildAuditChain('seed', corpus, 5);
    expect(result).not.toBeNull();
    expect(result!.atoms.map((a) => a.id)).toEqual(['seed', 'a']);
    // The cycle edge a->seed IS emitted (both endpoints are included);
    // the BFS just refuses to re-walk the visited target.
    const edgeSet = new Set(result!.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet).toEqual(new Set(['seed->a', 'a->seed']));
  });

  it('honours max_depth and reports depth_reached when ancestors get pruned', () => {
    const corpus = [
      withDerivedFrom('seed', ['a']),
      withDerivedFrom('a', ['b']),
      withDerivedFrom('b', ['c']),
      atom({ id: 'c' }),
    ];
    // Depth 2 means we walk seed (depth 0) -> a (depth 1) -> b (depth 2)
    // and STOP without expanding b's parents. b is included; c is not.
    const result = buildAuditChain('seed', corpus, 2);
    expect(result).not.toBeNull();
    expect(result!.atoms.map((a) => a.id)).toEqual(['seed', 'a', 'b']);
    // Edge b->c is dropped because c is not included; depth_reached
    // surfaces the truncation to the UI.
    expect(result!.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'seed->a',
      'a->b',
    ]);
    expect(result!.truncated.depth_reached).toBe(true);
    // The dropped edge contributes one missing-ancestor reference.
    expect(result!.truncated.missing_ancestors).toBe(1);
  });

  it('dedupes missing_ancestors so the same dangling parent is counted once', () => {
    /*
     * Two distinct children both cite the same dangling 'ghost'.
     * Without deduplication this would double-count (one ++ per cite);
     * the set-based dedupe must keep it at 1.
     */
    const corpus = [
      withDerivedFrom('seed', ['child-a', 'child-b']),
      withDerivedFrom('child-a', ['ghost']),
      withDerivedFrom('child-b', ['ghost']),
    ];
    const result = buildAuditChain('seed', corpus, 5);
    expect(result).not.toBeNull();
    expect(result!.atoms.map((a) => a.id)).toEqual(['seed', 'child-a', 'child-b']);
    // The ghost is referenced twice but missing once.
    expect(result!.truncated.missing_ancestors).toBe(1);
  });

  it('dedupes missing_ancestors at the depth boundary too', () => {
    /*
     * Two boundary atoms both cite the same upstream parent that is
     * pruned by max_depth. The set-based dedupe makes the count 1.
     */
    const corpus = [
      withDerivedFrom('seed', ['a', 'b']),
      withDerivedFrom('a', ['shared-upstream']),
      withDerivedFrom('b', ['shared-upstream']),
      atom({ id: 'shared-upstream' }),
    ];
    const result = buildAuditChain('seed', corpus, 1);
    expect(result).not.toBeNull();
    // At depth 1, both a and b are included but their parents are
    // not walked. shared-upstream is therefore the boundary parent
    // for both, and the dedupe count is 1.
    expect(result!.atoms.map((a) => a.id).sort()).toEqual(['a', 'b', 'seed']);
    expect(result!.truncated.depth_reached).toBe(true);
    expect(result!.truncated.missing_ancestors).toBe(1);
  });

  it('reports missing_ancestors when derived_from cites an atom not in the corpus', () => {
    const corpus = [
      // Seed cites two parents; only one exists.
      withDerivedFrom('seed', ['real-parent', 'ghost-parent']),
      atom({ id: 'real-parent' }),
    ];
    const result = buildAuditChain('seed', corpus, 5);
    expect(result).not.toBeNull();
    expect(result!.atoms.map((a) => a.id)).toEqual(['seed', 'real-parent']);
    // The ghost edge is dropped, the real one is kept.
    expect(result!.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'seed->real-parent',
    ]);
    expect(result!.truncated.missing_ancestors).toBe(1);
    expect(result!.truncated.depth_reached).toBe(false);
  });

  it('ignores malformed provenance (non-array, non-string entries)', () => {
    const seed: AuditChainAtom = atom({
      id: 'seed',
      provenance: { derived_from: 'oops-not-an-array' as unknown as ReadonlyArray<string> },
    });
    const seed2: AuditChainAtom = atom({
      id: 'seed2',
      provenance: { derived_from: ['real', 42 as unknown as string, '', null as unknown as string] },
    });
    const r1 = buildAuditChain('seed', [seed], 5);
    expect(r1!.atoms.map((a) => a.id)).toEqual(['seed']);
    expect(r1!.edges).toEqual([]);

    const corpus = [seed2, atom({ id: 'real' })];
    const r2 = buildAuditChain('seed2', corpus, 5);
    expect(r2!.atoms.map((a) => a.id)).toEqual(['seed2', 'real']);
    expect(r2!.edges).toEqual([{ from: 'seed2', to: 'real' }]);
  });

  it('walks a 5-deep substrate-shaped chain (intent -> brainstorm -> spec -> plan -> review -> dispatch)', () => {
    const corpus = [
      atom({ id: 'op-intent', type: 'operator-intent' }),
      withDerivedFrom('brainstorm-1', ['op-intent'], { type: 'brainstorm-output' }),
      withDerivedFrom('spec-1', ['brainstorm-1'], { type: 'spec-output' }),
      withDerivedFrom('plan-1', ['spec-1'], { type: 'plan' }),
      withDerivedFrom('review-1', ['plan-1'], { type: 'review-report' }),
      withDerivedFrom('dispatch-1', ['review-1'], { type: 'dispatch-record' }),
    ];
    const result = buildAuditChain('dispatch-1', corpus, DEFAULT_AUDIT_CHAIN_DEPTH);
    expect(result).not.toBeNull();
    expect(result!.atoms.map((a) => a.id)).toEqual([
      'dispatch-1',
      'review-1',
      'plan-1',
      'spec-1',
      'brainstorm-1',
      'op-intent',
    ]);
    // 5 edges for 6 atoms in a linear chain.
    expect(result!.edges).toHaveLength(5);
    expect(result!.truncated.depth_reached).toBe(false);
    expect(result!.truncated.missing_ancestors).toBe(0);
  });

  it('preserves seed metadata (type, principal, plan_state, taint) in the response', () => {
    const seed: AuditChainAtom = {
      id: 'seed',
      type: 'plan',
      layer: 'L0',
      content: 'plan body',
      principal_id: 'cto-actor',
      confidence: 0.85,
      created_at: '2026-05-01T00:00:00.000Z',
      plan_state: 'approved',
      taint: 'clean',
    };
    const result = buildAuditChain('seed', [seed], 5);
    expect(result).not.toBeNull();
    expect(result!.atoms[0]).toEqual(seed);
  });
});

describe('clampAuditChainDepth', () => {
  it('returns the default for non-numeric input', () => {
    expect(clampAuditChainDepth(undefined)).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
    expect(clampAuditChainDepth(null)).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
    expect(clampAuditChainDepth('5')).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
    expect(clampAuditChainDepth(NaN)).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
    expect(clampAuditChainDepth(Infinity)).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
  });

  it('returns the default for non-positive input', () => {
    expect(clampAuditChainDepth(0)).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
    expect(clampAuditChainDepth(-1)).toBe(DEFAULT_AUDIT_CHAIN_DEPTH);
  });

  it('floors fractional input', () => {
    expect(clampAuditChainDepth(3.7)).toBe(3);
    expect(clampAuditChainDepth(1.1)).toBe(1);
  });

  it('caps input above the hard ceiling', () => {
    expect(clampAuditChainDepth(MAX_AUDIT_CHAIN_DEPTH + 1)).toBe(MAX_AUDIT_CHAIN_DEPTH);
    expect(clampAuditChainDepth(10_000)).toBe(MAX_AUDIT_CHAIN_DEPTH);
  });

  it('passes through valid input unchanged', () => {
    expect(clampAuditChainDepth(1)).toBe(1);
    expect(clampAuditChainDepth(7)).toBe(7);
    expect(clampAuditChainDepth(MAX_AUDIT_CHAIN_DEPTH)).toBe(MAX_AUDIT_CHAIN_DEPTH);
  });
});
