import { useEffect } from 'react';
import { setRoute, type Route } from '@/state/router.store';

/**
 * Global keyboard shortcuts. Single event listener on document so
 * all views share one binding table.
 *
 * Two-key (vim-style) sequences:
 *   g c → /canon      g p → /principals
 *   g a → /activities g l → /plans
 *
 * Single keys:
 *   /  → focus the global search input (if present on the page)
 *   ?  → toggle the shortcuts-help overlay
 *   Esc → clear focus / close any open dialog (handled by those
 *         components; this hook does nothing for it)
 *
 * Sequence prefix state lives in a ref inside the hook — we do not
 * leak it as Zustand state because it would re-render every key
 * press and only the hook itself cares about it.
 */
export interface ShortcutHandlers {
  readonly toggleHelp?: () => void;
  readonly openPalette?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers = {}) {
  useEffect(() => {
    let prefix: 'g' | null = null;
    let prefixAt = 0;

    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K opens the palette — fires REGARDLESS of focus
      // (it's how you escape a focused input back to nav).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.openPalette?.();
        return;
      }

      // Never trigger plain-key shortcuts when user is typing.
      const t = e.target as HTMLElement;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const now = Date.now();

      // `g <x>` sequence support. Window is 1.2s after `g`.
      if (prefix === 'g' && now - prefixAt < 1200) {
        const map: Record<string, Route | undefined> = {
          c: 'canon',
          p: 'principals',
          a: 'activities',
          l: 'plans',
        };
        const target = map[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          setRoute(target);
        }
        prefix = null;
        return;
      }

      if (e.key === 'g' && !e.shiftKey) {
        prefix = 'g';
        prefixAt = now;
        return;
      }

      if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>(
          '[data-global-search], input[type="search"]',
        );
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      if (e.key === '?' && e.shiftKey) {
        e.preventDefault();
        handlers.toggleHelp?.();
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handlers]);
}
