import { Book, GitBranch, Activity, Users, Network, LineChart, Workflow, Gauge, Lightbulb, ShieldAlert, Radio, GitFork, Brain } from 'lucide-react';
import { routeHref, setRoute, type Route } from '@/state/router.store';
import logoUrl from '@/assets/lag-logo.png';
import styles from './Sidebar.module.css';

interface NavItem {
  readonly id: Route;
  readonly label: string;
  readonly icon: typeof Book;
  /*
   * Operator-critical nav items render with the highlighted treatment
   * so the "halt the org" affordance (the control panel surfacing the
   * kill switch + autonomy tier) is one glance away from anywhere in
   * the app. Per canon `inv-kill-switch-before-autonomy`, the kill
   * switch is load-bearing; the operator should never have to hunt
   * for it.
   */
  readonly priority?: 'critical';
  /*
   * Optional shorter label used when the sidebar collapses into the
   * mobile bottom-tab bar (≤48rem). Only set this when the desktop
   * label overflows the constrained tab width on iPhone-13-class
   * viewports; most labels fit fine. Visibility is CSS-driven via
   * `.itemLabelDesktop` / `.itemLabelMobile` so there's no JS
   * viewport read and no SSR mismatch risk.
   */
  readonly mobileLabel?: string;
}

const items: ReadonlyArray<NavItem> = [
  { id: 'dashboard', label: 'Dashboard', mobileLabel: 'Home', icon: Gauge },
  { id: 'control', label: 'Control', icon: ShieldAlert, priority: 'critical' },
  { id: 'canon', label: 'Canon', icon: Book },
  { id: 'canon-suggestions', label: 'Suggestions', icon: Lightbulb },
  { id: 'principals', label: 'Principals', icon: Users },
  { id: 'hierarchy', label: 'Hierarchy', icon: GitFork },
  { id: 'actor-activity', label: 'Control Tower', icon: Radio },
  { id: 'activities', label: 'Activities', icon: Activity },
  { id: 'plans', label: 'Plans', icon: GitBranch },
  { id: 'plan-lifecycle', label: 'Lifecycle', icon: Workflow },
  { id: 'deliberation', label: 'Deliberation', icon: Brain },
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
          const critical = item.priority === 'critical';
          const cls = [
            styles.item,
            active ? styles.itemActive : '',
            critical ? styles.itemCritical : '',
          ].filter(Boolean).join(' ');
          return (
            <a
              key={item.id}
              className={cls}
              href={routeHref(item.id)}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${item.id}`}
              data-priority={item.priority ?? undefined}
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
              <span className={styles.itemLabelDesktop}>{item.label}</span>
              {item.mobileLabel ? (
                <span className={styles.itemLabelMobile}>{item.mobileLabel}</span>
              ) : null}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
