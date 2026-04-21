import { useEffect } from 'react';
import { AppShell } from '@/components/app-shell/AppShell';
import { CanonViewer } from '@/features/canon-viewer/CanonViewer';
import { useThemeStore } from '@/state/theme.store';

/**
 * App root. Responsibilities:
 *   - Mirror theme state onto <body> class so CSS theme selectors
 *     fire. This is the ONE useEffect that genuinely is a DOM side
 *     effect, not a data fetch. (Permitted per canon directive
 *     dev-web-services-over-useeffect.)
 *   - Render the AppShell + the active feature.
 *
 * v1 has a single route/feature (Canon Viewer). Future features
 * (principals, activities, plans) slot into a proper router when we
 * add the second feature.
 */
export function App() {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('theme-dark', 'theme-light');
    body.classList.add(`theme-${theme}`);
  }, [theme]);

  return (
    <AppShell>
      <CanonViewer />
    </AppShell>
  );
}
