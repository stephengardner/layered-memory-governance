import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell/AppShell';
import { ShortcutsHelp } from '@/components/shortcuts-help/ShortcutsHelp';
import { CommandPalette } from '@/components/command-palette/CommandPalette';
import { ProposeAtomDialog } from '@/components/propose-atom/ProposeAtomDialog';
import { ControlPanelView } from '@/features/control-panel/ControlPanelView';
import { CanonViewer } from '@/features/canon-viewer/CanonViewer';
import { CanonSuggestionsView } from '@/features/canon-suggestions/CanonSuggestionsView';
import { PrincipalsView } from '@/features/principals-viewer/PrincipalsView';
import { PrincipalTreeView } from '@/features/principal-tree/PrincipalTreeView';
import { ActivitiesView } from '@/features/activities-viewer/ActivitiesView';
import { PlansView } from '@/features/plans-viewer/PlansView';
import { PipelinesView } from '@/features/pipelines-viewer/PipelinesView';
import { PlanLifecycleView } from '@/features/plan-lifecycle-viewer/PlanLifecycleView';
import { DeliberationView } from '@/features/deliberation-trail/DeliberationView';
import { GraphView } from '@/features/graph-viewer/GraphView';
import { TimelineView } from '@/features/timeline-viewer/TimelineView';
import { MetricsRollupView } from '@/features/metrics-rollup/MetricsRollupView';
import { ActorActivityView } from '@/features/actor-activity/ActorActivityView';
import { LiveOpsView } from '@/features/live-ops/LiveOpsView';
import { ResumeAuditView } from '@/features/resume-audit/ResumeAuditView';
import { AtomDetailView } from '@/features/atom-detail-viewer/AtomDetailView';
import { EmptyState } from '@/components/state-display/StateDisplay';
import { PageTransition } from '@/components/page-transition/PageTransition';
import { useRoute, useRouteId, type Route } from '@/state/router.store';
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
  const routeId = useRouteId();
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
        <PageTransition key={route}>{renderRoute(route, routeId)}</PageTransition>
      </AppShell>
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ProposeAtomDialog open={proposeOpen} onClose={() => setProposeOpen(false)} />
    </>
  );
}

function renderRoute(r: Route, id: string | null) {
  switch (r) {
    case 'dashboard': return <MetricsRollupView />;
    case 'control': return <ControlPanelView />;
    case 'live-ops': return <LiveOpsView />;
    case 'canon': return <CanonViewer />;
    case 'canon-suggestions': return <CanonSuggestionsView />;
    case 'principals': return <PrincipalsView />;
    case 'hierarchy': return <PrincipalTreeView />;
    case 'activities': return <ActivitiesView />;
    case 'plans': return <PlansView />;
    case 'pipelines': return <PipelinesView />;
    case 'plan-lifecycle': return <PlanLifecycleView />;
    case 'deliberation': return <DeliberationView />;
    case 'graph': return <GraphView />;
    case 'timeline': return <TimelineView />;
    case 'actor-activity': return <ActorActivityView />;
    case 'resume': return <ResumeAuditView />;
    case 'atom':
      /*
       * The atom-detail viewer requires an id segment. A bare /atom
       * URL with no second segment is recoverable: redirect-empty
       * pattern via an EmptyState that points at the activities feed.
       */
      if (!id) {
        return (
          <EmptyState
            title="Open an atom from another view"
            detail="The atom-detail page renders a single atom by id. Click an atom-ref chip from anywhere in the console to land here."
            testId="atom-detail-empty-id"
          />
        );
      }
      return <AtomDetailView atomId={id} />;
  }
}
