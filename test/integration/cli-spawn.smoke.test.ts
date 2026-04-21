/**
 * Spawn-based CLI smoke test: proves the shipped bins can actually run.
 *
 * Two subprocesses cooperate over a shared rootDir:
 *
 *   Terminal A  node dist/cli/run-loop.js --root-dir tmp --canon-md file
 *   Terminal B  node dist/cli/respond.js  --root-dir tmp   (stdin: "a\n")
 *
 * In-process tests (live-flow.test.ts) already prove the logic end-to-end;
 * this test's job is to prove the *packaging*: shebang, parseArgs plumbing,
 * dist/cli JS entrypoints, stdio piping, SIGKILL behaviour. Gated by
 * LAG_SPAWN_TEST=1 since it spawns real Node subprocesses (~3-5s) and
 * depends on `npm run build` having produced dist/cli/*.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const SPAWN_ENABLED = process.env['LAG_SPAWN_TEST'] === '1';
const describeMaybe = SPAWN_ENABLED ? describe : describe.skip;

const RUN_LOOP_PATH = resolve('dist/cli/run-loop.js');
const RESPOND_PATH = resolve('dist/cli/respond.js');

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise(resolvePromise => {
    child.once('exit', code => resolvePromise(code ?? -1));
  });
}

describeMaybe('CLI spawn smoke: lag-run-loop daemon + lag-respond approver', () => {
  let rootDir: string;
  let docsDir: string;
  let canonPath: string;
  let seedHost: FileHost;
  let daemon: ChildProcess | null = null;
  let responder: ChildProcess | null = null;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-spawn-root-'));
    docsDir = await mkdtemp(join(tmpdir(), 'lag-spawn-docs-'));
    canonPath = join(docsDir, 'CLAUDE.md');
    seedHost = await createFileHost({ rootDir });
  });

  afterEach(async () => {
    if (daemon && daemon.exitCode === null && !daemon.killed) {
      daemon.kill('SIGKILL');
      try {
        await waitForExit(daemon);
      } catch {
        /* ignore */
      }
    }
    daemon = null;
    if (responder && responder.exitCode === null && !responder.killed) {
      responder.kill('SIGKILL');
    }
    responder = null;
    try {
      await seedHost.cleanup();
    } catch {
      /* ignore */
    }
    await rm(rootDir, { recursive: true, force: true });
    await rm(docsDir, { recursive: true, force: true });
  });

  it('daemon tick, piped "a" response, and canon file on disk', async () => {
    // Seed 3 consensus L2 atoms against the shared rootDir. All three
    // normalize to the same content hash (leading "Use Kafka", lowercase +
    // trailing punctuation stripped), giving consensus count 3.
    const now = seedHost.clock.now();
    const contents = [
      'Use Kafka for the event bus.',
      'use kafka for the event bus',
      'USE KAFKA FOR THE EVENT BUS!',
    ];
    for (let i = 0; i < contents.length; i++) {
      await seedHost.atoms.put(sampleAtom({
        id: (`spawn_seed_${i}`) as AtomId,
        content: contents[i]!,
        type: 'decision',
        layer: 'L2',
        confidence: 0.95,
        principal_id: (`spawn_agent_${i}`) as PrincipalId,
        created_at: now as Time,
        last_reinforced_at: now as Time,
      }));
    }

    // Spawn daemon subprocess.
    const daemonOut: string[] = [];
    const daemonErr: string[] = [];
    daemon = spawn(
      process.execPath,
      [
        RUN_LOOP_PATH,
        '--root-dir', rootDir,
        '--canon-md', canonPath,
        '--interval', '500',
        '--gate-timeout', '20000',
        '--principal', 'spawn-daemon',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    daemon.stdout?.on('data', (chunk: Buffer) => daemonOut.push(chunk.toString()));
    daemon.stderr?.on('data', (chunk: Buffer) => daemonErr.push(chunk.toString()));

    // Wait for the daemon's first tick to telegraph the L3 proposal.
    const gotPending = await waitFor(async () => {
      const list = await seedHost.notifier.listPending();
      return list.length > 0;
    }, 15_000);
    expect(gotPending, `no pending notification appeared. stdout:\n${daemonOut.join('')}\nstderr:\n${daemonErr.join('')}`).toBe(true);

    // Spawn respond subprocess with "a\n" piped on stdin.
    const responderOut: string[] = [];
    const responderErr: string[] = [];
    responder = spawn(
      process.execPath,
      [
        RESPOND_PATH,
        '--root-dir', rootDir,
        '--responder', 'spawn-operator',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    responder.stdout?.on('data', (c: Buffer) => responderOut.push(c.toString()));
    responder.stderr?.on('data', (c: Buffer) => responderErr.push(c.toString()));
    // Important: write 'a\n' but do NOT end stdin. On non-TTY piped stdin,
    // Node's readline auto-closes when the stream ends, which races
    // question() and produces ERR_USE_AFTER_CLOSE. The responder exits
    // cleanly via process.exit after processing the single handle.
    responder.stdin?.write('a\n');

    const responderCode = await waitForExit(responder);
    expect(
      responderCode,
      `responder exited ${responderCode}. stdout:\n${responderOut.join('')}\nstderr:\n${responderErr.join('')}`,
    ).toBe(0);
    expect(responderOut.join('')).toContain('Responded: approve');

    // Daemon applies the promotion and writes canon to disk.
    const canonWritten = await waitFor(async () => {
      try {
        await stat(canonPath);
        return true;
      } catch {
        return false;
      }
    }, 15_000);
    expect(canonWritten, `canon file not written. daemon stdout:\n${daemonOut.join('')}`).toBe(true);

    const text = await readFile(canonPath, 'utf8');
    expect(text).toContain('lag:canon-start');
    expect(text).toContain('lag:canon-end');
    expect(text.toLowerCase()).toContain('kafka');

    // Daemon is still running; the loop doesn't exit on its own.
    expect(daemon.exitCode).toBeNull();

    // afterEach will SIGKILL and collect.
  }, 60_000);
});
