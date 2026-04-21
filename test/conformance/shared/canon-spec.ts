/**
 * CanonStore conformance spec.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../src/substrate/errors.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { CommitRef, Diff, PrincipalId, ProposalId } from '../../../src/substrate/types.js';
import type { TargetFactory } from './types.js';

const admin = 'admin_1' as PrincipalId;

function diff(path: string, before: string, after: string, reason = 'test'): Diff {
  return { path, before, after, reason };
}

export function runCanonSpec(label: string, factory: TargetFactory): void {
  describe(`CanonStore conformance (${label})`, () => {
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

    it('read of empty canon returns ""', async () => {
      expect(await host.canon.read()).toBe('');
      expect(await host.canon.read('any-section')).toBe('');
    });

    it('propose + commit updates the section', async () => {
      const pid = await host.canon.propose(diff('principles', '', 'use postgres'), admin, 'seed');
      await host.canon.commit(pid, admin);
      expect(await host.canon.read('principles')).toBe('use postgres');
    });

    it('propose is idempotent on identical inputs', async () => {
      const d = diff('principles', '', 'x');
      const a = await host.canon.propose(d, admin, 'r');
      const b = await host.canon.propose(d, admin, 'r');
      expect(a).toBe(b);
    });

    it('commit missing proposal throws NotFoundError', async () => {
      await expect(
        host.canon.commit('nonexistent' as ProposalId, admin),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('revert restores prior content', async () => {
      const pid = await host.canon.propose(diff('principles', '', 'use postgres'), admin, 'seed');
      const ref = await host.canon.commit(pid, admin);
      expect(await host.canon.read('principles')).toBe('use postgres');
      await host.canon.revert(ref, 'user asked', admin);
      expect(await host.canon.read('principles')).toBe('');
    });

    it('revert missing ref throws NotFoundError', async () => {
      await expect(
        host.canon.revert('nonexistent' as CommitRef, 'oops', admin),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('history returns newest-first', async () => {
      const p1 = await host.canon.propose(diff('a', '', '1'), admin, 'first');
      await host.canon.commit(p1, admin);
      // Small real-time delay so wall-clocked adapters (FileClock) produce a
      // strictly-later second commit timestamp. Insertion-ordered adapters
      // (MemoryClock) are also fine; the ordering assertion holds either way.
      await new Promise(r => setTimeout(r, 5));
      const p2 = await host.canon.propose(diff('a', '1', '2'), admin, 'second');
      await host.canon.commit(p2, admin);

      const h = await host.canon.history();
      expect(h.length).toBe(2);
      expect(h[0]?.reason).toBe('second');
      expect(h[1]?.reason).toBe('first');
    });

    it('history with pathFilter restricts to that path', async () => {
      const pA = await host.canon.propose(diff('A', '', 'x'), admin, 'ra');
      await host.canon.commit(pA, admin);
      const pB = await host.canon.propose(diff('B', '', 'y'), admin, 'rb');
      await host.canon.commit(pB, admin);
      const h = await host.canon.history('A');
      expect(h.length).toBe(1);
      expect(h[0]?.diff.path).toBe('A');
    });
  });
}
