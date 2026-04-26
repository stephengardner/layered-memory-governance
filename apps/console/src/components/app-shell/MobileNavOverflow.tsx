import { useEffect, useRef, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Book } from 'lucide-react';
import { routeHref, setRoute, type Route } from '@/state/router.store';
import styles from './MobileNavOverflow.module.css';

/**
 * Mobile bottom-nav overflow drawer.
 *
 * Mirrors the iOS Tab Bar More / Android Bottom Navigation More
 * pattern. The bottom bar shows the four operator-critical destinations
 * plus a `MoreHorizontal` button; tapping the button slides this
 * drawer up from the bottom and surfaces every non-critical
 * destination (alphabetised by label for predictability).
 *
 * Why a portal: the bottom-nav itself is `position: fixed` (z-index
 * 50). Without a portal a child overlay would inherit the same
 * stacking context as the bar and risk fighting the existing modal
 * stack (CommandPalette uses 200/201). Hoisting to document.body
 * isolates the drawer's z-index from any parent transforms, fixed
 * ancestors, or `overflow: hidden` clippers further up the tree.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true" + labelled by visible heading
 *   - Focus is moved into the drawer on open; tab cycles inside
 *     the dialog via a manual `focusin` clamp (no third-party trap)
 *   - Escape closes
 *   - Backdrop click closes
 *   - prefers-reduced-motion: skips slide animation, instant fade
 */

interface NavItemRef {
  readonly id: Route;
  readonly label: string;
  /*
   * `typeof Book` matches the lucide-react icon component signature
   * (a ForwardRefExoticComponent with the LucideProps surface) and
   * sidesteps the exactOptionalPropertyTypes friction that arises
   * from a hand-rolled ComponentType<...> alias.
   */
  readonly icon: typeof Book;
}

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly items: ReadonlyArray<NavItemRef>;
  readonly currentRoute: Route;
}

export function MobileNavOverflow({ open, onClose, items, currentRoute }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  /*
   * Stash the latest `onClose` in a ref so the effect below can
   * fire its keyboard handler without taking onClose as a dep.
   * Without this ref the effect tears down + re-runs on every
   * parent render (since Sidebar passes a fresh inline arrow at
   * the call site), which would yank focus back to the trigger
   * mid-interaction and corrupt previousFocusRef. Updating the
   * ref via a layoutless side-effect keeps callers free to pass
   * inline arrows without paying a focus-thrash penalty.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /*
   * Sort drawer entries alphabetically by label. Predictable
   * ordering beats "designer's intent" once the org grows past
   * ~10 destinations; the operator scans by first letter, not
   * by position.
   */
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.label.localeCompare(b.label)),
    [items],
  );

  /*
   * Keyboard: escape + focus management. Capture the previously
   * focused element on open, restore it on close. Manual tab
   * containment is implemented via a focusin handler that snaps
   * focus back to the dialog if it escapes.
   */
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    // Move initial focus into the dialog so screen readers + keyboard
    // users land on the drawer content, not the underlying page.
    const dialog = dialogRef.current;
    if (dialog) {
      const firstFocusable = dialog.querySelector<HTMLElement>(
        'a, button, [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };

    /*
     * Lightweight focus trap. When focus leaves the dialog (e.g.
     * the user shift-tabs past the first focusable), redirect it
     * back to the first focusable inside. This is intentionally
     * simpler than a full focus-trap library (3KB+ for behavior we
     * already get from one event listener) and matches what
     * shadcn's Dialog primitive does internally.
     *
     * The `!open` early-return guards the close-by-backdrop-click
     * race: between `onClick={onClose}` setting `open=false` and
     * React unmounting the portal, focus moves to document.body
     * and `focusin` fires; without this guard the handler would
     * snap focus back into the drawer right before unmount,
     * causing a brief focus flash + extra screen-reader
     * announcement. The `dialogRef.current.isConnected` belt-and-
     * suspenders catches the same race when state-update timing
     * leaves `open` stale during the unmount tick.
     */
    const onFocusIn = (e: FocusEvent) => {
      if (!open) return;
      const dlg = dialogRef.current;
      if (!dlg || !dlg.isConnected) return;
      const target = e.target as Node | null;
      if (target && !dlg.contains(target)) {
        const firstFocusable = dlg.querySelector<HTMLElement>(
          'a, button, [tabindex]:not([tabindex="-1"])',
        );
        firstFocusable?.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      // Restore focus to the trigger element on close so keyboard
      // users do not lose their place.
      previousFocusRef.current?.focus();
    };
    // onClose intentionally omitted: it's read through onCloseRef
    // so the effect doesn't tear down on every parent render. See
    // the ref setup above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /*
   * Reduced-motion is read once per open via matchMedia; framer-motion
   * itself also honours `useReducedMotion` but we additionally collapse
   * the slide distance to zero so the drawer just fades in. Reading
   * this on each render is fine; matchMedia is synchronous and cheap.
   */
  const reducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * Mount-gate so the createPortal(document.body) call is never
   * evaluated during a server render. The console is currently
   * pure CSR (vite.config.ts has no SSR setup), so this guard is
   * defensive: it matches the `typeof window` discipline used a
   * few lines up for matchMedia, and would prevent a landmine if
   * SSR / prerender ever lands on this app. Cost is one extra
   * render at component mount.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
            onClick={onClose}
            data-testid="mobile-nav-overflow-backdrop"
            aria-hidden="true"
          />
          <motion.div
            ref={dialogRef}
            id="mobile-nav-overflow-dialog"
            className={styles.sheet}
            initial={{ y: reducedMotion ? 0 : '100%', opacity: reducedMotion ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: reducedMotion ? 0 : '100%', opacity: reducedMotion ? 0 : 1 }}
            transition={{ duration: reducedMotion ? 0.12 : 0.22, ease: [0.2, 0, 0, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-nav-overflow-title"
            data-testid="mobile-nav-overflow"
          >
            <div className={styles.handle} aria-hidden="true" />
            <h2 id="mobile-nav-overflow-title" className={styles.title}>More</h2>
            <ul className={styles.list}>
              {sorted.map((item) => {
                const Icon = item.icon;
                const active = item.id === currentRoute;
                return (
                  <li key={item.id}>
                    <a
                      className={`${styles.item} ${active ? styles.itemActive : ''}`}
                      href={routeHref(item.id)}
                      aria-current={active ? 'page' : undefined}
                      data-testid={`mobile-nav-overflow-item-${item.id}`}
                      onClick={(e) => {
                        if (e.defaultPrevented) return;
                        if (e.button !== 0) return;
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        setRoute(item.id);
                        onClose();
                      }}
                    >
                      <Icon size={18} strokeWidth={1.75} aria-hidden={true} />
                      <span>{item.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
