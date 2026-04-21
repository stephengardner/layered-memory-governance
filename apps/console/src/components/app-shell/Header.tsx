import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '@/state/theme.store';
import styles from './Header.module.css';

/**
 * Top app bar. For v1, minimal: breadcrumb/title + theme toggle.
 * Future: daemon status pill, kill-switch indicator, command palette.
 */
export function Header() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const nextLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <header className={styles.header}>
      <div className={styles.titleGroup}>
        <h1 className={styles.title}>Canon</h1>
        <span className={styles.subtitle}>
          Governance substrate — directives, decisions, preferences, references
        </span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.themeToggle}
          onClick={toggle}
          aria-label={nextLabel}
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
        </button>
      </div>
    </header>
  );
}
