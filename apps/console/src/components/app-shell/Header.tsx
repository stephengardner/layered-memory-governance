import { Moon, Sun, Flame, Plus } from 'lucide-react';
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
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Autonomous-loop health at a glance: atom volume, plan outcomes, drafter economics',
  },
  control: {
    title: 'Operator Control Panel',
    subtitle: 'Kill-switch state, autonomy tier, and live governance posture',
  },
  canon: {
    title: 'Canon',
    subtitle: 'Governance substrate — directives, decisions, preferences, references',
  },
  'canon-suggestions': {
    title: 'Suggestions',
    subtitle: 'Agent-observed canon proposals awaiting operator triage — promote, dismiss, or defer via CLI',
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
  'plan-lifecycle': {
    title: 'Plan Lifecycle',
    subtitle: 'End-to-end view of every plan\'s autonomous-loop chain — intent through merge',
  },
  graph: {
    title: 'Graph',
    subtitle: 'The whole substrate as a force-directed map of derived_from relationships',
  },
  timeline: {
    title: 'Timeline',
    subtitle: 'Who wrote what, when — atoms laid out across the principal hierarchy',
  },
  'actor-activity': {
    title: 'Control Tower',
    subtitle: 'Real-time view of which principals are writing atoms right now',
  },
};

/**
 * Top app bar. For v1: route-aware title + subtitle + theme toggle.
 * Future: daemon status pill, kill-switch indicator, command palette.
 */
export function Header({ route, onPropose }: { route: Route; onPropose?: (() => void) | undefined }) {
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
        {onPropose && (
          <button
            type="button"
            className={styles.proposeBtn}
            onClick={onPropose}
            data-testid="header-propose"
            aria-label="Propose a new atom"
          >
            <Plus size={14} strokeWidth={2.25} />
            <span className={styles.proposeLabel}>propose</span>
          </button>
        )}
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
