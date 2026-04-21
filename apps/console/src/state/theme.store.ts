/**
 * Theme store: Zustand-backed, persists via storage service.
 *
 * Separates the STATE (current theme name) from the EFFECT (applying
 * the body class). State lives in Zustand; a small subscription in
 * `app/App.tsx` mirrors state onto the DOM. Components that need
 * theme only subscribe to state; they do not mutate the body class
 * themselves.
 */

import { create } from 'zustand';
import { storage } from '@/services/storage.service';

export type ThemeName = 'dark' | 'light';
const STORAGE_KEY = 'theme';

interface ThemeState {
  theme: ThemeName;
  setTheme: (next: ThemeName) => void;
  toggle: () => void;
}

function readInitialTheme(): ThemeName {
  const stored = storage.get<ThemeName>(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  // The inline script in index.html also does this; we repeat the
  // logic here so state-of-record inside React matches what the
  // browser renders before React mounts.
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readInitialTheme(),
  setTheme: (next) => {
    storage.set(STORAGE_KEY, next);
    set({ theme: next });
  },
  toggle: () => {
    const next: ThemeName = get().theme === 'dark' ? 'light' : 'dark';
    storage.set(STORAGE_KEY, next);
    set({ theme: next });
  },
}));
