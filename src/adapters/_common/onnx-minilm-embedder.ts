/**
 * Local ONNX embedder: `all-MiniLM-L6-v2` via @huggingface/transformers.
 *
 * Architecturally load-bearing choice:
 *   - **Deterministic**: same content -> same 384-dim vector, today and a
 *     year from now. Audit, content-hash, and cross-session canon
 *     comparisons all depend on this.
 *   - **Private**: atom content never leaves the machine.
 *   - **Offline**: after first-run model download (cached by
 *     @huggingface/transformers under the OS cache dir), no network.
 *   - **No vendor lock-in**: MIT-licensed model, open-source runtime.
 *   - **Cheap**: ~10ms/embed on CPU after warmup. No per-call fees.
 *
 * Tradeoffs we are NOT hiding:
 *   - First-run pulls ~90MB from HuggingFace Hub. Fails in hermetic CI
 *     unless the cache is pre-populated. Surface a clear error if so.
 *   - Cold start adds ~1-2s to first embed() because the ONNX runtime
 *     loads the model into memory. Subsequent calls are fast.
 *   - Floating-point ops may differ in the last 1-2 bits across machines.
 *     We use SHA-256(content) for content hashes, not the vector, so this
 *     does not affect audit. Similarity comparisons are robust to that noise.
 *   - Vector dimension is 384 (not 128 as TrigramEmbedder). Mixing
 *     pre-computed vectors across embedders will throw in cosine.
 *
 * Usage:
 *   const host = createMemoryHost({ embedder: new OnnxMiniLmEmbedder() });
 *   // ... search(), embed(), similarity() now use the semantic embedder.
 */

import type { Embedder } from '../../substrate/interface.js';
import type { Vector } from '../../substrate/types.js';
import { cosine } from './similarity.js';

export interface OnnxMiniLmOptions {
  /**
   * HuggingFace model id to load. Defaults to 'Xenova/all-MiniLM-L6-v2',
   * the MIT-licensed ONNX port of sentence-transformers' all-MiniLM-L6-v2.
   * Other compatible options: 'Xenova/bge-small-en-v1.5',
   * 'Xenova/gte-small'. All produce 384-dim vectors; 768-dim models
   * (e.g. nomic-embed-text-v1.5) also work but change the dimension.
   */
  readonly modelId?: string;
  /**
   * If true, disable the in-process result cache. Default false; caching
   * is useful for repeated query embeds inside a single process.
   */
  readonly disableCache?: boolean;
}

/**
 * Type of the `extractor` pipeline returned by @huggingface/transformers.
 * We declare a minimal structural type to avoid leaking the package's
 * internals into our public surface.
 */
interface FeatureExtractor {
  (
    text: string | string[],
    options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean },
  ): Promise<{ data: Float32Array | ArrayLike<number>; dims: number[] }>;
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

export class OnnxMiniLmEmbedder implements Embedder {
  readonly id: string;
  private readonly modelId: string;
  private readonly cache: Map<string, Vector> | null;
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  constructor(options: OnnxMiniLmOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_MODEL;
    // Deterministic id derived from model id so the caching decorator
    // auto-invalidates if the user swaps models behind the same class.
    this.id = `onnx-${this.modelId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`;
    this.cache = options.disableCache ? null : new Map<string, Vector>();
  }

  async embed(text: string): Promise<Vector> {
    if (this.cache) {
      const hit = this.cache.get(text);
      if (hit) return hit;
    }
    const extractor = await this.loadExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    // `output.data` is a Float32Array of shape [1, dim]. Flatten to Vector.
    const data = output.data;
    const vec: number[] = [];
    for (let i = 0; i < data.length; i++) vec.push(Number(data[i]));
    const frozen = Object.freeze(vec) as Vector;
    if (this.cache) this.cache.set(text, frozen);
    return frozen;
  }

  /**
   * Raw cosine in [-1, 1]. Matches AtomStore.similarity contract;
   * AtomStore.search normalizes to [0, 1] for SearchHit.score.
   */
  similarity(a: Vector, b: Vector): number {
    return cosine(a, b);
  }

  /**
   * Lazy + memoized: the first caller triggers model load, subsequent
   * callers await the same promise. Surfaces load errors (network down,
   * cache corrupt, model id typo) at that await with context.
   */
  private async loadExtractor(): Promise<FeatureExtractor> {
    if (this.extractorPromise) return this.extractorPromise;
    this.extractorPromise = (async () => {
      try {
        const mod = await import('@huggingface/transformers');
        // Type-cast: the package exports `pipeline` as a function. We narrow
        // to our structural type because we only use this one shape.
        const pipe = (mod as unknown as {
          pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
        }).pipeline;
        const extractor = await pipe('feature-extraction', this.modelId);
        return extractor;
      } catch (err) {
        // Clear error if the package or model is unavailable.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `OnnxMiniLmEmbedder: failed to load model "${this.modelId}". ` +
            `Original error: ${msg}. ` +
            `First-run requires network access to HuggingFace Hub; ` +
            `subsequent runs use the cached model.`,
        );
      }
    })();
    return this.extractorPromise;
  }
}
