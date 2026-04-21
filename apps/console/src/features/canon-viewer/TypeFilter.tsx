import type { AtomType } from '@/services/canon.service';
import styles from './TypeFilter.module.css';

export interface TypeOption {
  readonly id: string;
  readonly label: string;
  readonly types: ReadonlyArray<AtomType>;
}

interface Props {
  readonly options: ReadonlyArray<TypeOption>;
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
}

export function TypeFilter({ options, activeId, onSelect }: Props) {
  return (
    <div className={styles.group} role="tablist" aria-label="Filter by atom type">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={activeId === opt.id}
          className={`${styles.chip} ${activeId === opt.id ? styles.chipActive : ''}`}
          onClick={() => onSelect(opt.id)}
          data-testid={`type-filter-${opt.id}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
