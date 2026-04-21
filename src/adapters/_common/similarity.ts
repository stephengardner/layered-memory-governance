import type { Vector } from '../../substrate/types.js';

/**
 * Cosine similarity of two vectors. Returns a value in [-1, 1].
 * Returns 0 when either vector is all-zero (convention; no similarity signal).
 *
 * Pure, synchronous, no hidden state.
 */
export function cosine(a: Vector, b: Vector): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Normalize cosine similarity from [-1, 1] to [0, 1] for SearchHit.score. */
export function cosineToScore(cos: number): number {
  return (cos + 1) / 2;
}
