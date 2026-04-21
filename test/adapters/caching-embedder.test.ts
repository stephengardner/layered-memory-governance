/**
 * CachingEmbedder tests.
 *
 * Runs the shared embedder-spec conformance against a TrigramEmbedder
 * wrapped in CachingEmbedder (so no network / heavyweight models needed
 *; this test is not gated). Then adds plumbing tests that prove:
 *   - cache files land on disk under rootDir/embed-cache/<id>/<sha>.json
 *   - a fresh CachingEmbedder at the same rootDir reads the prior cache
 *     and does NOT call inner.embed on cache hits
 *   - a different embedder id lives in its own namespace
 *   - corrupt cache files are ignored and re-written
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachingEmbedder, cacheDirFor } from '../../src/adapters/_common/caching-embedder.js';
import { TrigramEmbedder } from '../../src/adapters/_common/trigram-embedder.js';
import type { Embedder } from '../../src/substrate/interface.js';
import type { Vector } from '../../src/substrate/types.js';
import { runEmbedderSpec } from '../conformance/shared/embedder-spec.js';

// --- Conformance (non-gated): CachingEmbedder wrapping trigram ---

runEmbedderSpec('caching(trigram)', () => {
  // Use a fresh tmp dir per instance so conformance doesn't bleed across
  // spec cases. The spec creates a new Embedder per test, so we must
  // generate a fresh cache path per call.
  const rootDir = join(tmpdir(), `lag-cache-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new CachingEmbedder(new TrigramEmbedder(), { rootDir });
});

// --- Plumbing ---

class CountingEmbedder implements Embedder {
  readonly id = 'counting-test';
  public calls = 0;
  private readonly inner = new TrigramEmbedder();
  async embed(text: string): Promise<Vector> {
    this.calls += 1;
    return this.inner.embed(text);
  }
  similarity(a: Vector, b: Vector): number {
    return this.inner.similarity(a, b);
  }
}

describe('CachingEmbedder: disk persistence + reuse across instances', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-cache-plumb-'));
  });

  afterEach(async () => {
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a JSON file per unique text under embed-cache/<id>/', async () => {
    const cached = new CachingEmbedder(new TrigramEmbedder(), { rootDir });
    await cached.embed('postgres transactions');
    await cached.embed('redis cache');

    const dir = cacheDirFor(rootDir, cached.id);
    const files = await readdir(dir);
    expect(files.length).toBe(2);
    expect(files.every(f => /^[0-9a-f]{64}\.json$/.test(f))).toBe(true);
  });

  it('a fresh instance at the same rootDir skips inner.embed on cache hits', async () => {
    const first = new CountingEmbedder();
    const cachedA = new CachingEmbedder(first, { rootDir });
    await cachedA.embed('shared text');
    expect(first.calls).toBe(1);

    // New process simulation: new CountingEmbedder, new CachingEmbedder,
    // same rootDir. Inner.embed must NOT be called this time.
    const second = new CountingEmbedder();
    const cachedB = new CachingEmbedder(second, { rootDir });
    const v = await cachedB.embed('shared text');
    expect(second.calls).toBe(0);
    expect(v.length).toBe(128); // trigram dim

    // Re-ask cachedB for a new text; should call inner.
    await cachedB.embed('different text');
    expect(second.calls).toBe(1);
  });

  it('different embedder ids live in separate cache namespaces', async () => {
    const a = new CachingEmbedder(new TrigramEmbedder(), { rootDir, embedderId: 'alpha' });
    const b = new CachingEmbedder(new TrigramEmbedder(), { rootDir, embedderId: 'beta' });
    await a.embed('same text');
    await b.embed('same text');

    const filesA = await readdir(cacheDirFor(rootDir, 'alpha'));
    const filesB = await readdir(cacheDirFor(rootDir, 'beta'));
    expect(filesA.length).toBe(1);
    expect(filesB.length).toBe(1);
  });

  it('corrupt cache file is ignored and replaced on next write', async () => {
    // Use the SAME embedder id for both instances so they share the
    // cache namespace. Explicit embedderId avoids inner.id mismatches.
    const sharedId = 'corrupt-test';
    const cached = new CachingEmbedder(new TrigramEmbedder(), { rootDir, embedderId: sharedId });
    // Seed a legitimate cache entry, then corrupt its file.
    await cached.embed('text');
    const dir = cacheDirFor(rootDir, sharedId);
    const [file] = await readdir(dir);
    const filePath = join(dir, file!);
    await writeFile(filePath, '{ this is not valid json', 'utf8');

    // Re-embed the same text via a fresh CachingEmbedder at the same
    // namespace: should detect corrupt file, ignore it, recompute, and
    // write a fresh vector.
    const counting = new CountingEmbedder();
    const fresh = new CachingEmbedder(counting, { rootDir, embedderId: sharedId });
    const v = await fresh.embed('text');
    expect(v.length).toBe(128);
    expect(counting.calls).toBe(1);

    // File should exist and parse cleanly now.
    const raw = await readFile(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('CachingEmbedder without inner id and without embedderId option throws at construction', () => {
    const noIdInner: Embedder = {
      embed: async () => [] as unknown as Vector,
      similarity: () => 0,
      // id intentionally omitted
    };
    expect(() => new CachingEmbedder(noIdInner, { rootDir })).toThrow(/no .*id/);
  });

  it('autopicks inner.id when embedderId is not supplied', () => {
    const cached = new CachingEmbedder(new TrigramEmbedder(), { rootDir });
    expect(cached.id).toBe('trigram-fnv-128');
  });

  it('explicit embedderId wins over inner.id', () => {
    const cached = new CachingEmbedder(new TrigramEmbedder(), { rootDir, embedderId: 'custom' });
    expect(cached.id).toBe('custom');
  });

  it('writes and reads a vector with the exact values from inner.embed', async () => {
    const cached = new CachingEmbedder(new TrigramEmbedder(), { rootDir });
    const v1 = await cached.embed('deterministic');

    // Fresh instance at same rootDir; read-back path.
    const counting = new CountingEmbedder();
    const fresh = new CachingEmbedder(counting, { rootDir, embedderId: cached.id });
    const v2 = await fresh.embed('deterministic');
    expect(counting.calls).toBe(0);

    expect(v2.length).toBe(v1.length);
    for (let i = 0; i < v1.length; i++) {
      expect(v2[i]).toBeCloseTo(v1[i]!, 10);
    }
  });

  it('cache dir is created lazily (no mkdir until first write)', async () => {
    new CachingEmbedder(new TrigramEmbedder(), { rootDir });
    // No embed call: dir should not exist yet.
    const dir = cacheDirFor(rootDir, 'trigram-fnv-128');
    let exists = false;
    try {
      await readdir(dir);
      exists = true;
    } catch { /* enoent = not created */ }
    expect(exists).toBe(false);
  });

  it('cache survives unreadable dir by falling through to inner (non-fatal)', async () => {
    // Point cache at a path that cannot be created (NUL on Windows, or
    // a subdirectory of a read-only parent on Unix). We construct a
    // legit dir, mkdir a file-with-same-name as the expected subdir, so
    // mkdir(recursive) fails. This is more reliable cross-platform.
    const blockerPath = join(rootDir, 'embed-cache');
    // Create a FILE where a directory is expected.
    await writeFile(blockerPath, 'blocker', 'utf8');

    const counting = new CountingEmbedder();
    const cached = new CachingEmbedder(counting, { rootDir });
    // Should not throw; just logs and proceeds.
    const v = await cached.embed('forced fallback');
    expect(v.length).toBe(128);
    expect(counting.calls).toBe(1);

    // Clean up the blocker so afterEach rm can succeed.
    await rm(blockerPath, { force: true });
  });
});

// --- Host plumbing: CachingEmbedder passed via createFileHost ---

describe('CachingEmbedder wired into createFileHost', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-cache-host-'));
  });

  afterEach(async () => {
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('FileHost searches use the cached embedder end-to-end', async () => {
    const { createFileHost } = await import('../../src/adapters/file/index.js');
    const counting = new CountingEmbedder();
    const cached = new CachingEmbedder(counting, { rootDir });

    const host = await createFileHost({ rootDir, embedder: cached });
    // Seed a handful of atoms. No embeds happen on put().
    const { sampleAtom } = await import('../fixtures.js');
    for (let i = 0; i < 3; i++) {
      await host.atoms.put(sampleAtom({
        id: (`a${i}`) as import('../../src/substrate/types.js').AtomId,
        content: `atom ${i} content about postgres`,
      }));
    }
    expect(counting.calls).toBe(0);

    // First search triggers embeds for query + 3 atoms.
    await host.atoms.search('postgres', 3);
    const firstCalls = counting.calls;
    expect(firstCalls).toBeGreaterThan(0);

    // Second search (same query) hits the in-process memory cache AND
    // the disk cache for the atoms; so counting.calls should NOT grow.
    await host.atoms.search('postgres', 3);
    expect(counting.calls).toBe(firstCalls);
  });
});
// Used imports kept satisfied.
void mkdir;
