import { describe, it, expect } from 'vitest';
import { computeAuditChainLayout } from './layout';
import type { AnyAtom } from '@/services/atoms.service';
import type { AuditChainEdge } from '@/services/atoms.service';

/*
 * Pure-function tests for the audit-chain layout helper. The server
 * returns { atoms, edges }; the layout helper computes per-atom depth
 * + stable ordering for the timeline. No React, no DOM.
 */

function atom(partial: Partial<AnyAtom> & { id: string }): AnyAtom {
  return {
    type: 'plan',
    layer: 'L0',
    content: '',
    principal_id: 'cto-actor',
    confidence: 0.9,
    created_at: '2026-04-29T00:00:00.000Z',
    ...partial,
  } as AnyAtom;
}

describe('computeAuditChainLayout', () => {
  it('returns a single seed node when the response has only the seed', () => {
    const atoms: AnyAtom[] = [atom({ id: 'seed' })];
    const edges: AuditChainEdge[] = [];
    const layout = computeAuditChainLayout(atoms, edges, 'seed');
    expect(layout.seedId).toBe('seed');
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.atom.id).toBe('seed');
    expect(layout.nodes[0]!.depth).toBe(0);
  });

  it('walks a 3-deep linear chain assigning depths 0..3', () => {
    const atoms = [
      atom({ id: 'seed' }),
      atom({ id: 'a' }),
      atom({ id: 'b' }),
      atom({ id: 'c' }),
    ];
    const edges: AuditChainEdge[] = [
      { from: 'seed', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const layout = computeAuditChainLayout(atoms, edges, 'seed');
    expect(layout.nodes.map((n) => n.atom.id)).toEqual(['seed', 'a', 'b', 'c']);
    expect(layout.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3]);
  });

  it('handles a diamond (seed -> A,B; A,B -> X) with X at depth 2 once', () => {
    const atoms = [
      atom({ id: 'seed' }),
      atom({ id: 'a' }),
      atom({ id: 'b' }),
      atom({ id: 'x' }),
    ];
    const edges: AuditChainEdge[] = [
      { from: 'seed', to: 'a' },
      { from: 'seed', to: 'b' },
      { from: 'a', to: 'x' },
      { from: 'b', to: 'x' },
    ];
    const layout = computeAuditChainLayout(atoms, edges, 'seed');
    // Seed at depth 0, a + b at depth 1, x at depth 2 (via either parent).
    const depthById = Object.fromEntries(layout.nodes.map((n) => [n.atom.id, n.depth]));
    expect(depthById['seed']).toBe(0);
    expect(depthById['a']).toBe(1);
    expect(depthById['b']).toBe(1);
    expect(depthById['x']).toBe(2);
    // Stable ordering: seed first, then depth-1 in response order, then depth-2.
    expect(layout.nodes.map((n) => n.atom.id)).toEqual(['seed', 'a', 'b', 'x']);
  });

  it('drops atoms unreachable from the seed to the bottom (depth -1)', () => {
    const atoms = [
      atom({ id: 'seed' }),
      atom({ id: 'a' }),
      atom({ id: 'orphan' }),
    ];
    const edges: AuditChainEdge[] = [
      { from: 'seed', to: 'a' },
    ];
    const layout = computeAuditChainLayout(atoms, edges, 'seed');
    expect(layout.nodes.map((n) => n.atom.id)).toEqual(['seed', 'a', 'orphan']);
    expect(layout.nodes.map((n) => n.depth)).toEqual([0, 1, -1]);
  });

  it('handles a cycle without infinite loop (a->seed) and stops at first depth assignment', () => {
    const atoms = [
      atom({ id: 'seed' }),
      atom({ id: 'a' }),
    ];
    const edges: AuditChainEdge[] = [
      { from: 'seed', to: 'a' },
      { from: 'a', to: 'seed' }, // cycle: a derived_from seed (an audit anomaly but defensive)
    ];
    const layout = computeAuditChainLayout(atoms, edges, 'seed');
    // Seed depth 0 wins; cycle does not re-assign.
    expect(layout.nodes.map((n) => n.atom.id)).toEqual(['seed', 'a']);
    expect(layout.nodes.map((n) => n.depth)).toEqual([0, 1]);
  });

  it('returns the input order when the seed is missing from the corpus (edge case)', () => {
    const atoms = [atom({ id: 'lonely' })];
    const edges: AuditChainEdge[] = [];
    const layout = computeAuditChainLayout(atoms, edges, 'mystery-seed');
    // Defensive: seed missing -> every atom is unreachable -> all depth -1.
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.depth).toBe(-1);
  });
});
