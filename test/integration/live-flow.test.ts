/**
 * Live-flow integration: LoopRunner + canon applier + CanonMdManager
 * integrated into one tick, with a concurrent operator harness that polls
 * FileNotifier.listPending and responds approve. Simulates what
 * `lag-run-loop` + `lag-respond` running in two terminals would look like.
 *
 * Unlike autonomous-flow.test.ts, this test:
 *   - Wires canonTargetPath into the LoopRunner so canon application
 *     happens INSIDE the tick (not as an explicit follow-up call).
 *   - Asserts the onTick callback fires and the canon file on disk reflects
 *     the new L3 atom after the approval resolves.
 *
 * This is the closest in-process test to the actual operator experience.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import type { LoopTickReport } from '../../src/loop/types.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'live-flow' as PrincipalId;

let rootDir: string;
let docsDir: string;
let claudeMdPath: string;
let host: FileHost;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'lag-live-root-'));
  docsDir = await mkdtemp(join(tmpdir(), 'lag-live-docs-'));
  claudeMdPath = join(docsDir, 'CLAUDE.md');
  host = await createFileHost({ rootDir });
});

afterEach(async () => {
  try {
    await host.cleanup();
    await rm(docsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Live flow: loop with canon applier + concurrent operator', () => {
  it('loop tick promotes to L3 via approval and writes canon to file without a follow-up call', async () => {
    // Seed: 3 distinct principals agree at L2 on a decision, stamped fresh.
    const now = host.clock.now();
    // All three normalize to the same content hash: lowercase + strip
    // trailing punctuation. Casing and trailing !.? are irrelevant. Keep
    // the leading word consistent ("Use" in all) so the hash collapses.
    const contents = [
      'Use Postgres as the canonical production database.',
      'use postgres as the canonical production database',
      'USE POSTGRES AS THE CANONICAL PRODUCTION DATABASE!',
    ];
    for (let i = 0; i < contents.length; i++) {
      await host.atoms.put(sampleAtom({
        id: (`seed_${i}`) as AtomId,
        content: contents[i]!,
        type: 'decision',
        layer: 'L2',
        confidence: 0.95,
        principal_id: (`agent_${i}`) as PrincipalId,
        created_at: now as Time,
        last_reinforced_at: now as Time,
      }));
    }

    // Track tick reports via onTick callback.
    const tickReports: LoopTickReport[] = [];

    const runner = new LoopRunner(host, {
      principalId: principal,
      l3HumanGateTimeoutMs: 5_000,
      canonTargetPath: claudeMdPath,
      onTick: report => {
        tickReports.push(report);
      },
    });

    // Concurrent "operator" harness: polls pending notifications and approves.
    const operator = 'ops-on-call' as PrincipalId;
    const operatorPromise = (async () => {
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
        const pending = await host.notifier.listPending();
        for (const handle of pending) {
          try {
            const disp = await host.notifier.disposition(handle);
            if (disp === 'pending') {
              await host.notifier.respond(handle, 'approve', operator);
              return true;
            }
          } catch {
            /* handle moved; keep polling */
          }
        }
      }
      return false;
    })();

    // Drive one tick. The tick includes: decay, L2 promotion (no-op), L3
    // promotion (telegraphs + awaits), canon applier (renders L3 to disk).
    const report = await runner.tick();
    const approved = await operatorPromise;

    expect(approved).toBe(true);
    expect(report.l3Proposed).toBe(1);
    expect(report.canonApplied).toBe(1);
    expect(report.errors).toEqual([]);

    // onTick fired.
    expect(tickReports.length).toBe(1);
    expect(tickReports[0]?.tickNumber).toBe(1);

    // Canon file exists on disk.
    const text = await readFile(claudeMdPath, 'utf8');
    expect(text).toContain('lag:canon-start');
    expect(text).toContain('lag:canon-end');
    expect(text).toContain('## Decisions');
    expect(text.toLowerCase()).toContain('postgres');

    // A fresh session-like read of the file finds the canon.
    const fresh = await readFile(claudeMdPath, 'utf8');
    expect(fresh).toBe(text);
  }, 15_000);

  it('a tick with no L3 changes still writes the empty-state canon on first run', async () => {
    const runner = new LoopRunner(host, {
      principalId: principal,
      canonTargetPath: claudeMdPath,
    });
    const report = await runner.tick();
    expect(report.l3Proposed).toBe(0);
    expect(report.canonApplied).toBe(1); // first-ever write with empty canon content
    const text = await readFile(claudeMdPath, 'utf8');
    expect(text).toContain('No canon atoms yet');
  });

  it('subsequent tick with unchanged L3 set does not re-write the file', async () => {
    const runner = new LoopRunner(host, {
      principalId: principal,
      canonTargetPath: claudeMdPath,
    });
    await runner.tick();
    const report2 = await runner.tick();
    // Second tick: nothing changed, so canonApplied should be 0.
    expect(report2.canonApplied).toBe(0);
  });
});
