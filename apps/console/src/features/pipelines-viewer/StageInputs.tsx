import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Accordion } from '@/components/accordion/Accordion';
import styles from './StageInputs.module.css';

/**
 * Render the per-stage "Inputs" disclosure: chip list of
 * `input_atom_ids` capped by viewport, with a "+M more" overflow chip
 * that expands the list inline.
 *
 * Defensive: the field is optional on the wire today; the parent
 * already short-circuits when the array is empty so this component
 * is only mounted when there is at least one id to render. The cap
 * is breakpoint-aware (4 on < md, 8 on >= md) per the spec; the cap
 * recomputes on resize so a portrait <-> landscape rotation does
 * not strand the stage card with the wrong density.
 */

const CAP_MOBILE = 4;
const CAP_DESKTOP = 8;
const MD_BREAKPOINT_PX = 768;

interface StageInputsProps {
  readonly stageName: string;
  readonly inputAtomIds: ReadonlyArray<string>;
}

export function StageInputs({ stageName, inputAtomIds }: StageInputsProps) {
  /*
   * Track viewport width on a single resize listener so the chip cap
   * adjusts with no parent re-render. Default to desktop on the first
   * render so SSR / pre-mount measurement defaults to the higher cap;
   * the effect corrects after mount.
   */
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia(`(min-width: ${MD_BREAKPOINT_PX}px)`).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia(`(min-width: ${MD_BREAKPOINT_PX}px)`);
    const handler = (event: MediaQueryListEvent): void => {
      setIsDesktop(event.matches);
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  const [expanded, setExpanded] = useState<boolean>(false);
  const cap = isDesktop ? CAP_DESKTOP : CAP_MOBILE;
  const visible = expanded ? inputAtomIds : inputAtomIds.slice(0, cap);
  const overflow = Math.max(0, inputAtomIds.length - visible.length);

  return (
    <Accordion
      title="Inputs"
      defaultOpen={isDesktop}
      testId={`pipeline-stage-inputs-${stageName}`}
      count={inputAtomIds.length}
    >
      <ul
        className={styles.list}
        data-testid={`pipeline-stage-inputs-list-${stageName}`}
      >
        {visible.map((id, idx) => (
          <motion.li
            key={id}
            className={styles.chipWrap}
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, delay: Math.min(idx, 8) * 0.018, ease: [0.2, 0, 0, 1] }}
          >
            <AtomRef id={id} variant="chip" />
          </motion.li>
        ))}
        {overflow > 0 && !expanded && (
          <li className={styles.chipWrap}>
            <button
              type="button"
              className={styles.overflowChip}
              onClick={() => setExpanded(true)}
              data-testid={`pipeline-stage-inputs-more-${stageName}`}
            >
              +{overflow} more
            </button>
          </li>
        )}
      </ul>
    </Accordion>
  );
}
