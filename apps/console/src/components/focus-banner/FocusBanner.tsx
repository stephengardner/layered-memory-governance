import { X } from 'lucide-react';
import styles from './FocusBanner.module.css';

interface Props {
  readonly label: string;
  readonly id: string;
  readonly onClear: () => void;
}

/**
 * Shown at the top of a view when `?focus=<id>` is in the URL. Makes
 * the focus state visible AND recoverable — the clear button strips
 * the query param via the provided callback (each view passes its own
 * setRoute target). Reused by Canon, Plans, Activities views.
 */
export function FocusBanner({ label, id, onClear }: Props) {
  return (
    <div className={styles.banner} data-testid="focus-banner">
      <span className={styles.label}>{label}</span>
      <code className={styles.id}>{id}</code>
      <button
        type="button"
        className={styles.clear}
        onClick={onClear}
        aria-label="Clear focus"
        data-testid="focus-clear"
      >
        <X size={12} strokeWidth={2.5} /> clear
      </button>
    </div>
  );
}
