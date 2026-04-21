/**
 * InboxPoller tests.
 *
 * Covers:
 *   - poll-only path: default memory host (no subscribe capability)
 *     drives onMessage for each queued message, drains greedily, and
 *     goes idle until a new write.
 *   - kill-switch: poller stops driving onMessage when the sentinel
 *     appears (via pickupOptions).
 *   - graceful abort: runInboxPoller exits when the provided signal
 *     is aborted.
 *   - subscribe-capable host: the poller uses subscribe() to wake on
 *     a new write without waiting for the correctness poll interval.
 *
 * We run the poller with very short correctness intervals to keep
 * wall time bounded; real deployments use the 30s canon default.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runInboxPoller } from '../../src/actor-message/poller.js';
import type {
  Atom,
  AtomFilter,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';
import type {
  ActorMessageV1,
  UrgencyTier,
} from '../../src/actor-message/types.js';
import type { AtomSubscribeEvent, Host } from '../../src/substrate/interface.js';

function messageAtom(id: string, to: string, from: string, urgency: UrgencyTier = 'normal'): Atom {
  const envelope: ActorMessageV1 = {
    to: to as PrincipalId,
    from: from as PrincipalId,
    topic: 't',
    urgency_tier: urgency,
    body: 'b',
  };
  const now = '2026-04-20T00:00:00.000Z' as Time;
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'b',
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: from, tool: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: from as PrincipalId,
    taint: 'clean',
    metadata: { actor_message: envelope },
  };
}

describe('runInboxPoller (poll-only path)', () => {
  it('drives onMessage for each queued message, then goes idle', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    await host.atoms.put(messageAtom('m2', 'alice', 'carol'));

    const received: string[] = [];
    const abort = new AbortController();

    const done = runInboxPoller(host, {
      principal: 'alice' as PrincipalId,
      signal: abort.signal,
      correctnessPollMs: 25, // tight for test
      deadlineImminentPollMs: 10,
      onMessage: async (outcome) => {
        received.push(String(outcome.message.atom.id));
        if (received.length >= 2) abort.abort();
      },
    });

    await done;

    expect(received.sort()).toEqual(['m1', 'm2']);
  });

  it('exits cleanly when signal is aborted with no messages present', async () => {
    const host = createMemoryHost();
    const abort = new AbortController();
    const done = runInboxPoller(host, {
      principal: 'alice' as PrincipalId,
      signal: abort.signal,
      correctnessPollMs: 20,
      deadlineImminentPollMs: 10,
      onMessage: async () => {
        throw new Error('should never be called');
      },
    });
    setTimeout(() => abort.abort(), 50);
    await expect(done).resolves.toBeUndefined();
  });

  it('honors the kill-switch sentinel', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));

    const tempDir = mkdtempSync(join(tmpdir(), 'lag-poller-stop-'));
    const stopPath = join(tempDir, 'STOP');
    writeFileSync(stopPath, '');

    const abort = new AbortController();
    const received: string[] = [];
    const done = runInboxPoller(host, {
      principal: 'alice' as PrincipalId,
      signal: abort.signal,
      correctnessPollMs: 20,
      deadlineImminentPollMs: 10,
      pickupOptions: { stopSentinelPath: stopPath },
      onMessage: async (outcome) => {
        received.push(String(outcome.message.atom.id));
      },
    });
    setTimeout(() => abort.abort(), 100);
    try {
      await done;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    // The kill-switch was active the whole time; no message should
    // have been processed even though m1 was sitting in the inbox.
    expect(received).toEqual([]);
  });
});

describe('runInboxPoller (subscribe-capable host)', () => {
  /**
   * Adapter-style wrapper that advertises subscribe capability and
   * emits an event for every put().
   */
  function subscribeCapableHost(): {
    host: Host;
    emitPut: (atom: Atom) => void;
    waitSubscribed: () => Promise<void>;
  } {
    const inner = createMemoryHost();
    const listeners = new Set<(ev: AtomSubscribeEvent) => void>();
    // Resolves the first time a subscriber registers its listener.
    // Lets the test wait for subscription before emitPut instead of
    // relying on a setTimeout(50ms) that's fragile under slow CI.
    let resolveSubscribed: (() => void) | null = null;
    const subscribedPromise = new Promise<void>((r) => { resolveSubscribed = r; });
    const markSubscribed = () => {
      if (resolveSubscribed !== null) {
        const r = resolveSubscribed;
        resolveSubscribed = null;
        r();
      }
    };
    const emitPut = (atom: Atom) => {
      for (const l of listeners) l({ kind: 'put', atomId: atom.id });
    };
    const waitSubscribed = () => subscribedPromise;
    // Bind methods explicitly because spread loses prototype methods.
    const innerAtoms = inner.atoms;
    const atomsProxy = new Proxy(innerAtoms, {
      get(target, prop: string | symbol, receiver) {
        if (prop === 'capabilities') return { hasSubscribe: true };
        if (prop === 'subscribe') return subscribeImpl;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const subscribeImpl = (_filter: AtomFilter, signal?: AbortSignal) => innerSubscribe(_filter, signal);
    const wrapped: Host = { ...inner, atoms: atomsProxy };
    function innerSubscribe(_filter: AtomFilter, signal?: AbortSignal) {
      return {
        [Symbol.asyncIterator]() {
          let resolveNext: ((ev: AtomSubscribeEvent) => void) | null = null;
          const pending: AtomSubscribeEvent[] = [];
          const listener = (ev: AtomSubscribeEvent) => {
            if (resolveNext !== null) {
              const r = resolveNext;
              resolveNext = null;
              r(ev);
            } else {
              pending.push(ev);
            }
          };
          listeners.add(listener);
          markSubscribed();
          signal?.addEventListener('abort', () => listeners.delete(listener), { once: true });
          return {
            next(): Promise<IteratorResult<AtomSubscribeEvent>> {
              if (signal?.aborted) {
                listeners.delete(listener);
                return Promise.resolve({ value: undefined, done: true });
              }
              const buffered = pending.shift();
              if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
              return new Promise<IteratorResult<AtomSubscribeEvent>>((res) => {
                resolveNext = (ev) => res({ value: ev, done: false });
                signal?.addEventListener('abort', () => {
                  listeners.delete(listener);
                  res({ value: undefined, done: true });
                }, { once: true });
              });
            },
          };
        },
      };
    }
    return { host: wrapped, emitPut, waitSubscribed };
  }

  it('uses subscribe() to wake before the correctness timer fires', async () => {
    const { host, emitPut, waitSubscribed } = subscribeCapableHost();
    const abort = new AbortController();
    const received: string[] = [];
    const SLOW_POLL_MS = 10_000; // would take forever without push

    const done = runInboxPoller(host, {
      principal: 'alice' as PrincipalId,
      signal: abort.signal,
      correctnessPollMs: SLOW_POLL_MS,
      deadlineImminentPollMs: SLOW_POLL_MS,
      onMessage: async (outcome) => {
        received.push(String(outcome.message.atom.id));
        abort.abort();
      },
    });

    // Wait deterministically until the poller has actually attached
    // its subscription listener before emitting. The 50ms setTimeout
    // I originally used here was fragile under slow CI - the test
    // could emit before the listener attached and silently fall
    // through to the poll path, which would time out after 10s.
    await waitSubscribed();
    const atom = messageAtom('m-pushed', 'alice', 'bob');
    await host.atoms.put(atom);
    emitPut(atom);

    await done;
    expect(received).toEqual(['m-pushed']);
  });
});
