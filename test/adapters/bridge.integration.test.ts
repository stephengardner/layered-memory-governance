/**
 * bridge adapter integration against an external ChromaDB-backed store.
 *
 * Gated by LAG_REAL_PALACE=1 to avoid running without opt-in. Requires:
 *   - Python 3 on PATH
 *   - `pip install chromadb` (already present if the bridge is installed)
 *   - The palace directory pointed to by LAG_REAL_PALACE_PATH (or the default
 *     <palace-path>) must exist and contain a
 *     "lmg_bridge_drawers" collection.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { BridgeAtomStore } from '../../src/adapters/bridge/atom-store.js';
import { dumpDrawers } from '../../src/adapters/bridge/drawer-bridge.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const RUN_REAL = process.env['LAG_REAL_PALACE'] === '1';
const palacePath =
  process.env['LAG_REAL_PALACE_PATH'] ??
  process.env["LAG_PALACE_PATH"] ?? "<palace-path-placeholder>";

describe.skipIf(!RUN_REAL)('BridgeAtomStore against real external palace', () => {
  it(
    'dumpDrawers returns drawers with id, document, metadata',
    async () => {
      const drawers = await dumpDrawers(palacePath, { limit: 5 });
      // eslint-disable-next-line no-console
      console.log(`[bridge integration] palace=${palacePath} drawers.length=${drawers.length}`);
      if (drawers.length > 0) {
        const first = drawers[0]!;
        // eslint-disable-next-line no-console
        console.log(`[bridge integration] first drawer id=${first.id} doc.len=${first.document.length}`);
      }
      expect(drawers.length).toBeGreaterThan(0);
      expect(drawers.length).toBeLessThanOrEqual(5);
      const d = drawers[0]!;
      expect(typeof d.id).toBe('string');
      expect(typeof d.document).toBe('string');
      expect(typeof d.metadata).toBe('object');
    },
    60_000,
  );

  it(
    'bootstrapFromChroma imports real drawers as L1 atoms',
    async () => {
      const host = createMemoryHost();
      const bridge = new BridgeAtomStore(host.atoms, {
        defaultPrincipalId: 'bridge-integration' as PrincipalId,
      });
      const result = await bridge.bootstrapFromChroma(palacePath, { limit: 20 });
      // eslint-disable-next-line no-console
      console.log(`[bridge integration] bootstrap result: ${JSON.stringify(result)}`);

      expect(result.fetched).toBeGreaterThan(0);
      expect(result.imported).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);

      // Atoms are retrievable via the standard AtomStore surface.
      const page = await bridge.query({ layer: ['L1'] }, 100);
      expect(page.atoms.length).toBeGreaterThan(0);
      for (const atom of page.atoms) {
        expect(atom.layer).toBe('L1');
        expect(atom.provenance.kind).toBe('agent-observed');
        expect(atom.taint).toBe('clean');
        expect(atom.id).toMatch(/^phx_/);
      }

      // Search works against imported atoms.
      const search = await bridge.search('backend', 5);
      // eslint-disable-next-line no-console
      console.log(`[bridge integration] sample search 'backend' -> ${search.length} hits`);
      if (search.length > 0) {
        expect(search[0]?.score).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it(
    'bootstrap is idempotent: re-running skips already-imported atoms',
    async () => {
      const host = createMemoryHost();
      const bridge = new BridgeAtomStore(host.atoms, {
        defaultPrincipalId: 'bridge-integration' as PrincipalId,
      });
      const first = await bridge.bootstrapFromChroma(palacePath, { limit: 10 });
      const second = await bridge.bootstrapFromChroma(palacePath, { limit: 10 });
      expect(first.imported).toBeGreaterThan(0);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(first.imported);
    },
    120_000,
  );
});
