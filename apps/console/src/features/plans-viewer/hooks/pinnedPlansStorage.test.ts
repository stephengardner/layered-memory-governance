import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Unit coverage for the pinned-plans storage seam. The hook composes
 * pure helpers from `./pinnedPlansStorage`; tests target those helpers
 * directly so the suite stays in vitest's default Node environment
 * (no jsdom / no React-Testing-Library dependency required).
 *
 * The helpers call `storage.service.get`/`set`. We stub the localStorage
 * the service feature-detects and assert the resolved key carries the
 * `lag-console.` prefix -- a regression to direct `window.localStorage`
 * with the legacy `lag-pinned-plans` key would fail the resolved-key
 * assertions.
 */

const RESOLVED_KEY = 'lag-console.pinned-plans';

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

let memoryStorage: MemoryStorage;

beforeEach(() => {
  /*
   * Stub the global the storage.service module-loaded above expects.
   * We use vi.stubGlobal so it survives the cached module reference
   * inside storage.service. The service's module-level singleton was
   * picked at import time -- but that import happened before the
   * stub, against a real (undefined-or-jsdom) localStorage. To make
   * the per-test stub take effect we re-import the helpers fresh
   * inside each test below via dynamic import. This avoids the
   * "module evaluated once with the wrong global" trap.
   */
  memoryStorage = new MemoryStorage();
  vi.stubGlobal('localStorage', memoryStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('pinnedPlansStorage', () => {
  it('readPinnedPlans returns [] when storage is empty', async () => {
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual([]);
  });

  it('writePinnedPlans persists under the lag-console-prefixed key', async () => {
    const mod = await import('./pinnedPlansStorage');
    mod.writePinnedPlans(['plan-a', 'plan-b']);
    const raw = memoryStorage.getItem(RESOLVED_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(['plan-a', 'plan-b']);
    /*
     * The legacy un-prefixed key from the pre-migration shape must
     * NEVER be touched. A read at the old slot would indicate the
     * hook regressed back to direct localStorage access.
     */
    expect(memoryStorage.getItem('lag-pinned-plans')).toBeNull();
  });

  it('readPinnedPlans rehydrates from a pre-existing prefixed key', async () => {
    memoryStorage.setItem(RESOLVED_KEY, JSON.stringify(['plan-a', 'plan-b']));
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual(['plan-a', 'plan-b']);
  });

  it('readPinnedPlans rejects non-array payloads', async () => {
    memoryStorage.setItem(RESOLVED_KEY, JSON.stringify({ not: 'an array' }));
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual([]);
  });

  it('readPinnedPlans filters non-string entries', async () => {
    memoryStorage.setItem(
      RESOLVED_KEY,
      JSON.stringify(['plan-a', 42, null, 'plan-b', { id: 'plan-c' }]),
    );
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual(['plan-a', 'plan-b']);
  });

  it('readPinnedPlans returns [] on malformed JSON (storage.service swallows the parse error)', async () => {
    memoryStorage.setItem(RESOLVED_KEY, '{not json');
    const mod = await import('./pinnedPlansStorage');
    expect(mod.readPinnedPlans()).toEqual([]);
  });

  it('RESOLVED_PINNED_PLANS_STORAGE_KEY exposes the prefixed key for cross-tab subscribers', async () => {
    const mod = await import('./pinnedPlansStorage');
    expect(mod.RESOLVED_PINNED_PLANS_STORAGE_KEY).toBe(RESOLVED_KEY);
  });
});
