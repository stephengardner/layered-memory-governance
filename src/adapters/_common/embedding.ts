import type { Vector } from '../../substrate/types.js';

const DEFAULT_DIM = 128;

/**
 * Deterministic character-trigram frequency embedding.
 *
 * Not semantically sophisticated. Produces measurable similarity for texts
 * that share character n-grams. Good enough for tests, conformance, and
 * simulation scenarios where we need retrieval to behave predictably.
 *
 * Real embedders (OpenAI, cohere, chroma default, local ONNX) drop in by
 * implementing the same AtomStore.embed contract.
 *
 * Guarantee: embed(x) === embed(x) byte-for-byte across calls within a
 * process lifetime. Conformance test verifies this.
 */
export function embedTrigrams(text: string, dim: number = DEFAULT_DIM): Vector {
  const v = new Array<number>(dim).fill(0);
  const normalized = text.toLowerCase();
  if (normalized.length < 3) {
    return Object.freeze(v);
  }
  for (let i = 0; i <= normalized.length - 3; i++) {
    const trigram = normalized.slice(i, i + 3);
    const idx = fnv1a(trigram) % dim;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  // L2-normalize
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return Object.freeze(v);
  const normalized_v = v.map(x => x / norm);
  return Object.freeze(normalized_v);
}

/** FNV-1a 32-bit hash. Fast, deterministic, no dependencies. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
