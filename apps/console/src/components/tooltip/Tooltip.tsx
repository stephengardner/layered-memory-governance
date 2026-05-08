import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './Tooltip.module.css';

/**
 * Lightweight tooltip primitive used for compact hover/focus copy.
 *
 * Why not vendor shadcn/ui here: no `components.json`, no Radix UI
 * deps, and CLAUDE.md principle #2 keeps our hand-written components
 * on semantic CSS modules that resolve to tokens. Building the smallest
 * accessible tooltip surface in-tree avoids dragging the shadcn
 * footprint into the bundle for a single use site.
 *
 * Wrapping pattern: the tooltip wraps its trigger in an inline-block
 * `<span>` that catches mouse + focus events. Disabled buttons do
 * NOT fire focus / mouse events in some browsers (Chrome
 * specifically suppresses pointer events on `disabled`), so wiring
 * the listeners to a non-disabled wrapper is the only path that
 * keeps the tooltip working when its child is `<button disabled>`.
 * Radix and shadcn both wrap disabled triggers the same way for the
 * same reason.
 *
 * ARIA contract: the wrapper carries `aria-describedby` pointing at
 * the floating label so a screen reader hears the tooltip content
 * when the trigger is focused (the wrapper itself does not steal
 * focus; the label is associated through the descendant trigger via
 * the wrapper's wrapping role). The label is a `role="tooltip"`
 * portal'd <div> so it renders above page-level z-index sinks.
 */

interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  /** Optional test-id forwarded to the floating tooltip for e2e selection. */
  readonly testId?: string;
}

export function Tooltip({ content, children, testId }: TooltipProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState<boolean>(false);
  const [pos, setPos] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  const showFromElement = (el: HTMLElement | null): void => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 6 });
    setOpen(true);
  };

  const hide = (): void => {
    setOpen(false);
  };

  /*
   * Wrap the trigger in a focus-capable inline span. `tabIndex={-1}`
   * keeps the wrapper out of the tab order (the inner button still
   * receives keyboard focus when enabled), but a `focusin` /
   * `focusout` (capturing variants of focus/blur) fires on the
   * wrapper whenever its descendants gain or lose focus -- including
   * a programmatic `el.focus()` on a disabled button, which fires no
   * regular React onFocus on the button itself.
   */
  const handleMouseEnter = (event: MouseEvent<HTMLSpanElement>): void => {
    showFromElement(event.currentTarget);
  };
  const handleMouseLeave = (): void => {
    hide();
  };
  const handleFocus = (event: FocusEvent<HTMLSpanElement>): void => {
    showFromElement(event.currentTarget);
  };
  const handleBlur = (): void => {
    hide();
  };

  return (
    <>
      <span
        ref={wrapperRef}
        className={styles.wrapper}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        {...(open ? { 'aria-describedby': tooltipId } : {})}
      >
        {children}
      </span>
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              id={tooltipId}
              role="tooltip"
              data-testid={testId}
              className={styles.tooltip}
              style={{
                top: pos.y,
                left: Math.max(12, Math.min(pos.x, window.innerWidth - 12)),
              }}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
            >
              {content}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
