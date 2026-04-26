import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell/AppShell';
import { ShortcutsHelp } from '@/components/shortcuts-help/ShortcutsHelp';
import { CommandPalette } from '@/components/command-palette/CommandPalette';
import { ProposeAtomDialog } from '@/components/propose-atom/ProposeAtomDialog';
import { ControlPanelView } from '@/features/control-panel/ControlPanelView';
import { CanonViewer } from '@/features/canon-viewer/CanonViewer';
import { CanonSuggestionsView } from '@/features/canon-suggestions/CanonSuggestionsView';
import { PrincipalsView } from '@/features/principals-viewer/PrincipalsView';
import { ActivitiesView } from '@/features/activities-viewer/ActivitiesView';
import { PlansView } from '@/features/plans-viewer/PlansView';
import { PlanLifecycleView } from '@/features/plan-lifecycle-viewer/PlanLifecycleView';
import { GraphView } from '@/features/graph-viewer/GraphView';
import { TimelineView } from '@/features/timeline-viewer/TimelineView';
import { MetricsRollupView } from '@/features/metrics-rollup/MetricsRollupView';
import { PageTransition } from '@/components/page-transition/PageTransition';
import { useRoute, type Route } from '@/state/router.store';
import { useThemeStore } from '@/state/theme.store';
import { useDensityStore } from '@/state/density.store';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAtomEvents } from '@/hooks/useAtomEvents';

/**
 * App root. Three responsibilities:
 *   - Mirror theme + density state onto <body> class so CSS
 *     selectors fire. These are the ONLY useEffects that genuinely
 *     are DOM side effects, not data fetches. (Permitted per
 *     directive dev-web-services-over-useeffect.)
 *   - Register global keyboard shortcuts.
 *   - Render the active route inside the AppShell.
 */
export function App() {
  const theme = useThemeStore((s) => s.theme);
  const density = useDensityStore((s) => s.density);
  const route = useRoute();
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('theme-dark', 'theme-light', 'theme-sunset');
    body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('density-comfortable', 'density-compact');
    body.classList.add(`density-${density}`);
  }, [density]);

  useKeyboardShortcuts({
    toggleHelp: () => setHelpOpen((x) => !x),
    openPalette: () => setPaletteOpen(true),
  });

  // Subscribe to the atoms SSE channel once; refetches fire on write.
  useAtomEvents();

  return (
    <>
      <AppShell route={route} onPropose={() => setProposeOpen(true)}>
        <PageTransition key={route}>{renderRoute(route)}</PageTransition>
      </AppShell>
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ProposeAtomDialog open={proposeOpen} onClose={() => setProposeOpen(false)} />
    </>
  );
}

function renderRoute(r: Route) {
  switch (r) {
    case 'dashboard': return <MetricsRollupView />;
    case 'control': return <ControlPanelView />;
    case 'canon': return <CanonViewer />;
    case 'canon-suggestions': return <CanonSuggestionsView />;
    case 'principals': return <PrincipalsView />;
    case 'activities': return <ActivitiesView />;
    case 'plans': return <PlansView />;
    case 'plan-lifecycle': return <PlanLifecycleView />;
    case 'graph': return <GraphView />;
    case 'timeline': return <TimelineView />;
  }
}
