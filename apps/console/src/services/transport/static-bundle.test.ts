/**
 * Unit tests for StaticBundleTransport.
 *
 * Covers the demo-build contract: given a pre-baked bundle, calls
 * return the right shape; given no bundle, calls return sensible
 * empties matching the method-name suffix convention; params
 * (limit / offset) filter client-side; subscribe is a no-op.
 */

import { describe, it, expect, vi } from 'vitest';
import { StaticBundleTransport } from './static-bundle';

describe('StaticBundleTransport', () => {
  it('returns an empty array for unknown `.list` methods with no bundle', async () => {
    const t = new StaticBundleTransport();
    expect(await t.call('atoms.list')).toEqual([]);
    expect(await t.call('canon.search')).toEqual([]);
    expect(await t.call('plans.recent')).toEqual([]);
  });

  it('returns an empty object for unknown `.stats` / `.summary` methods', async () => {
    const t = new StaticBundleTransport();
    expect(await t.call('canon.stats')).toEqual({});
    expect(await t.call('plans.summary')).toEqual({});
  });

  it('returns null for unknown scalar-shaped methods', async () => {
    const t = new StaticBundleTransport();
    expect(await t.call('canon.get')).toBeNull();
  });

  it('returns bundle data for known methods', async () => {
    const t = new StaticBundleTransport({
      'canon.list': [{ id: 'a' }, { id: 'b' }],
      'canon.stats': { total: 2, l3: 2 },
    });
    expect(await t.call('canon.list')).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(await t.call('canon.stats')).toEqual({ total: 2, l3: 2 });
  });

  it('applies `limit` client-side to array responses', async () => {
    const bundle = { 'atoms.list': [1, 2, 3, 4, 5] };
    const t = new StaticBundleTransport(bundle);
    expect(await t.call('atoms.list', { limit: 2 })).toEqual([1, 2]);
    expect(await t.call('atoms.list', { limit: 10 })).toEqual([1, 2, 3, 4, 5]);
  });

  it('applies `offset` client-side to array responses', async () => {
    const bundle = { 'atoms.list': [1, 2, 3, 4, 5] };
    const t = new StaticBundleTransport(bundle);
    expect(await t.call('atoms.list', { offset: 2 })).toEqual([3, 4, 5]);
  });

  it('combines offset + limit', async () => {
    const bundle = { 'atoms.list': [1, 2, 3, 4, 5] };
    const t = new StaticBundleTransport(bundle);
    expect(await t.call('atoms.list', { offset: 1, limit: 2 })).toEqual([2, 3]);
  });

  it('ignores params for non-array responses', async () => {
    const bundle = { 'canon.stats': { total: 42 } };
    const t = new StaticBundleTransport(bundle);
    expect(await t.call('canon.stats', { limit: 1 })).toEqual({ total: 42 });
  });

  it('subscribe is a no-op that returns a valid unsubscribe', () => {
    const t = new StaticBundleTransport();
    const onEvent = vi.fn();
    const unsub = t.subscribe('events.atoms', onEvent);
    expect(typeof unsub).toBe('function');
    unsub();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('is selected when VITE_LAG_TRANSPORT=demo is set (integration sanity)', async () => {
    // Reset module registry so the transport index reruns selection
    // against a freshly-stubbed env var.
    vi.resetModules();
    vi.stubEnv('VITE_LAG_TRANSPORT', 'demo');
    try {
      const mod = await import('./index');
      // The concrete class is not directly exposed on the singleton
      // but the type brand + the no-op subscribe behavior confirms
      // we're on the static transport and not HttpTransport.
      const unsub = mod.transport.subscribe('x', () => { /* noop */ });
      unsub(); // no throw, no fetch, no EventSource
      // And unknown list methods return [] rather than throwing an
      // HTTP error, which only the static transport does.
      expect(await mod.transport.call('unknown.list')).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
