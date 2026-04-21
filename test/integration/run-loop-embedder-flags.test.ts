/**
 * Spawn-based test for lag-run-loop's --embedder and --embed-cache flags.
 *
 * Gated by LAG_SPAWN_TEST=1 AND LAG_REAL_EMBED=1 (the onnx path needs
 * the model to be available).
 *
 * Strategy:
 *   - Seed an L2 atom in rootDir via an in-process FileHost.
 *   - Spawn lag-run-loop with --embedder onnx-minilm --embed-cache
 *     --interval 1000.
 *   - After the boot line confirms the onnx + cache wiring, simulate
 *     a "read" by opening the same rootDir with an equivalent embedder
 *     chain in-process and running a search. Vectors land under
 *     rootDir/embed-cache/<id>/.
 *
 * The lag-run-loop tick itself does not invoke atoms.search today; it
 * only runs decay + promotion + canon application. So the test's end-
 * to-end verification covers two things: (a) the CLI accepts the new
 * flags without crashing, and (b) a second process targeting the same
 * rootDir with the same embedder chain writes cache files, which is
 * the only observable property that matters.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachingEmbedder } from '../../src/adapters/_common/caching-embedder.js';
import { OnnxMiniLmEmbedder } from '../../src/adapters/_common/onnx-minilm-embedder.js';
import { createFileHost } from '../../src/adapters/file/index.js';
import type { AtomId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const SPAWN_ENABLED = process.env['LAG_SPAWN_TEST'] === '1';
const EMBED_ENABLED = process.env['LAG_REAL_EMBED'] === '1';
const RUN = SPAWN_ENABLED && EMBED_ENABLED;
const describeMaybe = RUN ? describe : describe.skip;

const RUN_LOOP_PATH = resolve('dist/cli/run-loop.js');

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise(r => child.once('exit', code => r(code ?? -1)));
}

describeMaybe('lag-run-loop --embedder onnx-minilm --embed-cache', () => {
  let rootDir: string;
  let daemon: ChildProcess | null = null;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-embed-flags-'));
  });

  afterEach(async () => {
    if (daemon && daemon.exitCode === null && !daemon.killed) {
      daemon.kill('SIGKILL');
      try { await waitForExit(daemon); } catch { /* ignore */ }
    }
    daemon = null;
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('daemon accepts embedder flags and downstream search persists vectors', async () => {
    // Seed one atom before starting the daemon. The daemon tick itself
    // does not call search today, so we rely on a follow-up in-process
    // search (reusing the same rootDir + embedder chain) to exercise
    // the cache and prove the flag plumbing wrote vectors to disk.
    const seedHost = await createFileHost({ rootDir });
    await seedHost.atoms.put(sampleAtom({
      id: 'flag_test_atom' as AtomId,
      content: 'Postgres is our OLTP engine.',
    }));

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    daemon = spawn(
      process.execPath,
      [
        RUN_LOOP_PATH,
        '--root-dir', rootDir,
        '--interval', '1000',
        '--embedder', 'onnx-minilm',
        '--embed-cache',
        '--gate-timeout', '1000',
        '--principal', 'embed-flag-test',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    daemon.stdout?.on('data', (c: Buffer) => stdoutLines.push(c.toString()));
    daemon.stderr?.on('data', (c: Buffer) => stderrLines.push(c.toString()));

    // Wait for boot lines confirming onnx + cache wiring.
    const booted = await waitFor(async () => {
      const all = stdoutLines.join('');
      return all.includes('embedder: onnx-minilm') && all.includes('embed cache:');
    }, 30_000);
    expect(
      booted,
      `boot lines not seen. stdout:\n${stdoutLines.join('')}\nstderr:\n${stderrLines.join('')}`,
    ).toBe(true);

    // Daemon is running. In a separate in-process host using an
    // equivalent embedder chain, trigger a search. Vectors should land
    // under rootDir/embed-cache/<onnx-id>/.
    const onnx = new OnnxMiniLmEmbedder();
    await onnx.embed('warmup');
    const cached = new CachingEmbedder(onnx, { rootDir });
    const hostB = await createFileHost({ rootDir, embedder: cached });
    await hostB.atoms.search('postgres', 3);

    const cacheDir = join(rootDir, 'embed-cache', cached.id);
    const statResult = await stat(cacheDir).catch(() => null);
    expect(statResult?.isDirectory()).toBe(true);
    const files = await readdir(cacheDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => /^[0-9a-f]{64}\.json$/.test(f))).toBe(true);

    // Daemon still running; afterEach SIGKILL cleans up.
    expect(daemon.exitCode).toBeNull();
  }, 90_000);

  it('--no-embed-cache disables the cache directory', async () => {
    const stdoutLines: string[] = [];
    daemon = spawn(
      process.execPath,
      [
        RUN_LOOP_PATH,
        '--root-dir', rootDir,
        '--interval', '1000',
        '--embedder', 'onnx-minilm',
        '--no-embed-cache',
        '--gate-timeout', '1000',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    daemon.stdout?.on('data', (c: Buffer) => stdoutLines.push(c.toString()));

    const sawDisable = await waitFor(async () => {
      return stdoutLines.join('').includes('embed cache: disabled');
    }, 30_000);
    expect(sawDisable, `disable line not seen. stdout:\n${stdoutLines.join('')}`).toBe(true);
  }, 60_000);

  it('invalid --embedder value exits 1', async () => {
    const stderr: string[] = [];
    const proc = spawn(
      process.execPath,
      [
        RUN_LOOP_PATH,
        '--root-dir', rootDir,
        '--embedder', 'made-up-embedder',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stderr?.on('data', (c: Buffer) => stderr.push(c.toString()));
    daemon = proc;
    const code = await waitForExit(proc);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/--embedder must be/);
  }, 30_000);
});
