import { Book, GitBranch, Activity, Users, Network, LineChart, Workflow } from 'lucide-react';
import { routeHref, setRoute, type Route } from '@/state/router.store';
import logoUrl from '@/assets/lag-logo.png';
import styles from './Sidebar.module.css';

interface NavItem {
  readonly id: Route;
  readonly label: string;
  readonly icon: typeof Book;
}

const items: ReadonlyArray<NavItem> = [
  { id: 'canon', label: 'Canon', icon: Book },
  { id: 'principals', label: 'Principals', icon: Users },
  { id: 'activities', label: 'Activities', icon: Activity },
  { id: 'plans', label: 'Plans', icon: GitBranch },
  { id: 'plan-lifecycle', label: 'Lifecycle', icon: Workflow },
  { id: 'timeline', label: 'Timeline', icon: LineChart },
  { id: 'graph', label: 'Graph', icon: Network },
];

export function Sidebar({ route }: { route: Route }) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <img src={logoUrl} alt="LAG" className={styles.brandLogo} />
        <div className={styles.brandTagline}>Console</div>
      </div>
      <nav className={styles.nav} aria-label="Primary">
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === route;
          return (
            <a
              key={item.id}
              className={`${styles.item} ${active ? styles.itemActive : ''}`}
              href={routeHref(item.id)}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${item.id}`}
              onClick={(e) => {
                // Intercept: use pushState navigation instead of full
                // page load. Keep default behavior for Cmd/Ctrl+click
                // (open in new tab) and middle-click.
                if (e.defaultPrevented) return;
                if (e.button !== 0) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                setRoute(item.id);
              }}
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
