/**
 * Onnx + CachingEmbedder: functional + timing proof.
 *
 * Seeds N atoms, runs a search (cold: every atom embeds, cache fills).
 * Constructs a fresh CachingEmbedder wrapping a COUNTING onnx at the
 * same rootDir (simulating a new process) and runs the same search
 * (warm: every atom's vector comes from disk, counter stays at zero).
 *
 * Assertions:
 *   - cold phase: counter == N (or N+1 if query is not cached) → inner
 *     embedder was called for every unique text
 *   - warm phase: counter == 0 → every embed came from disk, no inner
 *     work whatsoever
 *
 * Timing numbers are printed for operational visibility but not asserted.
 * Earlier attempts used `warm < cold / K` assertions; under parallel
 * gated test load the ratio can collapse to 2-3x purely from FS
 * contention, even though functionally the cache is working perfectly.
 * Counting inner calls captures the real invariant.
 *
 * Gated by LAG_REAL_EMBED=1 because it loads the ~90MB onnx model.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CachingEmbedder } from '../../src/adapters/_common/caching-embedder.js';
import { OnnxMiniLmEmbedder } from '../../src/adapters/_common/onnx-minilm-embedder.js';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import type { Embedder } from '../../src/substrate/interface.js';
import type { AtomId, Vector } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const RUN = process.env['LAG_REAL_EMBED'] === '1';
const describeMaybe = RUN ? describe : describe.skip;

const N_ATOMS = 200;

/**
 * Decorator that counts inner.embed calls while preserving the id +
 * similarity + embed contract of OnnxMiniLmEmbedder.
 */
class CountingOnnx implements Embedder {
  readonly id: string;
  public calls = 0;
  private readonly inner: OnnxMiniLmEmbedder;

  constructor() {
    this.inner = new OnnxMiniLmEmbedder();
    this.id = this.inner.id;
  }
  async embed(text: string): Promise<Vector> {
    this.calls += 1;
    return this.inner.embed(text);
  }
  similarity(a: Vector, b: Vector): number {
    return this.inner.similarity(a, b);
  }
  async warmup(): Promise<void> {
    await this.inner.embed('warmup');
  }
}

describeMaybe('Onnx + CachingEmbedder: disk cache eliminates first-query cost', () => {
  it('warm phase makes zero inner.embed calls (all reads from disk)', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lag-onnx-cache-'));
    try {
      // --- Cold: fresh onnx, fresh disk cache ---
      const countingCold = new CountingOnnx();
      await countingCold.warmup();
      const warmupCalls = countingCold.calls;

      const cachedCold = new CachingEmbedder(countingCold, { rootDir });
      const hostCold = createMemoryHost({ embedder: cachedCold });
      for (let i = 0; i < N_ATOMS; i++) {
        await hostCold.atoms.put(sampleAtom({
          id: (`atom_${i}`) as AtomId,
          content: `Atom ${i} talks about postgres and transactional writes`,
        }));
      }

      const coldStart = Date.now();
      await hostCold.atoms.search('postgres transactions', 10);
      const coldMs = Date.now() - coldStart;
      const coldCalls = countingCold.calls - warmupCalls;

      // Cold phase: query (1) + N unique atom contents = N+1 calls.
      expect(coldCalls).toBe(N_ATOMS + 1);

      // --- Warm: new CachingEmbedder at SAME rootDir with a fresh
      // counting onnx. Re-seed atoms so MemoryAtomStore has them.
      const countingWarm = new CountingOnnx();
      await countingWarm.warmup();
      const warmWarmupCalls = countingWarm.calls;

      const cachedWarm = new CachingEmbedder(countingWarm, { rootDir });
      const hostWarm = createMemoryHost({ embedder: cachedWarm });
      for (let i = 0; i < N_ATOMS; i++) {
        await hostWarm.atoms.put(sampleAtom({
          id: (`atom_${i}`) as AtomId,
          content: `Atom ${i} talks about postgres and transactional writes`,
        }));
      }

      const warmStart = Date.now();
      await hostWarm.atoms.search('postgres transactions', 10);
      const warmMs = Date.now() - warmStart;
      const warmCalls = countingWarm.calls - warmWarmupCalls;

      // eslint-disable-next-line no-console
      console.log(
        `onnx cache proof | N=${N_ATOMS} ` +
        `cold=${coldMs}ms/${coldCalls} inner-calls ` +
        `warm=${warmMs}ms/${warmCalls} inner-calls ` +
        `speedup=${(coldMs / Math.max(warmMs, 1)).toFixed(1)}x`,
      );

      // The invariant: warm phase hits disk cache for every text → zero
      // inner calls. This assertion is environment-independent.
      expect(warmCalls).toBe(0);

      // And cold > warm in wall time (sanity; if this ever inverts,
      // something is very wrong). Loose check; the real proof is above.
      expect(coldMs).toBeGreaterThan(warmMs);
    } finally {
      try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 180_000);
});
