import { Book, GitBranch, Activity, Users } from 'lucide-react';
import logoUrl from '@/assets/lag-logo.png';
import styles from './Sidebar.module.css';

interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: typeof Book;
  readonly active?: boolean;
  readonly disabled?: boolean;
}

const items: ReadonlyArray<NavItem> = [
  { id: 'canon', label: 'Canon', icon: Book, active: true },
  { id: 'principals', label: 'Principals', icon: Users, disabled: true },
  { id: 'activities', label: 'Activities', icon: Activity, disabled: true },
  { id: 'plans', label: 'Plans', icon: GitBranch, disabled: true },
];

export function Sidebar() {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <img src={logoUrl} alt="LAG" className={styles.brandLogo} />
        <div className={styles.brandTagline}>Console</div>
      </div>
      <nav className={styles.nav} aria-label="Primary">
        {items.map((item) => {
          const Icon = item.icon;
          const className = [
            styles.item,
            item.active ? styles.itemActive : '',
            item.disabled ? styles.itemDisabled : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={item.id}
              className={className}
              aria-current={item.active ? 'page' : undefined}
              disabled={item.disabled}
              type="button"
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{item.label}</span>
              {item.disabled && <span className={styles.soonBadge}>soon</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
