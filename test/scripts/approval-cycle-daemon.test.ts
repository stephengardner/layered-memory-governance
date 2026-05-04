/**
 * Unit tests for scripts/lib/approval-cycle-daemon.mjs.
 *
 * The daemon helper drives a runOnce() callback at a canon-tunable
 * cadence so the substrate gap #8 fix (pr-observation refresh) is
 * self-sustaining without manual operator invocation.
 *
 * The pure helper extracts:
 *   - the loop scaffolding (run pass, sleep, run pass, ...) so a test
 *     can drive iterations deterministically without spawning Node;
 *   - the abort-signal contract that lets a SIGTERM / SIGINT cut the
 *     sleep cleanly rather than waiting up to a full interval;
 *   - the per-iteration error containment so a single thrown pass
 *     never tears the whole daemon down (just like the per-tick
 *     try-catch in the existing --once flow).
 */

import { describe, expect, it } from 'vitest';
import { runDaemonLoop } from '../../scripts/lib/approval-cycle-daemon.mjs';

interface FakeClock {
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly advance: (ms: number) => Promise<void>;
  pendingMs(): number | null;
}

/**
 * Deterministic clock: sleep returns a Promise that resolves only when
 * the test calls advance(). One pending sleeper at a time matches the
 * single-threaded loop shape; if a second sleep is requested before
 * the first resolves the test will throw, which is what we want.
 */
function makeFakeClock(): FakeClock {
  let pending: { ms: number; resolve: () => void; signal?: AbortSignal } | null = null;
  return {
    async sleep(ms, signal) {
      if (pending !== null) {
        throw new Error('FakeClock: a sleep is already pending; the loop overlapped');
      }
      if (signal?.aborted) {
        return;
      }
      return new Promise<void>((resolve) => {
        const onAbort = (): void => {
          pending = null;
          resolve();
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        pending = { ms, resolve, signal };
      });
    },
    async advance(ms) {
      if (pending === null) {
        // No sleeper yet: yield once so the loop can schedule.
        await Promise.resolve();
        if (pending === null) return;
      }
      const p = pending;
      if (p.ms <= ms) {
        pending = null;
        p.resolve();
        // Yield so the loop's next runOnce can begin.
        await new Promise<void>((r) => setImmediate(r));
      }
    },
    pendingMs() {
      return pending?.ms ?? null;
    },
  };
}

describe('runDaemonLoop', () => {
  it('runs runOnce on each tick, sleeping intervalMs between passes', async () => {
    const clock = makeFakeClock();
    const calls: number[] = [];
    const ac = new AbortController();

    const loop = runDaemonLoop({
      runOnce: async () => {
        calls.push(Date.now());
      },
      readIntervalMs: async () => 60_000,
      sleep: clock.sleep,
      signal: ac.signal,
      maxIterations: 3,
    });

    // Yield to let the first runOnce run and reach the first sleep.
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pendingMs()).toBe(60_000);
    expect(calls.length).toBe(1);

    await clock.advance(60_000);
    await Promise.resolve();
    expect(calls.length).toBe(2);

    await clock.advance(60_000);
    await Promise.resolve();
    expect(calls.length).toBe(3);

    await loop;
  });

  it('reads intervalMs fresh on every iteration so a canon edit takes effect next pass', async () => {
    // The substrate-tunable interval must reflect canon edits without
    // restarting the daemon. The test pins this by changing the value
    // returned by readIntervalMs between passes. N runOnce passes
    // produce N-1 sleeps (sleep is between passes, not after the
    // final pass when maxIterations is reached).
    const intervals = [60_000, 30_000, 10_000];
    let idx = 0;
    const observed: number[] = [];
    const ac = new AbortController();

    const loop = runDaemonLoop({
      runOnce: async () => { /* no-op */ },
      readIntervalMs: async () => intervals[idx++ % intervals.length],
      sleep: async (ms) => { observed.push(ms); },
      signal: ac.signal,
      maxIterations: 4,
    });
    await loop;
    expect(observed).toEqual([60_000, 30_000, 10_000]);
  });

  it('contains a thrown runOnce so the loop continues', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const ac = new AbortController();

    let i = 0;
    const loop = runDaemonLoop({
      runOnce: async () => {
        i += 1;
        calls.push(`pass-${i}`);
        if (i === 1) throw new Error('boom');
      },
      readIntervalMs: async () => 1_000,
      sleep: async () => { /* immediate */ },
      onError: (err) => { errors.push(err); },
      signal: ac.signal,
      maxIterations: 3,
    });
    await loop;
    expect(calls).toEqual(['pass-1', 'pass-2', 'pass-3']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('aborts cleanly mid-sleep when the AbortSignal fires', async () => {
    // SIGTERM / SIGINT path: the daemon must not block on the full
    // interval after a stop signal arrives.
    const clock = makeFakeClock();
    const ac = new AbortController();
    const calls: number[] = [];

    const loop = runDaemonLoop({
      runOnce: async () => { calls.push(1); },
      readIntervalMs: async () => 60_000,
      sleep: clock.sleep,
      signal: ac.signal,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pendingMs()).toBe(60_000);

    ac.abort();
    await loop;
    expect(calls.length).toBe(1);
  });

  it('returns early when the signal is already aborted before the first pass', async () => {
    const ac = new AbortController();
    ac.abort();
    const calls: number[] = [];
    const loop = runDaemonLoop({
      runOnce: async () => { calls.push(1); },
      readIntervalMs: async () => 60_000,
      sleep: async () => { throw new Error('should not sleep'); },
      signal: ac.signal,
    });
    await loop;
    expect(calls).toHaveLength(0);
  });

  it('clamps a malformed intervalMs (NaN or non-positive) to the supplied minimumMs', async () => {
    // Defense-in-depth: even though readApprovalCycleTickIntervalMs
    // already falls back to the default when canon is malformed, the
    // daemon helper enforces a minimum so a custom reader cannot wedge
    // the loop into a busy-spin (intervalMs=0) or NaN-sleep. Two
    // iterations -> one sleep observed, clamped up from NaN.
    const observed: number[] = [];
    const ac = new AbortController();

    const loop = runDaemonLoop({
      runOnce: async () => { /* no-op */ },
      readIntervalMs: async () => Number.NaN,
      sleep: async (ms) => { observed.push(ms); },
      minimumMs: 1_000,
      signal: ac.signal,
      maxIterations: 2,
    });
    await loop;
    expect(observed).toEqual([1_000]);
  });
});
