/**
 * bridge live-flow integration: createBridgeHost bootstrapped from the author's real
 * <external-palace>, then the full loop tick (decay + L2 + L3 + canon
 * applier) with a concurrent operator harness approving the L3 proposal.
 *
 * Intent: prove the end-to-end operator experience against real palace
 * data, not just the file adapter. Real drawers sit in the store as
 * low-confidence L1 observations, invisible to the L3 promotion pass;
 * three synthetic consensus L2 atoms drive the proposal.
 *
 * Gated by LAG_REAL_PALACE=1 (uses the Python bridge to ChromaDB). Does
 * NOT require LAG_REAL_CLI=1 since we don't arbitrate here.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgeHost, type BridgeHost } from '../../src/adapters/bridge/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import type { LoopTickReport } from '../../src/loop/types.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const RUN_REAL_PALACE = process.env['LAG_REAL_PALACE'] === '1';
const palacePath =
  process.env['LAG_REAL_PALACE_PATH'] ??
  process.env["LAG_PALACE_PATH"] ?? "<palace-path-placeholder>";

const principal = 'bridge-live-flow' as PrincipalId;
const describeMaybe = RUN_REAL_PALACE ? describe : describe.skip;

describeMaybe('bridge live-flow: real palace + loop + canon applier + operator', () => {
  let rootDir: string;
  let docsDir: string;
  let claudeMdPath: string;
  let host: BridgeHost;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-bridge-live-root-'));
    docsDir = await mkdtemp(join(tmpdir(), 'lag-bridge-live-docs-'));
    claudeMdPath = join(docsDir, 'CLAUDE.md');
    host = await createBridgeHost({
      palacePath,
      rootDir,
      defaultPrincipalId: principal,
    });
  });

  afterEach(async () => {
    try {
      await host.cleanup();
    } catch {
      /* ignore */
    }
    await rm(docsDir, { recursive: true, force: true });
  });

  it(
    'bootstrap real drawers + consensus atoms -> approved L3 -> canon on disk',
    async () => {
      // 1. Bootstrap ~10 real drawers as L1 observations.
      const bootstrap = await host.bootstrap({ limit: 10 });
      expect(bootstrap.imported).toBeGreaterThan(0);
      expect(bootstrap.errors.length).toBe(0);

      // 2. Seed 3 consensus L2 atoms (distinct principals, same content hash,
      //    fresh timestamps). Same normalization trick as live-flow.test.ts.
      const now = host.clock.now();
      const contents = [
        'Use Postgres as the canonical production database.',
        'use postgres as the canonical production database',
        'USE POSTGRES AS THE CANONICAL PRODUCTION DATABASE!',
      ];
      for (let i = 0; i < contents.length; i++) {
        await host.atoms.put(sampleAtom({
          id: (`phx_live_seed_${i}`) as AtomId,
          content: contents[i]!,
          type: 'decision',
          layer: 'L2',
          confidence: 0.95,
          principal_id: (`phx_live_agent_${i}`) as PrincipalId,
          created_at: now as Time,
          last_reinforced_at: now as Time,
        }));
      }

      // 3. Build the loop runner with canon applier wired in.
      const tickReports: LoopTickReport[] = [];
      const runner = new LoopRunner(host, {
        principalId: principal,
        l3HumanGateTimeoutMs: 10_000,
        canonTargetPath: claudeMdPath,
        onTick: report => {
          tickReports.push(report);
        },
      });

      // 4. Operator harness: poll + approve.
      const operator = 'bridge-live-operator' as PrincipalId;
      const operatorPromise = (async () => {
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 50));
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

      // 5. Drive one tick.
      const report = await runner.tick();
      const approved = await operatorPromise;

      expect(approved).toBe(true);
      expect(report.l3Proposed).toBe(1);
      expect(report.canonApplied).toBe(1);
      expect(report.errors).toEqual([]);
      expect(tickReports.length).toBe(1);

      // 6. Canon file on disk contains the approved decision, nothing from
      //    the bootstrapped drawers (they live at L1, invisible to canon).
      const text = await readFile(claudeMdPath, 'utf8');
      expect(text).toContain('lag:canon-start');
      expect(text).toContain('lag:canon-end');
      expect(text).toContain('## Decisions');
      expect(text.toLowerCase()).toContain('postgres');
    },
    60_000,
  );
});
