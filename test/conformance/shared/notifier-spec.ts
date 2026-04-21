/**
 * Notifier conformance spec.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../src/substrate/errors.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { NotificationHandle, PrincipalId, Time } from '../../../src/substrate/types.js';
import { sampleEvent } from '../../fixtures.js';
import type { TargetFactory } from './types.js';

const responder = 'user_1' as PrincipalId;

export function runNotifierSpec(label: string, factory: TargetFactory): void {
  describe(`Notifier conformance (${label})`, () => {
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

    it('telegraph returns a stable handle for same event', async () => {
      const ev = sampleEvent({ summary: 'test', created_at: '2026-01-01T00:00:00.000Z' as Time });
      const h1 = await host.notifier.telegraph(ev, null, 'ignore', 1000);
      const h2 = await host.notifier.telegraph(ev, null, 'ignore', 1000);
      expect(h1).toBe(h2);
    });

    it('telegraph returns different handles for different events', async () => {
      const a = sampleEvent({ summary: 'a' });
      const b = sampleEvent({ summary: 'b' });
      const ha = await host.notifier.telegraph(a, null, 'ignore', 1000);
      const hb = await host.notifier.telegraph(b, null, 'ignore', 1000);
      expect(ha).not.toBe(hb);
    });

    it('disposition returns pending before any response', async () => {
      const h = await host.notifier.telegraph(sampleEvent(), null, 'timeout', 60_000);
      expect(await host.notifier.disposition(h)).toBe('pending');
    });

    it('respond updates disposition to the given value', async () => {
      const h = await host.notifier.telegraph(sampleEvent(), null, 'timeout', 60_000);
      await host.notifier.respond(h, 'approve', responder);
      expect(await host.notifier.disposition(h)).toBe('approve');
    });

    it('respond with "pending" throws', async () => {
      const h = await host.notifier.telegraph(sampleEvent(), null, 'timeout', 60_000);
      await expect(host.notifier.respond(h, 'pending', responder)).rejects.toThrow();
    });

    it('disposition for missing handle throws NotFoundError', async () => {
      await expect(
        host.notifier.disposition('never' as NotificationHandle),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('awaitDisposition returns default on timeout', async () => {
      const h = await host.notifier.telegraph(sampleEvent(), null, 'reject', 50);
      const d = await host.notifier.awaitDisposition(h, 150);
      expect(d).toBe('reject');
    });

    it('awaitDisposition returns resolved value when responded', async () => {
      const h = await host.notifier.telegraph(sampleEvent(), null, 'timeout', 5000);
      setTimeout(() => {
        void host.notifier.respond(h, 'approve', responder);
      }, 30);
      const d = await host.notifier.awaitDisposition(h, 500);
      expect(d).toBe('approve');
    });
  });
}
