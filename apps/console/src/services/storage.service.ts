/**
 * Storage service: single-seam wrapper around platform persistence.
 * v1 uses localStorage; Tauri v2 swaps for `@tauri-apps/plugin-store`.
 * Components and features NEVER touch localStorage directly.
 *
 * Key prefix `lag-console.` namespaces all entries so multiple
 * LAG-family apps can share localStorage in a browser without
 * stepping on each other.
 */

const PREFIX = 'lag-console.';

export interface StorageService {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

class LocalStorageService implements StorageService {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Quota, privacy mode, etc. Silent-ignore is fine because the
      // UI treats storage as a convenience (theme restore, etc.),
      // not as load-bearing state.
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* noop */
    }
  }
}

// A trivial SSR/Node stub so services importing storage at module-
// eval time don't crash in non-browser contexts (Vitest unit tests).
class NoopStorageService implements StorageService {
  get<T>(_key: string): T | null {
    return null;
  }
  set<T>(_key: string, _value: T): void {
    /* noop */
  }
  remove(_key: string): void {
    /* noop */
  }
}

export const storage: StorageService = typeof localStorage === 'undefined'
  ? new NoopStorageService()
  : new LocalStorageService();
