/**
 * Auditor conformance spec.
 *
 * Note: the `allMetrics`/`size` accessors on MemoryAuditor are adapter-
 * specific and not part of the Host interface. Tests that rely on those
 * helpers stay in their adapter-specific test file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '../../../src/substrate/interface.js';
import type { AtomId, AuditEvent, PrincipalId, Time } from '../../../src/substrate/types.js';
import type { TargetFactory } from './types.js';

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    kind: 'atom.put',
    principal_id: 'user_1' as PrincipalId,
    timestamp: '2026-01-01T00:00:00.000Z' as Time,
    refs: {},
    details: {},
    ...overrides,
  };
}

export function runAuditorSpec(label: string, factory: TargetFactory): void {
  describe(`Auditor conformance (${label})`, () => {
    let host: Host;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const r = await factory();
      host = r.host;
      cleanup = r.cleanup;
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
    });

    it('log and query round-trip', async () => {
      await host.auditor.log(event({ kind: 'a.b' }));
      const out = await host.auditor.query({}, 10);
      expect(out.length).toBe(1);
      expect(out[0]?.kind).toBe('a.b');
    });

    it('log returns distinct ids for identical events at different ticks', async () => {
      const id1 = await host.auditor.log(event());
      const id2 = await host.auditor.log(event());
      expect(id1).not.toBe(id2);
    });

    it('query filters by kind', async () => {
      await host.auditor.log(event({ kind: 'a' }));
      await host.auditor.log(event({ kind: 'b' }));
      await host.auditor.log(event({ kind: 'a' }));
      const out = await host.auditor.query({ kind: ['a'] }, 10);
      expect(out.length).toBe(2);
      expect(out.every(e => e.kind === 'a')).toBe(true);
    });

    it('query filters by principal_id', async () => {
      await host.auditor.log(event({ principal_id: 'p1' as PrincipalId }));
      await host.auditor.log(event({ principal_id: 'p2' as PrincipalId }));
      const out = await host.auditor.query({ principal_id: ['p1' as PrincipalId] }, 10);
      expect(out.length).toBe(1);
    });

    it('query filters by atom_ids in refs', async () => {
      await host.auditor.log(event({ refs: { atom_ids: ['a1' as AtomId] } }));
      await host.auditor.log(event({ refs: { atom_ids: ['a2' as AtomId] } }));
      const out = await host.auditor.query({ atom_ids: ['a1' as AtomId] }, 10);
      expect(out.length).toBe(1);
      expect(out[0]?.refs.atom_ids).toEqual(['a1']);
    });

    it('metric emission does not throw', () => {
      host.auditor.metric('atoms.written', 5, { layer: 'L1' });
      host.auditor.metric('atoms.written', 7, { layer: 'L2' });
      // Adapter-specific size/retrieval lives outside the shared spec.
    });
  });
}
