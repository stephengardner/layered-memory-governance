import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Reserved ports (see docs/ports.md). Dashboard = 9080 for the
// browser; backend server = 9081. Vite dev proxies /api -> 9081 so
// the browser sees one origin and we keep CORS simple.
const DASHBOARD_PORT = 9080;
const BACKEND_PORT = 9081;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  server: {
    port: DASHBOARD_PORT,
    strictPort: true, // fail fast if port taken instead of hopping
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
