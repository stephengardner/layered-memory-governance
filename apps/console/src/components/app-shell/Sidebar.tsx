import { useState, useCallback } from 'react';
import { Book, GitBranch, Activity, Users, Network, LineChart, Workflow, Gauge, Lightbulb, ShieldAlert, Radio, GitFork, Brain, Zap, MoreHorizontal, GitMerge, RotateCcw } from 'lucide-react';
import { routeHref, setRoute, type Route } from '@/state/router.store';
import logoUrl from '@/assets/lag-logo.png';
import styles from './Sidebar.module.css';
import { MobileNavOverflow } from './MobileNavOverflow';

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
   *
   * Critical entries (operator-facing live views) also sit at the head
   * of the nav even when alphabetical ordering would push them down:
   * `live-ops` (Pulse) answers the "what is the org doing right now?"
   * question at a glance.
   */
  readonly priority?: 'critical';
  /*
   * Membership in the mobile bottom-tab bar. Picks the four
   * destinations that warrant a permanent slot at iPhone-13-class
   * widths; everything else surfaces from the overflow drawer
   * behind the MoreHorizontal button. Per the iOS Tab Bar More /
   * Android Bottom Navigation More convention, the visible set
   * stays small and stable so the operator builds muscle memory
   * for the four they hit constantly. Items not flagged with this
   * field render in the overflow drawer, alphabetised.
   */
  readonly mobileBar?: boolean;
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
  { id: 'live-ops', label: 'Pulse', icon: Zap, priority: 'critical' },
  { id: 'dashboard', label: 'Dashboard', mobileLabel: 'Home', icon: Gauge, mobileBar: true },
  { id: 'control', label: 'Control', icon: ShieldAlert, priority: 'critical', mobileBar: true },
  { id: 'canon', label: 'Canon', icon: Book, mobileBar: true },
  { id: 'canon-suggestions', label: 'Suggestions', icon: Lightbulb },
  { id: 'principals', label: 'Principals', icon: Users },
  { id: 'hierarchy', label: 'Hierarchy', icon: GitFork },
  { id: 'actor-activity', label: 'Control Tower', icon: Radio },
  { id: 'activities', label: 'Activities', icon: Activity },
  { id: 'plans', label: 'Plans', icon: GitBranch, mobileBar: true },
  { id: 'pipelines', label: 'Pipelines', icon: GitMerge },
  { id: 'resume', label: 'Resume', icon: RotateCcw },
  { id: 'plan-lifecycle', label: 'Lifecycle', icon: Workflow },
  { id: 'deliberation', label: 'Deliberation', icon: Brain },
  { id: 'timeline', label: 'Timeline', icon: LineChart },
  { id: 'graph', label: 'Graph', icon: Network },
];

export function Sidebar({ route }: { route: Route }) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  /*
   * Stable close callback. The ref pattern inside MobileNavOverflow
   * is defense-in-depth, but a stable identity at the call site is
   * the right shape for the seam: any future hook that takes the
   * close handler as a dep (e.g. an outside-click listener composed
   * over the drawer) shouldn't re-fire on every Sidebar render.
   * `setOverflowOpen` is stable from React, so this useCallback
   * is genuinely stable across the component's lifetime.
   */
  const closeOverflow = useCallback(() => setOverflowOpen(false), []);

  /*
   * Desktop renders the full flat list (the existing behavior, which
   * is correct above 48rem where the sidebar is a vertical column).
   * Mobile renders a separate bar with only `mobileBar` items + a
   * MoreHorizontal trigger that opens the overflow drawer. Both are
   * in the markup; CSS media queries (Sidebar.module.css) gate which
   * is visible. Keeping the toggle CSS-only avoids a JS viewport
   * read, dodging the flash-of-wrong-layout issue and SSR mismatch
   * concerns flagged in canon `dev-web-multi-theme-tokens`.
   */
  const mobileBarItems = items.filter((i) => i.mobileBar === true);
  const overflowItems = items.filter((i) => i.mobileBar !== true);
  /*
   * If the active route lives in the overflow drawer the More button
   * itself takes the active treatment (small dot indicator) so the
   * operator gets a clear "you are over here" hint without expanding
   * the drawer.
   */
  const activeIsInOverflow = overflowItems.some((i) => i.id === route);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <img src={logoUrl} alt="LAG" className={styles.brandLogo} />
        <div className={styles.brandTagline}>Console</div>
      </div>

      {/* Desktop: full flat list. Hidden below 48rem. */}
      <nav className={styles.navDesktop} aria-label="Primary">
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

      {/* Mobile: 4 critical tabs + overflow trigger. Hidden above 48rem. */}
      <nav className={styles.navMobile} aria-label="Primary mobile">
        {mobileBarItems.map((item) => {
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
              data-testid={`mobile-nav-${item.id}`}
              data-priority={item.priority ?? undefined}
              onClick={(e) => {
                if (e.defaultPrevented) return;
                if (e.button !== 0) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                setRoute(item.id);
              }}
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              {item.mobileLabel ? (
                <span className={styles.itemLabelMobile}>{item.mobileLabel}</span>
              ) : (
                <span className={styles.itemLabelMobile}>{item.label}</span>
              )}
            </a>
          );
        })}
        <button
          type="button"
          className={[
            styles.item,
            styles.itemMore,
            activeIsInOverflow ? styles.itemMoreActive : '',
          ].filter(Boolean).join(' ')}
          aria-label="More navigation"
          aria-haspopup="dialog"
          aria-expanded={overflowOpen}
          aria-controls="mobile-nav-overflow-dialog"
          data-testid="mobile-nav-more"
          data-active-in-overflow={activeIsInOverflow ? 'true' : undefined}
          onClick={() => setOverflowOpen((v) => !v)}
        >
          <span className={styles.itemMoreIconWrap}>
            <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
            {activeIsInOverflow && (
              <span className={styles.itemMoreDot} aria-hidden="true" />
            )}
          </span>
          <span className={styles.itemLabelMobile}>More</span>
        </button>
      </nav>

      <MobileNavOverflow
        open={overflowOpen}
        onClose={closeOverflow}
        items={overflowItems}
        currentRoute={route}
      />
    </aside>
  );
}
