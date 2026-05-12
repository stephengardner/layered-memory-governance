import { useCallback, useEffect, useState } from 'react';
import {
  readPinnedPlans,
  writePinnedPlans,
  RESOLVED_PINNED_PLANS_STORAGE_KEY,
} from './pinnedPlansStorage';

/*
 * Storage seam: route every read + write through `storage.service`
 * per apps/console/CLAUDE.md principle 10 (no direct platform
 * storage in features). The pure helpers live in `pinnedPlansStorage`
 * so the persistence shape (key namespace, sanitisation) is
 * testable without a React render context; this hook composes them
 * with React state + the cross-tab `storage` event.
 *
 * The cross-tab `storage` event subscription remains because the
 * StorageEvent is a DOM event, not data fetching -- principle 4 is
 * not violated. `event.key` is the RESOLVED key the browser
 * dispatches (already prefixed), so we compare against the same
 * prefixed value the service writes.
 */

export interface UsePinnedPlans {
  pinnedIds: string[];
  isPinned: (id: string) => boolean;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  toggle: (id: string) => void;
}

export function usePinnedPlans(): UsePinnedPlans {
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedPlans());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== RESOLVED_PINNED_PLANS_STORAGE_KEY) return;
      setPinnedIds(readPinnedPlans());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const pin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      writePinnedPlans(next);
      return next;
    });
  }, []);

  const unpin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((x) => x !== id);
      writePinnedPlans(next);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      writePinnedPlans(next);
      return next;
    });
  }, []);

  const isPinned = useCallback(
    (id: string) => pinnedIds.includes(id),
    [pinnedIds],
  );

  return { pinnedIds, isPinned, pin, unpin, toggle };
}
