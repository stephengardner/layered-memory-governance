import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hover-card visibility + stay-open timing primitive.
 *
 * The behavior the user asked for: when a tooltip is visible and the
 * user moves the mouse FROM the trigger ONTO the tooltip, the tooltip
 * does NOT disappear. This needs a two-sided hover model — both the
 * trigger and the tooltip participate in the "hovered zone" — with a
 * short close-delay so cursor travel between the two elements doesn't
 * dismiss.
 *
 * Consumers wire:
 *   - trigger mouseenter → show(x, y)
 *   - trigger mousemove → optionally updatePos(x, y) to track the cursor
 *   - trigger mouseleave → scheduleHide()
 *   - tooltip mouseenter → cancelHide()
 *   - tooltip mouseleave → scheduleHide()
 *
 * The CLOSE_DELAY_MS window is the cursor-travel budget. 180ms is
 * comfortable without feeling sticky.
 */
export interface HoverCardState<T> {
  readonly open: boolean;
  readonly data: T | null;
  readonly pos: { x: number; y: number } | null;
}

export interface HoverCardHandlers<T> {
  readonly show: (data: T, x: number, y: number) => void;
  readonly updatePos: (x: number, y: number) => void;
  readonly scheduleHide: () => void;
  readonly cancelHide: () => void;
  readonly close: () => void;
}

const CLOSE_DELAY_MS = 180;

export function useHoverCard<T>(): HoverCardState<T> & HoverCardHandlers<T> {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<T | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current != null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const show = useCallback((next: T, x: number, y: number) => {
    cancelHide();
    setData(next);
    setPos({ x, y });
    setOpen(true);
  }, [cancelHide]);

  const updatePos = useCallback((x: number, y: number) => {
    setPos({ x, y });
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setData(null);
      setPos(null);
      hideTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  }, [cancelHide]);

  const close = useCallback(() => {
    cancelHide();
    setOpen(false);
    setData(null);
    setPos(null);
  }, [cancelHide]);

  // Cleanup on unmount so a stray timer doesn't try to setState on a
  // dead component.
  useEffect(() => () => cancelHide(), [cancelHide]);

  return { open, data, pos, show, updatePos, scheduleHide, cancelHide, close };
}
