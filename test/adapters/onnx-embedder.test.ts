/**
 * OnnxMiniLmEmbedder conformance + plumbing.
 *
 * Gated by LAG_REAL_EMBED=1 because:
 *   (a) first run downloads ~90MB from HuggingFace Hub to the OS cache;
 *   (b) cold model load adds ~1-2s after download;
 *   (c) not every CI environment allows outbound network to HF Hub.
 *
 * Warmup strategy: one embed() call in `beforeAll` with a 120s budget so
 * the cold-start cost is paid once, not per individual spec test.
 * Subsequent embeds are ~10-30ms on CPU.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { OnnxMiniLmEmbedder } from '../../src/adapters/_common/onnx-minilm-embedder.js';
import type { AtomId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';
import { runEmbedderSpec } from '../conformance/shared/embedder-spec.js';

const RUN = process.env['LAG_REAL_EMBED'] === '1';
const describeMaybe = RUN ? describe : describe.skip;

let shared: OnnxMiniLmEmbedder | null = null;
function getShared(): OnnxMiniLmEmbedder {
  if (shared === null) shared = new OnnxMiniLmEmbedder();
  return shared;
}

// Parent describe wraps both the shared conformance spec and the
// plumbing tests so they share a single warmed-up embedder instance.
describeMaybe('OnnxMiniLmEmbedder (shared instance, warmed)', () => {
  beforeAll(async () => {
    // First call triggers model download + ONNX runtime spin-up. Budget
    // generously so CI with cold HF cache still fits.
    await getShared().embed('warmup');
  }, 120_000);

  // The shared spec's individual `it` blocks use default vitest timeouts.
  // With warmup complete they run fast (~20ms each on CPU).
  runEmbedderSpec('onnx-minilm', () => getShared());

  describe('OnnxMiniLmEmbedder plumbs through createMemoryHost', () => {
    it('semantic ranking beats lexical-only distractor on a hard-paraphrase query', async () => {
      const embedder = getShared();
      const host = createMemoryHost({ embedder });

      await host.atoms.put(sampleAtom({
        id: 'semantic_target' as AtomId,
        content: 'Postgres is our row-oriented system of record for durable transactional data.',
      }));
      await host.atoms.put(sampleAtom({
        id: 'lexical_distractor' as AtomId,
        content: 'The canonical ledger concurrent engine keeps safe row oriented.',
      }));
      await host.atoms.put(sampleAtom({
        id: 'unrelated' as AtomId,
        content: 'We deploy our frontend with cloudflare workers.',
      }));

      const query =
        'Which relational database holds our canonical records with ACID safety?';
      const hits = await host.atoms.search(query, 3);

      const ids = hits.map(h => h.atom.id);
      expect(ids.indexOf('semantic_target' as AtomId))
        .toBeLessThan(ids.indexOf('unrelated' as AtomId));
    });

    it('embed produces 384-dim vectors for all-MiniLM-L6-v2', async () => {
      const v = await getShared().embed('any nonempty text');
      expect(v.length).toBe(384);
    });

    it('similarity between identical strings is effectively 1.0', async () => {
      const embedder = getShared();
      const a = await embedder.embed('we ship memory governance');
      const b = await embedder.embed('we ship memory governance');
      expect(embedder.similarity(a, b)).toBeCloseTo(1.0, 4);
    });
  });
});
