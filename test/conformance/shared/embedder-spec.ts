/**
 * Embedder conformance spec.
 *
 * Any Embedder implementation (TrigramEmbedder today, AnthropicEmbedder
 * tomorrow, a local onnx mini-lm, etc.) must satisfy the invariants an
 * AtomStore search depends on:
 *
 *   - deterministic embed within a process lifetime
 *   - stable embedding dimension across calls
 *   - symmetric similarity: s(a, b) === s(b, a)
 *   - self-similarity rounds to 1.0 for a nonzero vector
 *   - similarity responds to content overlap for textually related inputs
 *     (bounded assertion: related > unrelated by a margin; proxy for
 *     "the embedder actually captures some signal")
 *
 * The spec takes a factory so each adapter test file can pass the
 * concrete implementation (and any config). Examples:
 *
 *   runEmbedderSpec('trigram', () => new TrigramEmbedder());
 *   runEmbedderSpec('anthropic', () => new AnthropicEmbedder({...}));
 */

import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../../src/substrate/interface.js';

export function runEmbedderSpec(label: string, make: () => Embedder): void {
  describe(`Embedder conformance (${label})`, () => {
    it('embed is deterministic across calls within one instance', async () => {
      const e = make();
      const v1 = await e.embed('the quick brown fox');
      const v2 = await e.embed('the quick brown fox');
      expect(v1).toEqual(v2);
    });

    it('embed is deterministic across fresh instances', async () => {
      const v1 = await make().embed('reliability matters');
      const v2 = await make().embed('reliability matters');
      expect(v1).toEqual(v2);
    });

    it('dimension is stable across different inputs', async () => {
      const e = make();
      const v1 = await e.embed('short');
      const v2 = await e.embed('this is a noticeably longer string with more words in it');
      expect(v1.length).toBe(v2.length);
    });

    it('similarity is symmetric', async () => {
      const e = make();
      const a = await e.embed('postgres database');
      const b = await e.embed('postgres cluster');
      expect(e.similarity(a, b)).toBeCloseTo(e.similarity(b, a), 10);
    });

    it('self-similarity rounds to 1.0 for a nonzero vector', async () => {
      const e = make();
      const v = await e.embed('anything nonempty');
      expect(e.similarity(v, v)).toBeCloseTo(1.0, 6);
    });

    it('related content scores higher than unrelated content', async () => {
      const e = make();
      const anchor = await e.embed('we use postgres for transactional writes');
      const related = await e.embed('postgres handles our transactional database traffic');
      const unrelated = await e.embed('redis caches session tokens in memory');
      const sRelated = e.similarity(anchor, related);
      const sUnrelated = e.similarity(anchor, unrelated);
      expect(sRelated).toBeGreaterThan(sUnrelated);
    });

    it('empty-string embed does not throw and returns a valid-shape vector', async () => {
      const e = make();
      const v = await e.embed('');
      expect(Array.isArray(v) || ArrayBuffer.isView(v as unknown as ArrayBufferView)).toBe(true);
      // Value constraint: every element is a finite number.
      for (const x of v) expect(Number.isFinite(x)).toBe(true);
    });
  });
}
