import { describe, expect, it } from 'vitest';
import { renderCanonMarkdown } from '../../src/canon-md/generator.js';
import type { AtomId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

describe('renderCanonMarkdown', () => {
  it('renders a placeholder when no atoms', () => {
    const md = renderCanonMarkdown([]);
    expect(md).toContain('LAG Canon');
    expect(md).toContain('No canon atoms yet');
  });

  it('includes auto-managed-notice and avoids literal marker strings', () => {
    // The generator intentionally avoids literal HTML-comment marker strings
    // in its prose. Early versions included them as a "do not edit" note, but
    // that confused the marker-detection logic on subsequent reads (the first
    // `<!-- lag:canon-end -->` it found was in the note, not the real end).
    const md = renderCanonMarkdown([sampleAtom()]);
    expect(md).toContain('Auto-managed');
    expect(md).toContain('LAG Canon');
    expect(md).not.toContain('lag:canon-start');
    expect(md).not.toContain('lag:canon-end');
  });

  it('groups atoms by type with section headings', () => {
    const md = renderCanonMarkdown([
      sampleAtom({ id: 'd1' as AtomId, type: 'decision', content: 'decide X' }),
      sampleAtom({ id: 'p1' as AtomId, type: 'preference', content: 'prefer Y' }),
      sampleAtom({ id: 'd2' as AtomId, type: 'decision', content: 'decide Z' }),
    ]);
    expect(md).toContain('## Decisions');
    expect(md).toContain('## Preferences');
    const decidesIdx = md.indexOf('## Decisions');
    const prefIdx = md.indexOf('## Preferences');
    expect(decidesIdx).toBeLessThan(prefIdx);
    expect(md).toContain('decide X');
    expect(md).toContain('decide Z');
    expect(md).toContain('prefer Y');
  });

  it('within a type, sorts by confidence desc', () => {
    const md = renderCanonMarkdown([
      sampleAtom({ type: 'decision', content: 'low', confidence: 0.5 }),
      sampleAtom({ type: 'decision', content: 'high', confidence: 0.95 }),
      sampleAtom({ type: 'decision', content: 'medium', confidence: 0.75 }),
    ]);
    const high = md.indexOf('high');
    const medium = md.indexOf('medium');
    const low = md.indexOf('low');
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
  });

  it('omits superseded and tainted atoms', () => {
    const md = renderCanonMarkdown([
      sampleAtom({ content: 'clean', type: 'decision' }),
      sampleAtom({ content: 'superseded', type: 'decision', superseded_by: ['x'] as never }),
      sampleAtom({ content: 'tainted', type: 'decision', taint: 'tainted' }),
    ]);
    expect(md).toContain('clean');
    expect(md).not.toContain('superseded');
    expect(md).not.toContain('tainted');
  });

  it('emits confidence by default but can be turned off', () => {
    const atoms = [sampleAtom({ content: 'x', type: 'decision', confidence: 0.73 })];
    const withConf = renderCanonMarkdown(atoms);
    expect(withConf).toContain('0.73');
    const withoutConf = renderCanonMarkdown(atoms, { showConfidence: false });
    expect(withoutConf).not.toContain('0.73');
  });

  it('uses provided now timestamp in the header', () => {
    const md = renderCanonMarkdown([], { now: '2030-05-05T05:05:05.505Z' });
    expect(md).toContain('2030-05-05T05:05:05.505Z');
  });

  it('renders new inbox V1 runtime atom types under distinct headings', () => {
    // Regression guard for the proactive-CTO inbox V1 type additions.
    // The canon applier filters to layer=L3 so these types never actually
    // reach CLAUDE.md in production, but renderCanonMarkdown is a pure
    // function callable by tools like a `lag inbox` CLI. The generator
    // must handle every declared AtomType without falling through the
    // capitalize() branch -- otherwise the section heading for, e.g.,
    // "actor-message" ends up as "Actor-message" instead of the
    // deliberate "Actor Messages".
    const md = renderCanonMarkdown([
      sampleAtom({ id: 'm1' as AtomId, type: 'actor-message', content: 'am1' }),
      sampleAtom({ id: 'a1' as AtomId, type: 'actor-message-ack', content: 'ack1' }),
      sampleAtom({ id: 't1' as AtomId, type: 'circuit-breaker-trip', content: 'trip1' }),
      sampleAtom({ id: 'r1' as AtomId, type: 'circuit-breaker-reset', content: 'reset1' }),
    ]);
    expect(md).toContain('## Actor Messages');
    expect(md).toContain('## Actor Message Acks');
    expect(md).toContain('## Circuit Breaker Trips');
    expect(md).toContain('## Circuit Breaker Resets');
    // And none of the capitalize() fallback variants should appear.
    expect(md).not.toContain('## Actor-message');
    expect(md).not.toContain('## Circuit-breaker-reset');
  });
});
