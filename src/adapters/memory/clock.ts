import type { Clock } from '../../substrate/interface.js';
import type { Time } from '../../substrate/types.js';

/**
 * Injectable clock for tests and simulation.
 *
 * Default start: 2026-01-01T00:00:00.000Z. Deterministic. Must be advanced
 * explicitly via `advance(ms)` or `setTime(iso)` for now() to change.
 *
 * monotonic() returns a strictly-increasing bigint counter that increments
 * once per call. NOT actual nanoseconds; callers that rely on nanosecond
 * semantics (duration math) must use a real clock. For ordering semantics,
 * this is correct and deterministic.
 */
export class MemoryClock implements Clock {
  private currentMs: number;
  private monotonicCounter: bigint = 0n;

  constructor(startIso: string = '2026-01-01T00:00:00.000Z') {
    const ms = Date.parse(startIso);
    if (Number.isNaN(ms)) {
      throw new Error(`MemoryClock: invalid start time "${startIso}"`);
    }
    this.currentMs = ms;
  }

  now(): Time {
    return new Date(this.currentMs).toISOString();
  }

  monotonic(): bigint {
    this.monotonicCounter += 1n;
    return this.monotonicCounter;
  }

  // ---- Test/simulation helpers (NOT on Clock interface) ----

  /** Advance clock by the given number of milliseconds. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error(`MemoryClock.advance: cannot go backward (ms=${ms})`);
    }
    this.currentMs += ms;
  }

  /** Set the current time to a specific ISO-8601 UTC string. */
  setTime(iso: string): void {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      throw new Error(`MemoryClock.setTime: invalid ISO "${iso}"`);
    }
    if (ms < this.currentMs) {
      throw new Error(`MemoryClock.setTime: cannot go backward from ${this.now()} to ${iso}`);
    }
    this.currentMs = ms;
  }
}
