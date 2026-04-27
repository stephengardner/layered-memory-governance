import { describe, it, expect } from 'vitest';
import {
  buildPrincipalStatsResponse,
  type PrincipalStatsAtom,
} from './principal-stats';

const NOW = new Date('2026-04-27T12:00:00.000Z');

function atom(partial: Partial<PrincipalStatsAtom> & { principal_id: string; type: string }): PrincipalStatsAtom {
  return { ...partial };
}

describe('buildPrincipalStatsResponse', () => {
  it('returns an empty stats map for an empty atom set', () => {
    const r = buildPrincipalStatsResponse([], NOW);
    expect(r.stats).toEqual({});
    expect(r.generated_at).toBe('2026-04-27T12:00:00.000Z');
  });

  it('counts live atoms per principal by type', () => {
    const atoms: PrincipalStatsAtom[] = [
      atom({ principal_id: 'cto', type: 'plan' }),
      atom({ principal_id: 'cto', type: 'plan' }),
      atom({ principal_id: 'cto', type: 'observation' }),
      atom({ principal_id: 'cpo', type: 'plan' }),
      atom({ principal_id: 'cpo', type: 'decision' }),
    ];
    const r = buildPrincipalStatsResponse(atoms, NOW);
    expect(r.stats['cto']).toEqual({
      total: 3,
      by_type: { plan: 2, observation: 1 },
    });
    expect(r.stats['cpo']).toEqual({
      total: 2,
      by_type: { plan: 1, decision: 1 },
    });
  });

  it('omits principals with zero live atoms', () => {
    const atoms: PrincipalStatsAtom[] = [
      // All atoms for this principal are superseded.
      atom({ principal_id: 'p1', type: 'plan', superseded_by: ['x'] }),
      atom({ principal_id: 'p2', type: 'plan' }),
    ];
    const r = buildPrincipalStatsResponse(atoms, NOW);
    expect(r.stats['p1']).toBeUndefined();
    expect(r.stats['p2']).toEqual({
      total: 1,
      by_type: { plan: 1 },
    });
  });

  it('filters out superseded atoms', () => {
    const atoms: PrincipalStatsAtom[] = [
      atom({ principal_id: 'p1', type: 'plan' }),
      atom({ principal_id: 'p1', type: 'plan', superseded_by: ['x'] }),
    ];
    const r = buildPrincipalStatsResponse(atoms, NOW);
    expect(r.stats['p1']).toEqual({ total: 1, by_type: { plan: 1 } });
  });

  it('filters out tainted atoms', () => {
    const atoms: PrincipalStatsAtom[] = [
      atom({ principal_id: 'p1', type: 'plan', taint: 'clean' }),
      atom({ principal_id: 'p1', type: 'plan', taint: 'compromised' }),
    ];
    const r = buildPrincipalStatsResponse(atoms, NOW);
    expect(r.stats['p1']).toEqual({ total: 1, by_type: { plan: 1 } });
  });

  it('skips atoms with empty or non-string principal_id', () => {
    /*
     * Defensive: atoms without a principal id (e.g. legacy or
     * malformed) should not pollute the count. The wire payload
     * would not be useful for them either since the consumer
     * indexes by principal_id.
     */
    const atoms: PrincipalStatsAtom[] = [
      atom({ principal_id: '', type: 'plan' }),
      atom({ principal_id: 'p1', type: 'plan' }),
    ];
    const r = buildPrincipalStatsResponse(atoms, NOW);
    expect(Object.keys(r.stats)).toEqual(['p1']);
  });
});
