import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Braces, ChevronDown } from 'lucide-react';
import styles from './RawJson.module.css';

interface Props {
  readonly value: unknown;
  readonly label?: string;
  readonly testId?: string;
}

/**
 * Power-user escape hatch. Renders a "Show JSON" button that
 * expands a monospace block of the full atom as formatted JSON.
 * Lets an operator see the raw shape without leaving the view.
 */
export function RawJson({ value, label = 'Show JSON', testId }: Props) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(value, null, 2);
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.toggle} ${open ? styles.toggleOpen : ''}`}
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        data-testid={testId}
      >
        <Braces size={12} strokeWidth={2} />
        {open ? 'Hide JSON' : label}
        <ChevronDown size={12} strokeWidth={2} className={styles.chevron} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={styles.body}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          >
            <pre className={styles.pre}>{json}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
