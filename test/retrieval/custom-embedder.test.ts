/**
 * Proof that a custom Embedder plumbs through createMemoryHost and
 * createFileHost end-to-end: the retrieval order produced by
 * `host.atoms.search` reflects the injected embedder's scoring, not
 * the trigram default.
 *
 * Strategy: build an oracle embedder that returns a one-hot vector per
 * predeclared cluster tag. Seed atoms tagged with two clusters. Query
 * with the tag. The injected embedder picks the correctly-tagged atoms
 * above all others; the trigram embedder (no shared trigrams between
 * tag strings like "c1" and atom content) could not have.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { TrigramEmbedder } from '../../src/retrieval/trigram-embedder.js';
import type { Embedder } from '../../src/substrate/interface.js';
import type { AtomId, Vector } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

/**
 * Oracle embedder. Inputs map to one-hot vectors based on substring
 * lookup: if the input contains 'c1', return [1,0,0]; 'c2' → [0,1,0];
 * else → [0,0,1]. Cosine similarity then cleanly separates c1-tagged
 * atoms from c2-tagged atoms from untagged atoms, even though the
 * trigram embedder would not distinguish them meaningfully.
 */
class OracleEmbedder implements Embedder {
  async embed(text: string): Promise<Vector> {
    const t = text.toLowerCase();
    if (t.includes('c1')) return [1, 0, 0];
    if (t.includes('c2')) return [0, 1, 0];
    return [0, 0, 1];
  }
  similarity(a: Vector, b: Vector): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dot += ai * bi;
      na += ai * ai;
      nb += bi * bi;
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }
}

describe('Custom Embedder plumbs through createMemoryHost', () => {
  it('injected embedder drives search ranking; trigram default would not', async () => {
    const host = createMemoryHost({ embedder: new OracleEmbedder() });
    await host.atoms.put(sampleAtom({
      id: 'c1_a' as AtomId,
      content: 'atom tagged c1 (first)',
    }));
    await host.atoms.put(sampleAtom({
      id: 'c1_b' as AtomId,
      content: 'atom tagged c1 (second)',
    }));
    await host.atoms.put(sampleAtom({
      id: 'c2_a' as AtomId,
      content: 'atom tagged c2 (first)',
    }));
    await host.atoms.put(sampleAtom({
      id: 'unt' as AtomId,
      content: 'untagged atom with lots of unrelated words',
    }));

    const hits = await host.atoms.search('query for c1 only', 10);
    // Top 2 should both be c1-tagged. Trigram would not reliably do this
    // (the literal "c1" is too short for trigram distinction).
    expect(hits.slice(0, 2).map(h => h.atom.id).sort()).toEqual(['c1_a', 'c1_b']);
  });

  it('omitting embedder falls back to trigram (default preserved)', async () => {
    // No embedder override -> TrigramEmbedder instance used internally.
    const host = createMemoryHost();
    const v1 = await host.atoms.embed('postgres database');
    const v2 = await new TrigramEmbedder().embed('postgres database');
    expect(v1).toEqual(v2);
  });
});

describe('Custom Embedder plumbs through createFileHost', () => {
  let rootDir: string;
  let host: FileHost;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-custom-embed-'));
    host = await createFileHost({
      rootDir,
      embedder: new OracleEmbedder(),
    });
  });

  afterEach(async () => {
    try { await host.cleanup(); } catch { /* ignore */ }
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('injected embedder drives search ranking on the file adapter', async () => {
    await host.atoms.put(sampleAtom({
      id: 'f_c1' as AtomId,
      content: 'file-backed atom tagged c1',
    }));
    await host.atoms.put(sampleAtom({
      id: 'f_c2' as AtomId,
      content: 'file-backed atom tagged c2',
    }));

    const hits = await host.atoms.search('any query mentioning c1', 5);
    expect(hits[0]?.atom.id).toBe('f_c1');
  });
});
