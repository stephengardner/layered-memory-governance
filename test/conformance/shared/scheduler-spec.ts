/**
 * Scheduler conformance spec.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '../../../src/substrate/interface.js';
import type { TargetFactory } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function runSchedulerSpec(label: string, factory: TargetFactory): void {
  describe(`Scheduler conformance (${label})`, () => {
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

    it('defer fires the handler after the delay', async () => {
      let fired = false;
      host.scheduler.defer('t', 30, () => { fired = true; });
      await sleep(80);
      expect(fired).toBe(true);
    });

    it('cancel prevents a deferred handler from firing', async () => {
      let fired = false;
      const reg = host.scheduler.defer('t', 30, () => { fired = true; });
      host.scheduler.cancel(reg);
      await sleep(80);
      expect(fired).toBe(false);
    });

    it('killswitchCheck reflects kill state', () => {
      expect(host.scheduler.killswitchCheck()).toBe(false);
      host.scheduler.kill();
      expect(host.scheduler.killswitchCheck()).toBe(true);
    });

    it('kill() prevents deferred handlers from firing', async () => {
      let fired = false;
      host.scheduler.defer('t', 30, () => { fired = true; });
      host.scheduler.kill();
      await sleep(80);
      expect(fired).toBe(false);
    });

    it('recurring stored and tickRecurring invokes it', async () => {
      let calls = 0;
      host.scheduler.recurring('r', '* * * * *', () => { calls++; });
      await host.scheduler.tickRecurring();
      await host.scheduler.tickRecurring();
      expect(calls).toBe(2);
    });
  });
}
