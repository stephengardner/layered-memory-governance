import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Unit coverage for the pinned-plans storage seam. The hook composes
 * pure helpers from `./pinnedPlansStorage`; tests target those helpers
 * directly so the suite stays in vitest's default Node environment
 * (no jsdom / no React-Testing-Library dependency required).
 *
 * Hermetic strategy: mock the entire `@/services/storage.service`
 * module with an in-memory implementation that records every read
 * and write the helper makes. The previous globalThis.localStorage
 * stub approach was flaky under vitest's parallel-worker model
 * because storage.service.ts feature-detects `typeof localStorage`
 * at module-evaluation time, so module caching across workers raced
 * with vi.stubGlobal. vi.mock applies before any import in this
 * file resolves, so the helper never sees the real service.
 */

const RESOLVED_KEY = 'lag-console.pinned-plans';
const RAW_KEY = 'pinned-plans';

/*
 * Hoisted mock state: vi.mock factories run before module-level
 * variable initialisation (vitest hoists the mock above the import
 * chain), so the storage map must come from a vi.hoisted block to
 * exist by the time the factory executes.
 */
const { mockStorage, getCalls, setCalls } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    mockStorage: {
      get<T>(key: string): T | null {
        reads.push(key);
        return (store.has(key) ? (store.get(key) as T) : null);
      },
      set<T>(key: string, value: T): void {
        writes.push({ key, value });
        store.set(key, value);
      },
      remove(key: string): void {
        store.delete(key);
      },
      _clear(): void {
        store.clear();
        reads.length = 0;
        writes.length = 0;
      },
      _setSeed(key: string, value: unknown): void {
        store.set(key, value);
      },
    },
    getCalls: () => reads.slice(),
    setCalls: () => writes.slice(),
  };
});

vi.mock('@/services/storage.service', () => ({
  storage: mockStorage,
}));

beforeEach(() => {
  mockStorage._clear();
});

describe('pinnedPlansStorage', () => {
  it('readPinnedPlans returns [] when storage is empty', async () => {
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual([]);
    /*
     * The helper must read the un-prefixed key; storage.service is
     * responsible for resolving it to the lag-console-prefixed slot.
     */
    expect(getCalls()).toContain(RAW_KEY);
  });

  it('writePinnedPlans goes through storage.service (no direct localStorage access)', async () => {
    const mod = await import('./pinnedPlansStorage');
    mod.writePinnedPlans(['plan-a', 'plan-b']);
    const writes = setCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ key: RAW_KEY, value: ['plan-a', 'plan-b'] });
  });

  it('readPinnedPlans rehydrates from a pre-existing seeded value', async () => {
    mockStorage._setSeed(RAW_KEY, ['plan-a', 'plan-b']);
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual(['plan-a', 'plan-b']);
  });

  it('readPinnedPlans rejects non-array payloads', async () => {
    mockStorage._setSeed(RAW_KEY, { not: 'an array' });
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual([]);
  });

  it('readPinnedPlans filters non-string entries', async () => {
    mockStorage._setSeed(RAW_KEY, ['plan-a', 42, null, 'plan-b', { id: 'plan-c' }]);
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual(['plan-a', 'plan-b']);
  });

  it('RESOLVED_PINNED_PLANS_STORAGE_KEY exposes the prefixed key for cross-tab subscribers', async () => {
    const mod = await import('./pinnedPlansStorage');
    expect(mod.RESOLVED_PINNED_PLANS_STORAGE_KEY).toBe(RESOLVED_KEY);
  });
});
