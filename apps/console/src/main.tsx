import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import './styles/globals.css';

// Demo-mode bundle install. When built with VITE_LAG_TRANSPORT=demo
// (the hosted demo site) we install a pre-baked fictional-org
// dataset on `window` so the StaticBundleTransport has data by the
// time the first TanStack Query fires. The transport resolves the
// bundle lazily on every call, so this install can happen before
// OR after the transport singleton is created.
//
// In non-demo builds this branch is eliminated by Vite's build-time
// constant folding on `import.meta.env.VITE_LAG_TRANSPORT`, so the
// Helix bundle never ships in the real-data artifact.
if (import.meta.env.VITE_LAG_TRANSPORT === 'demo') {
  const { HELIX_BUNDLE } = await import('./demo/helix-bundle');
  window.__LAG_DEMO_BUNDLE__ = HELIX_BUNDLE;
}

// TanStack Query is our primary data-fetching layer so the vast
// majority of components never need useEffect for data. Defaults
// favor freshness over stampede: staleTime 30s (canon atoms change
// rarely), gcTime 5m, refetchOnWindowFocus off to avoid surprise
// requests during a long dashboard session.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('root element missing; index.html must include <div id="root">');
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
