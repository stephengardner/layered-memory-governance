import { Rows3, Rows2 } from 'lucide-react';
import { useDensityStore } from '@/state/density.store';
import styles from './DensityToggle.module.css';

export function DensityToggle() {
  const density = useDensityStore((s) => s.density);
  const toggle = useDensityStore((s) => s.toggle);
  const nextLabel = density === 'comfortable' ? 'Switch to compact density' : 'Switch to comfortable density';
  const Icon = density === 'comfortable' ? Rows2 : Rows3;
  return (
    <button
      type="button"
      className={styles.button}
      onClick={toggle}
      aria-label={nextLabel}
      aria-pressed={density === 'compact'}
      data-testid="density-toggle"
      data-density={density}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}
