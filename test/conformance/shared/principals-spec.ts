/**
 * PrincipalStore conformance spec.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../src/substrate/errors.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { PrincipalId, Time } from '../../../src/substrate/types.js';
import { samplePrincipal } from '../../fixtures.js';
import type { TargetFactory } from './types.js';

export function runPrincipalsSpec(label: string, factory: TargetFactory): void {
  describe(`PrincipalStore conformance (${label})`, () => {
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

    it('put and get round-trip', async () => {
      const p = samplePrincipal({ name: 'alice' });
      await host.principals.put(p);
      const got = await host.principals.get(p.id);
      expect(got?.name).toBe('alice');
    });

    it('get missing returns null', async () => {
      expect(await host.principals.get('ghost' as PrincipalId)).toBeNull();
    });

    it('permits("write", layer) requires layer in permitted write set', async () => {
      const p = samplePrincipal({
        permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L0', 'L1'] },
      });
      await host.principals.put(p);
      expect(await host.principals.permits(p.id, 'write', { layer: 'L1' })).toBe(true);
      expect(await host.principals.permits(p.id, 'write', { layer: 'L3' })).toBe(false);
    });

    it('compromised principal is denied everything', async () => {
      const p = samplePrincipal({ compromised_at: '2026-01-01T00:00:00.000Z' as Time });
      await host.principals.put(p);
      expect(await host.principals.permits(p.id, 'write', { layer: 'L1' })).toBe(false);
      expect(await host.principals.permits(p.id, 'read', { layer: 'L1' })).toBe(false);
    });

    it('inactive principal is denied', async () => {
      const p = samplePrincipal({ active: false });
      await host.principals.put(p);
      expect(await host.principals.permits(p.id, 'read', {})).toBe(false);
    });

    it('mark_compromised action requires admin role', async () => {
      const agent = samplePrincipal({ role: 'agent' });
      const admin = samplePrincipal({ role: 'admin' });
      await host.principals.put(agent);
      await host.principals.put(admin);
      expect(await host.principals.permits(agent.id, 'mark_compromised', {})).toBe(false);
      expect(await host.principals.permits(admin.id, 'mark_compromised', {})).toBe(true);
    });

    it('markCompromised sets compromised_at and deactivates', async () => {
      const p = samplePrincipal();
      await host.principals.put(p);
      await host.principals.markCompromised(p.id, '2026-06-01T00:00:00.000Z' as Time, 'oauth leak');
      const after = await host.principals.get(p.id);
      expect(after?.compromised_at).toBe('2026-06-01T00:00:00.000Z');
      expect(after?.active).toBe(false);
    });

    it('markCompromised on missing principal throws NotFoundError', async () => {
      await expect(
        host.principals.markCompromised('never' as PrincipalId, '2026-01-01T00:00:00.000Z' as Time, 'x'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('listActive excludes compromised and inactive', async () => {
      await host.principals.put(samplePrincipal({ id: 'good' as PrincipalId, active: true, compromised_at: null }));
      await host.principals.put(samplePrincipal({ id: 'inactive' as PrincipalId, active: false }));
      await host.principals.put(samplePrincipal({ id: 'comp' as PrincipalId, compromised_at: '2026-01-01T00:00:00.000Z' as Time }));
      const list = await host.principals.listActive();
      expect(list.map(p => p.id)).toEqual(['good']);
    });
  });
}
