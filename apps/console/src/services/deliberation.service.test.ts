import { describe, it, expect } from 'vitest';
import { _internal, extractPlanTitle } from './deliberation.service';

const baseAtom = {
  id: 'plan-test',
  type: 'plan',
  layer: 'L1',
  content: '# A title here\n\nbody',
  principal_id: 'cto-actor',
  confidence: 0.88,
  created_at: '2026-04-25T00:00:00.000Z',
  taint: 'clean',
};

describe('deliberation.service helpers', () => {
  it('extractPlanTitle pulls a leading heading', () => {
    expect(extractPlanTitle('# Hello world\n\nbody')).toBe('Hello world');
    expect(extractPlanTitle('## Sub-heading')).toBe('Sub-heading');
    expect(extractPlanTitle('plain text first')).toBeNull();
    expect(extractPlanTitle('')).toBeNull();
  });

  it('alternativesOf normalizes both string and {option,reason} shapes', () => {
    const atom = {
      ...baseAtom,
      metadata: {
        alternatives_rejected: [
          'just a string alternative',
          { option: 'structured option', reason: 'structured reason' },
        ],
      },
    };
    const out = _internal.alternativesOf(atom as unknown as Parameters<typeof _internal.alternativesOf>[0]);
    expect(out).toEqual([
      { option: 'just a string alternative' },
      { option: 'structured option', reason: 'structured reason' },
    ]);
  });

  it('citationsOf dedupes derived_from entries while preserving order', () => {
    const atom = {
      ...baseAtom,
      provenance: {
        derived_from: ['intent-a', 'inv-b', 'intent-a', 'pol-c', '', 'inv-b'],
      },
    };
    const out = _internal.citationsOf(atom as unknown as Parameters<typeof _internal.citationsOf>[0]);
    expect(out.map((c) => c.atom_id)).toEqual(['intent-a', 'inv-b', 'pol-c']);
  });

  it('principlesOf filters non-string entries defensively', () => {
    const atom = {
      ...baseAtom,
      metadata: {
        principles_applied: ['inv-x', '', 'dev-y', 7 as unknown as string, 'pol-z'],
      },
    };
    const out = _internal.principlesOf(atom as unknown as Parameters<typeof _internal.principlesOf>[0]);
    expect(out).toEqual(['inv-x', 'dev-y', 'pol-z']);
  });

  // Regression: a planner sometimes lists the same principle twice
  // (e.g. once as the entry it applied, once as a tail-anchor). The
  // View renders these with `key={p}` so a duplicate would trip
  // React's unique-key invariant. Mirror the citationsOf dedupe.
  it('principlesOf dedupes while preserving first-seen order', () => {
    const atom = {
      ...baseAtom,
      metadata: {
        principles_applied: ['inv-x', 'dev-y', 'inv-x', 'pol-z', 'dev-y'],
      },
    };
    const out = _internal.principlesOf(atom as unknown as Parameters<typeof _internal.principlesOf>[0]);
    expect(out).toEqual(['inv-x', 'dev-y', 'pol-z']);
  });

  // Regression: a malformed atom (alternatives_rejected: null, an
  // object, or any non-array) used to throw inside .map and break
  // listDeliberations + getDeliberation for the entire store. The
  // Array.isArray guard at the source returns an empty list instead.
  it('alternativesOf falls back to empty when raw is not an array', () => {
    for (const bad of [null, undefined, 'string', 7, { not: 'array' }]) {
      const atom = { ...baseAtom, metadata: { alternatives_rejected: bad as unknown } };
      const out = _internal.alternativesOf(atom as unknown as Parameters<typeof _internal.alternativesOf>[0]);
      expect(out).toEqual([]);
    }
  });

  it('citationsOf falls back to empty when derived_from is not an array', () => {
    for (const bad of [null, undefined, 'string', 7, { not: 'array' }]) {
      const atom = { ...baseAtom, provenance: { derived_from: bad as unknown } };
      const out = _internal.citationsOf(atom as unknown as Parameters<typeof _internal.citationsOf>[0]);
      expect(out).toEqual([]);
    }
  });

  it('principlesOf falls back to empty when principles_applied is not an array', () => {
    for (const bad of [null, undefined, 'string', 7, { not: 'array' }]) {
      const atom = { ...baseAtom, metadata: { principles_applied: bad as unknown } };
      const out = _internal.principlesOf(atom as unknown as Parameters<typeof _internal.principlesOf>[0]);
      expect(out).toEqual([]);
    }
  });

  it('whatBreaksOf accepts both spelling variants', () => {
    const a = _internal.whatBreaksOf({ ...baseAtom, metadata: { what_breaks_if_revisit: 'A' } } as unknown as Parameters<typeof _internal.whatBreaksOf>[0]);
    expect(a).toBe('A');
    const b = _internal.whatBreaksOf({ ...baseAtom, metadata: { what_breaks_if_revisited: 'B' } } as unknown as Parameters<typeof _internal.whatBreaksOf>[0]);
    expect(b).toBe('B');
    const c = _internal.whatBreaksOf({ ...baseAtom, metadata: {} } as unknown as Parameters<typeof _internal.whatBreaksOf>[0]);
    expect(c).toBeNull();
  });

  it('titleOf prefers metadata.title, then a content heading, then atom id', () => {
    const m = _internal.titleOf({
      ...baseAtom,
      content: '# Heading title',
      metadata: { title: 'Meta title' },
    } as unknown as Parameters<typeof _internal.titleOf>[0]);
    expect(m).toBe('Meta title');

    const h = _internal.titleOf({
      ...baseAtom,
      content: '# Heading title',
    } as unknown as Parameters<typeof _internal.titleOf>[0]);
    expect(h).toBe('Heading title');

    const id = _internal.titleOf({
      ...baseAtom,
      id: 'plan-fallback',
      content: 'no heading at all',
      metadata: undefined,
    } as unknown as Parameters<typeof _internal.titleOf>[0]);
    expect(id).toBe('plan-fallback');
  });
});
