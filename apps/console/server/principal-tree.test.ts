import { describe, it, expect } from 'vitest';
import { buildPrincipalTree, type PrincipalTreeInput } from './principal-tree';

/*
 * Unit tests for the principal hierarchy tree builder. Drives the
 * pure function with synthetic principal arrays so the contract is
 * pinned without an end-to-end filesystem round-trip.
 *
 * Coverage rationale:
 *   - shape: roots, depth, ordering, kind discriminator
 *   - taint cascade: self vs inherited
 *   - error paths: cycle, orphan
 *   - defaults: role/active fallbacks
 */

describe('buildPrincipalTree', () => {
  it('returns empty result for an empty input', () => {
    const r = buildPrincipalTree([]);
    expect(r.roots).toEqual([]);
    expect(r.orphans).toEqual([]);
  });

  it('treats principals with null signed_by as roots', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'human-operator', role: 'human', signed_by: null },
      { id: 'agent-x', role: 'agent', signed_by: 'human-operator' },
    ];
    const r = buildPrincipalTree(inputs);
    expect(r.roots).toHaveLength(1);
    expect(r.roots[0]?.id).toBe('human-operator');
    expect(r.roots[0]?.depth).toBe(0);
    expect(r.roots[0]?.kind).toBe('root');
    expect(r.roots[0]?.children).toHaveLength(1);
    expect(r.roots[0]?.children[0]?.id).toBe('agent-x');
    expect(r.roots[0]?.children[0]?.depth).toBe(1);
    expect(r.roots[0]?.children[0]?.kind).toBe('agent');
  });

  it('sorts root and child principals by id', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'b-root', role: 'human', signed_by: null },
      { id: 'a-root', role: 'human', signed_by: null },
      { id: 'z-child', role: 'agent', signed_by: 'a-root' },
      { id: 'm-child', role: 'agent', signed_by: 'a-root' },
    ];
    const r = buildPrincipalTree(inputs);
    expect(r.roots.map((n) => n.id)).toEqual(['a-root', 'b-root']);
    expect(r.roots[0]?.children.map((n) => n.id)).toEqual(['m-child', 'z-child']);
  });

  it('marks a compromised principal with taint_state="compromised"', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null, compromised_at: '2026-04-26T00:00:00.000Z' },
    ];
    const r = buildPrincipalTree(inputs);
    expect(r.roots[0]?.taint_state).toBe('compromised');
  });

  it('cascades taint to descendants as taint_state="inherited"', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null, compromised_at: '2026-04-26T00:00:00.000Z' },
      { id: 'mid', role: 'agent', signed_by: 'root' },
      { id: 'leaf', role: 'agent', signed_by: 'mid' },
    ];
    const r = buildPrincipalTree(inputs);
    expect(r.roots[0]?.taint_state).toBe('compromised');
    expect(r.roots[0]?.children[0]?.taint_state).toBe('inherited');
    expect(r.roots[0]?.children[0]?.children[0]?.taint_state).toBe('inherited');
  });

  it('keeps siblings clean when only one branch is compromised', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null },
      { id: 'tainted-mid', role: 'agent', signed_by: 'root', compromised_at: '2026-04-26T00:00:00.000Z' },
      { id: 'tainted-leaf', role: 'agent', signed_by: 'tainted-mid' },
      { id: 'clean-mid', role: 'agent', signed_by: 'root' },
      { id: 'clean-leaf', role: 'agent', signed_by: 'clean-mid' },
    ];
    const r = buildPrincipalTree(inputs);
    const root = r.roots[0];
    expect(root?.taint_state).toBe('clean');
    const cleanBranch = root?.children.find((c) => c.id === 'clean-mid');
    const taintedBranch = root?.children.find((c) => c.id === 'tainted-mid');
    expect(cleanBranch?.taint_state).toBe('clean');
    expect(cleanBranch?.children[0]?.taint_state).toBe('clean');
    expect(taintedBranch?.taint_state).toBe('compromised');
    expect(taintedBranch?.children[0]?.taint_state).toBe('inherited');
  });

  it('reports orphans whose signed_by points at a missing id', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null },
      { id: 'ghost-child', role: 'agent', signed_by: 'phantom-parent' },
    ];
    const r = buildPrincipalTree(inputs);
    expect(r.roots).toHaveLength(1);
    expect(r.orphans).toEqual(['ghost-child']);
  });

  /*
   * Cycles are structurally hard to reach in well-formed principal-
   * store data because every principal has at most one signed_by.
   * The defensive throw in the builder covers two real failure
   * modes: (1) a future refactor that allows multi-parent edges,
   * (2) corrupted JSON where two records share an id and one points
   * at itself. We exercise (2) here -- the duplicate-id record makes
   * the children index fan a node back into its own subtree, which
   * trips the visited-set guard on the second visit.
   */
  it('throws on a cycle in the signed_by chain', () => {
    const sharedIdInputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null },
      { id: 'a', role: 'agent', signed_by: 'root' },
      // Duplicate id `a` whose signed_by points at itself; the
      // children index then has 'a' under 'a', so the recursion
      // attempts to revisit `a` and the visited guard throws.
      { id: 'a', role: 'agent', signed_by: 'a' },
    ];
    expect(() => buildPrincipalTree(sharedIdInputs)).toThrow(/cycle detected/);
  });

  it('treats inactive: false principals as inactive in the projection', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null, active: false },
      { id: 'child', role: 'agent', signed_by: 'root', active: true },
    ];
    const r = buildPrincipalTree(inputs);
    expect(r.roots[0]?.active).toBe(false);
    expect(r.roots[0]?.children[0]?.active).toBe(true);
  });

  it('defaults role to "unknown" when missing', () => {
    const inputs: PrincipalTreeInput[] = [{ id: 'root', signed_by: null }];
    const r = buildPrincipalTree(inputs);
    expect(r.roots[0]?.role).toBe('unknown');
    expect(r.roots[0]?.kind).toBe('root');
  });

  it('emits depth that increments per signed_by hop', () => {
    const inputs: PrincipalTreeInput[] = [
      { id: 'root', role: 'human', signed_by: null },
      { id: 'd1', role: 'agent', signed_by: 'root' },
      { id: 'd2', role: 'agent', signed_by: 'd1' },
      { id: 'd3', role: 'agent', signed_by: 'd2' },
    ];
    const r = buildPrincipalTree(inputs);
    let cur = r.roots[0];
    expect(cur?.depth).toBe(0);
    cur = cur?.children[0];
    expect(cur?.depth).toBe(1);
    cur = cur?.children[0];
    expect(cur?.depth).toBe(2);
    cur = cur?.children[0];
    expect(cur?.depth).toBe(3);
  });
});
