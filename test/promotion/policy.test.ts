import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/promotion/policy.js';
import type { PromotionCandidate } from '../../src/promotion/types.js';
import type { Atom } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

function candidate(atom: Atom, overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    atom,
    consensusAtoms: [atom],
    consensusCount: 1,
    validation: 'unverifiable',
    ...overrides,
  };
}

describe('promotion policy.evaluate', () => {
  it('rejects when source layer is wrong for target', () => {
    const atom = sampleAtom({ layer: 'L2' }); // already L2
    const decision = evaluate(candidate(atom, { consensusCount: 5 }), 'L2');
    expect(decision.canPromote).toBe(false);
    expect(decision.reasons.some(r => r.includes('source'))).toBe(true);
  });

  it('rejects when atom is superseded', () => {
    const atom = sampleAtom({ layer: 'L1', superseded_by: ['other'] as never });
    const decision = evaluate(
      candidate(atom, { consensusCount: 5 }),
      'L2',
    );
    expect(decision.canPromote).toBe(false);
    expect(decision.reasons.some(r => r.includes('superseded'))).toBe(true);
  });

  it('rejects tainted atoms', () => {
    const atom = sampleAtom({ layer: 'L1', taint: 'tainted', confidence: 0.9 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 5 }),
      'L2',
    );
    expect(decision.canPromote).toBe(false);
    expect(decision.reasons.some(r => r.includes('taint'))).toBe(true);
  });

  it('rejects when confidence below threshold', () => {
    const atom = sampleAtom({ layer: 'L1', confidence: 0.3 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 5 }),
      'L2',
    );
    expect(decision.canPromote).toBe(false);
    expect(decision.reasons.some(r => r.includes('confidence'))).toBe(true);
  });

  it('rejects when consensus below threshold', () => {
    const atom = sampleAtom({ layer: 'L1', confidence: 0.9 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 1 }),
      'L2',
    );
    expect(decision.canPromote).toBe(false);
    expect(decision.reasons.some(r => r.includes('consensus'))).toBe(true);
  });

  it('L3 promotion requires validation != invalid when requireValidation=true', () => {
    const atom = sampleAtom({ layer: 'L2', confidence: 0.95 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 5, validation: 'invalid' }),
      'L3',
    );
    expect(decision.canPromote).toBe(false);
    expect(decision.reasons.some(r => r.includes('validation'))).toBe(true);
  });

  it('L3 promotion allows validation=unverifiable by default', () => {
    const atom = sampleAtom({ layer: 'L2', confidence: 0.95 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 5, validation: 'unverifiable' }),
      'L3',
    );
    expect(decision.canPromote).toBe(true);
  });

  it('L2 promotion passes when all thresholds met', () => {
    const atom = sampleAtom({ layer: 'L1', confidence: 0.8 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 3 }),
      'L2',
    );
    expect(decision.canPromote).toBe(true);
  });

  it('custom thresholds override defaults', () => {
    const atom = sampleAtom({ layer: 'L1', confidence: 0.4 });
    const decision = evaluate(
      candidate(atom, { consensusCount: 1 }),
      'L2',
      {
        L2: { minConfidence: 0.2, minConsensus: 1, requireValidation: false },
        L3: { minConfidence: 0.99, minConsensus: 10, requireValidation: true },
      },
    );
    expect(decision.canPromote).toBe(true);
  });
});
