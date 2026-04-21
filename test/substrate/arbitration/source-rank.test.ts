import { describe, expect, it } from 'vitest';
import { sourceRank, sourceRankDecide } from '../../../src/substrate/arbitration/source-rank.js';
import type { ConflictPair } from '../../../src/substrate/arbitration/types.js';
import { sampleAtom } from '../../fixtures.js';

describe('sourceRank (scoring)', () => {
  it('L3 canon outranks L2 curated outranks L1 extracted outranks L0 raw', () => {
    const l0 = sampleAtom({ layer: 'L0' });
    const l1 = sampleAtom({ layer: 'L1' });
    const l2 = sampleAtom({ layer: 'L2' });
    const l3 = sampleAtom({ layer: 'L3' });
    expect(sourceRank(l0)).toBeLessThan(sourceRank(l1));
    expect(sourceRank(l1)).toBeLessThan(sourceRank(l2));
    expect(sourceRank(l2)).toBeLessThan(sourceRank(l3));
  });

  it('within a layer, user-directive outranks agent-observed', () => {
    const directive = sampleAtom({
      layer: 'L1',
      provenance: {
        kind: 'user-directive',
        source: {},
        derived_from: [],
      },
    });
    const observed = sampleAtom({
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: {},
        derived_from: [],
      },
    });
    expect(sourceRank(directive)).toBeGreaterThan(sourceRank(observed));
  });

  it('confidence only breaks ties', () => {
    const loConf = sampleAtom({ layer: 'L1', confidence: 0.1 });
    const hiConf = sampleAtom({ layer: 'L1', confidence: 0.9 });
    expect(sourceRank(hiConf)).toBeGreaterThan(sourceRank(loConf));
  });

  it('layer dominates provenance', () => {
    const lowLayerDirective = sampleAtom({
      layer: 'L0',
      provenance: {
        kind: 'user-directive',
        source: {},
        derived_from: [],
      },
    });
    const highLayerObserved = sampleAtom({
      layer: 'L2',
      provenance: {
        kind: 'agent-observed',
        source: {},
        derived_from: [],
      },
    });
    expect(sourceRank(highLayerObserved)).toBeGreaterThan(sourceRank(lowLayerDirective));
  });
});

describe('sourceRankDecide', () => {
  const pair = (a: Parameters<typeof sampleAtom>[0], b: Parameters<typeof sampleAtom>[0]): ConflictPair => ({
    a: sampleAtom(a),
    b: sampleAtom(b),
    kind: 'semantic',
    explanation: 'test',
  });

  it('higher-rank atom wins', () => {
    const p = pair(
      { layer: 'L1', provenance: { kind: 'agent-observed', source: {}, derived_from: [] } },
      { layer: 'L1', provenance: { kind: 'user-directive', source: {}, derived_from: [] } },
    );
    const outcome = sourceRankDecide(p);
    expect(outcome?.kind).toBe('winner');
    if (outcome?.kind === 'winner') {
      expect(outcome.winner).toBe(p.b.id);
      expect(outcome.loser).toBe(p.a.id);
    }
  });

  it('equal-rank pair returns null (tied, falls through)', () => {
    const p = pair({ layer: 'L1', confidence: 0.5 }, { layer: 'L1', confidence: 0.5 });
    expect(sourceRankDecide(p)).toBeNull();
  });

  it('either side can win depending on inputs', () => {
    const p1 = pair({ layer: 'L2' }, { layer: 'L1' });
    const o1 = sourceRankDecide(p1);
    expect(o1?.kind === 'winner' && o1.winner === p1.a.id).toBe(true);

    const p2 = pair({ layer: 'L1' }, { layer: 'L2' });
    const o2 = sourceRankDecide(p2);
    expect(o2?.kind === 'winner' && o2.winner === p2.b.id).toBe(true);
  });
});
