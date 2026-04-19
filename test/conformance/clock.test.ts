import { describe, expect, it } from 'vitest';
import { MemoryClock } from '../../src/adapters/memory/clock.js';

describe('Clock conformance (memory)', () => {
  it('now returns the configured start time', () => {
    const clock = new MemoryClock('2026-05-01T00:00:00.000Z');
    expect(clock.now()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('now is unchanged without advance', () => {
    const clock = new MemoryClock();
    const t1 = clock.now();
    const t2 = clock.now();
    expect(t1).toBe(t2);
  });

  it('advance moves now forward', () => {
    const clock = new MemoryClock('2026-01-01T00:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('advance with negative ms throws', () => {
    const clock = new MemoryClock();
    expect(() => clock.advance(-1)).toThrow();
  });

  it('setTime forbids going backward', () => {
    const clock = new MemoryClock('2026-06-01T00:00:00.000Z');
    expect(() => clock.setTime('2026-01-01T00:00:00.000Z')).toThrow();
  });

  it('monotonic is strictly increasing', () => {
    const clock = new MemoryClock();
    const a = clock.monotonic();
    const b = clock.monotonic();
    const c = clock.monotonic();
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
  });

  it('monotonic increments across advance calls', () => {
    const clock = new MemoryClock();
    const a = clock.monotonic();
    clock.advance(1000);
    const b = clock.monotonic();
    expect(b > a).toBe(true);
  });
});
