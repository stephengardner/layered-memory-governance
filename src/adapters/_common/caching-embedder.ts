/**
 * CachingEmbedder: a decorator that persists embedding vectors to disk,
 * keyed by `SHA-256(text)` under a per-embedder-id namespace.
 *
 * Motivation: `AtomStore.search` re-embeds every candidate atom, so the
 * first search of a fresh session re-pays the full corpus embedding cost.
 * For a semantic embedder (~10-20ms per embed) against a 10K-atom
 * palace, that's ~100s of cold latency; unacceptable interactively.
 * Caching embed results under `rootDir/embed-cache/<id>/<sha>.json` makes
 * the cost one-per-unique-text-ever.
 *
 * Design:
 *   - Composable: wraps ANY Embedder. Inner can be Onnx, Anthropic, or
 *     the trigram default. Similarity passes through untouched (no IO).
 *   - Namespaced by embedder id so switching embedders does NOT reuse
 *     vectors from a different output space.
 *   - Best-effort: cache IO failures (disk full, permission denied,
 *     corrupt file) are logged and fall through to the inner embedder.
 *     Only the inner embedder's errors propagate.
 *   - Atomic writes via tmp+rename so concurrent hosts don't see torn
 *     files. Multiple hosts racing on the same text compute redundantly
 *     but produce byte-identical results; last write wins, no corruption.
 *   - In-process Map cache wrapping the disk cache so repeat reads
 *     within the same process don't hit the fs twice.
 *
 * Usage:
 *   const inner = new OnnxMiniLmEmbedder();
 *   const cached = new CachingEmbedder(inner, { rootDir: hostRootDir });
 *   const host = createFileHost({ rootDir: hostRootDir, embedder: cached });
 *
 * Co-locating the cache under the same rootDir the FileHost uses means
 * cross-session is automatic: session B at the same rootDir sees session
 * A's embed cache.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Embedder } from '../../substrate/interface.js';
import type { Vector } from '../../substrate/types.js';

export interface CachingEmbedderOptions {
  /**
   * Directory under which this cache writes. The decorator creates
   * `<rootDir>/embed-cache/<embedderId>/` on first write. Passing the
   * FileHost's rootDir co-locates cache with atom state so the cross-
   * session primitive extends to embeddings.
   */
  readonly rootDir: string;
  /**
   * Override the embedder id used for cache namespacing. If omitted,
   * inner.id is used. Throws at construction if neither is set; the
   * decorator refuses to silently mix vectors across embedders.
   */
  readonly embedderId?: string;
  /**
   * If true, skip the in-process Map cache (only disk). Default false.
   * Useful only if memory pressure matters; the Map's keys are text
   * strings and values are 128-384 floats each, so ~3KB per unique text.
   */
  readonly disableMemoryCache?: boolean;
}

interface CacheFileShape {
  readonly embedderId: string;
  readonly vector: ReadonlyArray<number>;
}

export class CachingEmbedder implements Embedder {
  readonly id: string;
  private readonly inner: Embedder;
  private readonly cacheDir: string;
  private readonly memory: Map<string, Vector> | null;
  private ensuredDir = false;

  constructor(inner: Embedder, options: CachingEmbedderOptions) {
    const id = options.embedderId ?? inner.id;
    if (!id) {
      throw new Error(
        'CachingEmbedder: inner embedder has no `id` and no `embedderId` was provided. ' +
          'Refusing to silently mix vectors across embedder outputs.',
      );
    }
    this.id = id;
    this.inner = inner;
    this.cacheDir = join(options.rootDir, 'embed-cache', id);
    this.memory = options.disableMemoryCache ? null : new Map<string, Vector>();
  }

  similarity(a: Vector, b: Vector): number {
    return this.inner.similarity(a, b);
  }

  async embed(text: string): Promise<Vector> {
    // L1: in-process cache.
    if (this.memory) {
      const hit = this.memory.get(text);
      if (hit) return hit;
    }

    // L2: disk cache.
    const sha = sha256Hex(text);
    const filePath = join(this.cacheDir, `${sha}.json`);
    const fromDisk = await tryReadCache(filePath, this.id);
    if (fromDisk) {
      const frozen = Object.freeze(fromDisk.slice()) as Vector;
      if (this.memory) this.memory.set(text, frozen);
      return frozen;
    }

    // L3: compute and persist.
    const vec = await this.inner.embed(text);
    if (this.memory) this.memory.set(text, vec);
    await this.tryWriteCache(filePath, vec);
    return vec;
  }

  private async tryWriteCache(filePath: string, vec: Vector): Promise<void> {
    if (!this.ensuredDir) {
      try {
        await mkdir(this.cacheDir, { recursive: true });
        this.ensuredDir = true;
      } catch (err) {
        // Cache is best-effort; inability to create the dir just skips
        // persistence. Log once at warn level and continue.
        // eslint-disable-next-line no-console
        console.warn(
          `[CachingEmbedder] cannot mkdir ${this.cacheDir}: ${
            err instanceof Error ? err.message : String(err)
          }; proceeding without disk cache.`,
        );
        return;
      }
    }
    const payload: CacheFileShape = {
      embedderId: this.id,
      vector: Array.from(vec),
    };
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(payload), 'utf8');
      await rename(tmpPath, filePath);
    } catch (err) {
      // Race: another process may have written first; or the disk is full.
      // Either way, a subsequent embed of the same text will try again.
      try { await unlink(tmpPath); } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.warn(
        `[CachingEmbedder] cache write failed for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function tryReadCache(filePath: string, expectedId: string): Promise<Vector | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as CacheFileShape;
    // Defensive check: if the file was written by a different embedder
    // (shouldn't happen with namespacing but let's be safe), ignore.
    if (parsed.embedderId !== expectedId) return null;
    if (!Array.isArray(parsed.vector)) return null;
    return Object.freeze(parsed.vector) as Vector;
  } catch (err) {
    // ENOENT is expected for a cold cache. Log other errors once so we
    // can spot silent corruption without failing the read path.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn(
        `[CachingEmbedder] ignoring corrupt/unreadable cache at ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Best-effort: unlink the bad file so we don't keep hitting it.
      try { await unlink(filePath); } catch { /* ignore */ }
    }
    return null;
  }
}

// Re-export Dir constant for tests that want to spy on cache state.
export function cacheDirFor(rootDir: string, embedderId: string): string {
  return join(rootDir, 'embed-cache', embedderId);
}
// Placeholder to avoid "dirname imported but unused" when Node typings fluctuate.
void dirname;
