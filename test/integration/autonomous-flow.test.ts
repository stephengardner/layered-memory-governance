/**
 * The autonomous-flow north-star test.
 *
 * Demonstrates end-to-end:
 *   1. Three distinct agents write consensus atoms at L2 (simulating multiple
 *      curated observations of the same fact).
 *   2. LoopRunner.tick() fires the L3 promotion pass. The Promotion engine
 *      telegraphs a human-approval event via the Notifier.
 *   3. A concurrent "human" responds 'approve'; the gate resolves; the L3
 *      atom is created.
 *   4. CanonMdManager.applyCanon() renders the new L3 atoms as markdown into
 *      the bracketed section of a target CLAUDE.md file.
 *   5. A new process (fresh FileHost + fresh CanonMdManager) reads the file
 *      and retrieves the canon content back.
 *
 * This is the "step function" goal from the design discussion made literal:
 * atoms -> arbitration (implicit in promotion policy) -> telegraph -> human
 * approval -> persistent edit to a real CLAUDE.md.
 *
 * No real LLM, no real palace: this is the in-process demonstration of the
 * flow's correctness. Phase 11 will wire the same path through real Claude
 * CLI and an external ChromaDB-backed store.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import { CanonMdManager } from '../../src/canon-md/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import type { AtomId, NotificationHandle, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'autonomous-test' as PrincipalId;

let rootDir: string;
let docsDir: string;
let claudeMdPath: string;
let host: FileHost;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'lag-auto-root-'));
  docsDir = await mkdtemp(join(tmpdir(), 'lag-auto-docs-'));
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

describe('Autonomous flow: atoms -> loop -> human-approved promotion -> CLAUDE.md', () => {
  it('the full pipeline writes an approved fact into the bracketed canon section', async () => {
    // 1. Seed: three agents write the same high-confidence L2 atom.
    //    Stamp with the host's current wall time so the tick's decay pass
    //    does not knock confidence below the L3 threshold (0.9).
    const now = host.clock.now();
    const contents = [
      'Use Postgres as the canonical production database.',
      'use postgres as the canonical production database',
      'USE POSTGRES AS THE CANONICAL PRODUCTION DATABASE!',
    ];
    const ids: AtomId[] = [];
    for (let i = 0; i < contents.length; i++) {
      const id = (`seed_${i}`) as AtomId;
      ids.push(id);
      await host.atoms.put(sampleAtom({
        id,
        content: contents[i]!,
        type: 'decision',
        layer: 'L2',
        confidence: 0.95,
        principal_id: (`agent_${i}`) as PrincipalId,
        created_at: now as Time,
        last_reinforced_at: now as Time,
      }));
    }

    // 2. LoopRunner configured with a longer human-gate timeout so we can
    //    respond concurrently.
    const runner = new LoopRunner(host, {
      principalId: principal,
      l3HumanGateTimeoutMs: 2_000,
    });

    // 3. Concurrent human-approval harness: poll FileNotifier.listPending()
    //    and approve any pending handle. This avoids relying on clock-now
    //    for handle reconstruction (which fails because the engine stamps
    //    created_at at its own clock.now(), not ours).
    const responderPrincipal = 'ops-on-call' as PrincipalId;
    const approvalPromise = (async () => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
        const pending = await host.notifier.listPending();
        for (const handle of pending) {
          try {
            const disp = await host.notifier.disposition(handle);
            if (disp === 'pending') {
              await host.notifier.respond(handle, 'approve', responderPrincipal);
              return true;
            }
          } catch {
            // handle vanished; keep polling
          }
        }
      }
      return false;
    })();

    // 4. Run one tick. During the tick the engine telegraphs and awaits.
    const tickReport = await runner.tick();
    const approved = await approvalPromise;

    expect(approved).toBe(true);
    expect(tickReport.l3Proposed).toBeGreaterThanOrEqual(1);

    // 5. L3 atom should now exist.
    const l3 = (await host.atoms.query({ layer: ['L3'] }, 10)).atoms;
    expect(l3.length).toBeGreaterThanOrEqual(1);
    expect(l3[0]?.content.toLowerCase()).toContain('postgres');

    // 6. Render L3 atoms into the target CLAUDE.md.
    const mgr = new CanonMdManager({ filePath: claudeMdPath });
    const writeResult = await mgr.applyCanon(l3, { now: '2026-04-18T00:00:00.000Z' });
    expect(writeResult.changed).toBe(true);

    // 7. Read the file from disk (simulating a fresh session reading canon).
    const fileText = await readFile(claudeMdPath, 'utf8');
    expect(fileText).toContain('lag:canon-start');
    expect(fileText).toContain('lag:canon-end');
    expect(fileText).toContain('## Decisions');
    expect(fileText.toLowerCase()).toContain('postgres');

    // 8. Cross-session retrieval: a fresh CanonMdManager on the same path
    //    reads the canon back without any state transfer.
    const freshMgr = new CanonMdManager({ filePath: claudeMdPath });
    const readBack = await freshMgr.readSection();
    expect(readBack).toContain('Decisions');
    expect(readBack.toLowerCase()).toContain('postgres');
  }, 30_000);

  it('does not write when there are no L3 atoms (graceful empty state)', async () => {
    const mgr = new CanonMdManager({ filePath: claudeMdPath });
    const result = await mgr.applyCanon([], { now: '2026-04-18T00:00:00.000Z' });
    // An empty canon still writes the placeholder section, so changed=true.
    expect(result.changed).toBe(true);
    const text = await readFile(claudeMdPath, 'utf8');
    expect(text).toContain('No canon atoms yet');
  });

  it('preserves human-edited content in the file when canon updates', async () => {
    const mgr = new CanonMdManager({ filePath: claudeMdPath });
    // Pre-seed with a human-written header.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      claudeMdPath,
      '# My Project\n\nMy hand-written intro that the machine must not touch.\n\n',
      'utf8',
    );
    await mgr.applyCanon(
      [sampleAtom({ content: 'decide X', type: 'decision', layer: 'L3' })],
      { now: '2026-04-18T00:00:00.000Z' },
    );
    const text = await readFile(claudeMdPath, 'utf8');
    expect(text).toContain('# My Project');
    expect(text).toContain('hand-written intro');
    expect(text).toContain('decide X');

    // A second apply that changes canon MUST NOT alter the human intro.
    await mgr.applyCanon(
      [sampleAtom({ content: 'decide Y', type: 'decision', layer: 'L3' })],
      { now: '2026-04-18T00:00:00.000Z' },
    );
    const text2 = await readFile(claudeMdPath, 'utf8');
    expect(text2).toContain('# My Project');
    expect(text2).toContain('hand-written intro');
    expect(text2).toContain('decide Y');
    expect(text2).not.toContain('decide X');
  });
});
