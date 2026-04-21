import { Moon, Sun, Flame } from 'lucide-react';
import { useThemeStore } from '@/state/theme.store';
import { DensityToggle } from '@/components/density-toggle/DensityToggle';
import { DaemonStatusPill } from '@/components/daemon-pill/DaemonStatusPill';
import { KillSwitchPill } from '@/components/kill-switch-pill/KillSwitchPill';
import type { Route } from '@/state/router.store';
import logoUrl from '@/assets/lag-logo.png';
import styles from './Header.module.css';

interface RouteMeta {
  readonly title: string;
  readonly subtitle: string;
}

const ROUTE_META: Record<Route, RouteMeta> = {
  canon: {
    title: 'Canon',
    subtitle: 'Governance substrate — directives, decisions, preferences, references',
  },
  principals: {
    title: 'Principals',
    subtitle: 'Identities that author atoms and hold authority in the hierarchy',
  },
  activities: {
    title: 'Activities',
    subtitle: 'Recent atom writes across layers, sorted by time',
  },
  plans: {
    title: 'Plans',
    subtitle: 'Planning atoms with state — proposals, approvals, in-flight work',
  },
  graph: {
    title: 'Graph',
    subtitle: 'The whole substrate as a force-directed map of derived_from relationships',
  },
};

/**
 * Top app bar. For v1: route-aware title + subtitle + theme toggle.
 * Future: daemon status pill, kill-switch indicator, command palette.
 */
export function Header({ route }: { route: Route }) {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const meta = ROUTE_META[route];

  return (
    <header className={styles.header}>
      <img src={logoUrl} alt="LAG" className={styles.mobileLogo} />
      <div className={styles.titleGroup}>
        <h1 className={styles.title}>{meta.title}</h1>
        <span className={styles.subtitle}>{meta.subtitle}</span>
      </div>
      <div className={styles.actions}>
        <KillSwitchPill />
        <DaemonStatusPill />
        <DensityToggle />
        <button
          type="button"
          className={styles.themeToggle}
          onClick={toggle}
          aria-label="Cycle theme"
          data-testid="theme-toggle"
          data-theme={theme}
        >
          {theme === 'dark' && <Sun size={16} strokeWidth={1.75} />}
          {theme === 'light' && <Flame size={16} strokeWidth={1.75} />}
          {theme === 'sunset' && <Moon size={16} strokeWidth={1.75} />}
        </button>
      </div>
    </header>
  );
}
