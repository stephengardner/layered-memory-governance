import { storage } from '@/services/storage.service';

/*
 * Pure storage helpers for the pinned-plans hook. Extracted from
 * `usePinnedPlans` so the persistence behaviour (key shape, sanitisation,
 * cross-tab key resolution) is testable in vitest without spinning up
 * a React render context. The hook composes these helpers with React
 * state + cross-tab StorageEvent subscription.
 *
 * Per apps/console/CLAUDE.md principle 10 every read + write routes
 * through `storage.service`; this file is the only seam in the
 * pinned-plans feature that touches storage.
 */

const STORAGE_KEY = 'pinned-plans';

/*
 * Resolved key the browser sees in localStorage (storage.service
 * prefixes every key with `lag-console.`). Cross-tab StorageEvent
 * subscribers compare event.key against this resolved value.
 */
export const RESOLVED_PINNED_PLANS_STORAGE_KEY = `lag-console.${STORAGE_KEY}`;

function sanitize(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string');
}

export function readPinnedPlans(): string[] {
  const raw = storage.get<unknown>(STORAGE_KEY);
  if (raw === null) return [];
  return sanitize(raw);
}

export function writePinnedPlans(ids: ReadonlyArray<string>): void {
  storage.set(STORAGE_KEY, [...ids]);
}
