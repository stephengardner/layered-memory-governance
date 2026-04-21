import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import styles from './ShortcutsHelp.module.css';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

const GROUPS: ReadonlyArray<{ title: string; items: ReadonlyArray<[string, string]> }> = [
  {
    title: 'Navigation',
    items: [
      ['g then c', 'Go to Canon'],
      ['g then p', 'Go to Principals'],
      ['g then a', 'Go to Activities'],
      ['g then l', 'Go to Plans'],
    ],
  },
  {
    title: 'Search',
    items: [
      ['/', 'Focus the search field'],
      ['Cmd/Ctrl + K', 'Open command palette'],
    ],
  },
  {
    title: 'Help',
    items: [
      ['?', 'Toggle this help'],
      ['Esc', 'Close dialogs / clear focus'],
    ],
  },
];

export function ShortcutsHelp({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            data-testid="shortcuts-backdrop"
          />
          <div className={styles.wrap}>
            <motion.div
              className={styles.dialog}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
              role="dialog"
              aria-labelledby="shortcuts-title"
              data-testid="shortcuts-help"
            >
            <h2 id="shortcuts-title" className={styles.title}>Keyboard shortcuts</h2>
            <div className={styles.groups}>
              {GROUPS.map((g) => (
                <section key={g.title} className={styles.group}>
                  <h3 className={styles.groupTitle}>{g.title}</h3>
                  <dl className={styles.table}>
                    {g.items.map(([keys, desc]) => (
                      <div key={keys} className={styles.row}>
                        <dt className={styles.keys}>{renderKeys(keys)}</dt>
                        <dd className={styles.desc}>{desc}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

function renderKeys(s: string): React.ReactNode {
  // Split on "then" or "+" and wrap each atomic key in a <kbd>.
  const parts = s.split(/\s+(then|\+)\s+/);
  return parts.map((p, i) =>
    p === 'then' || p === '+' ? (
      <span key={i} className={styles.sep}>{p}</span>
    ) : (
      <kbd key={i} className={styles.kbd}>{p}</kbd>
    ),
  );
}
