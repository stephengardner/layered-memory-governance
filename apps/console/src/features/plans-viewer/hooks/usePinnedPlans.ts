import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'lag-pinned-plans';

function readFromStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeToStorage(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable; in-memory state remains correct for this tab */
  }
}

export interface UsePinnedPlans {
  pinnedIds: string[];
  isPinned: (id: string) => boolean;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  toggle: (id: string) => void;
}

export function usePinnedPlans(): UsePinnedPlans {
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readFromStorage());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setPinnedIds(readFromStorage());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const pin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      writeToStorage(next);
      return next;
    });
  }, []);

  const unpin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((x) => x !== id);
      writeToStorage(next);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      writeToStorage(next);
      return next;
    });
  }, []);

  const isPinned = useCallback(
    (id: string) => pinnedIds.includes(id),
    [pinnedIds],
  );

  return { pinnedIds, isPinned, pin, unpin, toggle };
}
