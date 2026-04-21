import { describe, expect, it } from 'vitest';
import { decayedConfidence, shouldUpdateConfidence } from '../../src/loop/decay.js';
import type { Atom, Time } from '../../src/substrate/types.js';
import { DEFAULT_HALF_LIVES } from '../../src/loop/types.js';
import { sampleAtom } from '../fixtures.js';

describe('decayedConfidence', () => {
  it('returns confidence unchanged when zero time has passed', () => {
    const atom = sampleAtom({
      confidence: 0.8,
      type: 'decision',
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    });
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    expect(decayedConfidence(atom, nowMs)).toBe(0.8);
  });

  it('halves confidence after one half-life', () => {
    const atom = sampleAtom({
      confidence: 0.8,
      type: 'decision',
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    });
    const halfLife = DEFAULT_HALF_LIVES.decision;
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z') + halfLife;
    expect(decayedConfidence(atom, nowMs)).toBeCloseTo(0.4, 3);
  });

  it('respects a per-call halfLives override', () => {
    const atom = sampleAtom({
      confidence: 1.0,
      type: 'decision',
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    });
    const customHalfLives = { ...DEFAULT_HALF_LIVES, decision: 1000 };
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z') + 1000;
    expect(decayedConfidence(atom, nowMs, customHalfLives)).toBeCloseTo(0.5, 3);
  });

  it('directives decay much slower than ephemerals', () => {
    const ephemeralAtom = sampleAtom({
      type: 'ephemeral',
      confidence: 1.0,
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    });
    const directiveAtom = sampleAtom({
      type: 'directive',
      confidence: 1.0,
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    });
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z') + 30 * 24 * 60 * 60 * 1000; // 30 days
    const ephemeralNow = decayedConfidence(ephemeralAtom, nowMs);
    const directiveNow = decayedConfidence(directiveAtom, nowMs);
    expect(ephemeralNow).toBeLessThan(directiveNow);
  });

  it('floors at minConfidence for very old atoms', () => {
    const atom = sampleAtom({
      type: 'ephemeral',
      confidence: 1.0,
      last_reinforced_at: '2020-01-01T00:00:00.000Z' as Time,
    });
    const nowMs = Date.parse('2030-01-01T00:00:00.000Z'); // 10 years later
    const result = decayedConfidence(atom, nowMs, DEFAULT_HALF_LIVES, 0.02);
    expect(result).toBe(0.02);
  });

  it('skips superseded atoms', () => {
    const atom = sampleAtom({
      confidence: 0.8,
      type: 'decision',
      superseded_by: ['new-atom' as never],
      last_reinforced_at: '2020-01-01T00:00:00.000Z' as Time,
    });
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    expect(decayedConfidence(atom, nowMs)).toBe(0.8);
  });
});

describe('shouldUpdateConfidence', () => {
  it('ignores tiny numerical noise', () => {
    expect(shouldUpdateConfidence(0.5, 0.5 + 1e-6)).toBe(false);
  });
  it('triggers an update when change exceeds epsilon', () => {
    expect(shouldUpdateConfidence(0.5, 0.48)).toBe(true);
  });
});
