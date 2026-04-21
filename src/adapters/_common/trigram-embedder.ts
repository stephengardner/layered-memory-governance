/**
 * Default Embedder implementation: character trigrams hashed into a fixed
 * 128-dim vector, L2-normalized, scored by cosine similarity.
 *
 * See design/phase-15-findings.md for the measured behavior: trigram
 * handles exact / rearranged / synonym / paraphrase / adversarial at
 * >=0.95 top-1 on a 10K-atom synthetic palace; collapses on
 * hard-paraphrase where the query shares zero vocabulary with atom
 * content. Adequate as the V0 default.
 */

import type { Embedder } from '../../substrate/interface.js';
import type { Vector } from '../../substrate/types.js';
import { embedTrigrams } from './embedding.js';
import { cosine } from './similarity.js';

export class TrigramEmbedder implements Embedder {
  readonly id = 'trigram-fnv-128';
  private readonly cache = new Map<string, Vector>();

  async embed(text: string): Promise<Vector> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const vec = embedTrigrams(text);
    this.cache.set(text, vec);
    return vec;
  }

  /**
   * Raw cosine similarity in [-1, 1]. Matches AtomStore.similarity for
   * drop-in compatibility; AtomStore.search callers get the [0, 1]
   * SearchHit.score via cosineToScore() inside the store's search impl.
   */
  similarity(a: Vector, b: Vector): number {
    return cosine(a, b);
  }
}
