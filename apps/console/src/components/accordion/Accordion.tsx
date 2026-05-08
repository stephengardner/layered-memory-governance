import { useId, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import styles from './Accordion.module.css';

/**
 * Minimal disclosure / accordion primitive.
 *
 * The codebase does not vendor shadcn/ui (no `components.json`,
 * no Radix UI deps); CLAUDE.md principle #2 keeps our hand-written
 * components on semantic CSS modules that resolve to tokens. This
 * file ships the smallest disclosure shape that satisfies the canon
 * `dev-web-mobile-first-required` + `dev-web-interaction-quality-no-jank`
 * directives without dragging the shadcn footprint in for a single use.
 *
 * ARIA: the trigger is a real <button> with `aria-expanded` +
 * `aria-controls`; the panel is a <section role="region"> with
 * `aria-labelledby`. Matches the contract the StageContextPanel
 * already uses on /atom/<id>, /plans/<id>, /deliberation/<id> so
 * future a11y tests inherit one shape.
 *
 * Default-open is a controlled prop so the Inputs accordion can flip
 * by viewport (open at >= md, closed at < md) without the parent
 * driving the state machine itself.
 */

interface AccordionProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly testId?: string;
  /** Optional count chip rendered next to the title (e.g. "12"). */
  readonly count?: number;
}

export function Accordion({
  title,
  children,
  defaultOpen = false,
  testId,
  count,
}: AccordionProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const headingId = useId();
  const panelId = useId();
  return (
    <div
      className={styles.root}
      data-testid={testId}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        id={headingId}
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        data-testid={testId ? `${testId}-trigger` : undefined}
      >
        <span className={styles.triggerChevron} data-open={open ? 'true' : 'false'} aria-hidden="true">
          <ChevronRight size={12} strokeWidth={2.25} />
        </span>
        <span className={styles.triggerLabel}>{title}</span>
        {typeof count === 'number' && count > 0 && (
          <span className={styles.triggerCount} data-testid={testId ? `${testId}-count` : undefined}>
            {count}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.section
            id={panelId}
            role="region"
            aria-labelledby={headingId}
            className={styles.panel}
            data-testid={testId ? `${testId}-panel` : undefined}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className={styles.panelInner}>{children}</div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
