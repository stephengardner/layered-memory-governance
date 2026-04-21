import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import './styles/globals.css';

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
