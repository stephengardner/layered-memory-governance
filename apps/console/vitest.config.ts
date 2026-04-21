import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * Vitest config. Scoped to unit tests under src/ and server/ — the
 * Playwright e2e specs under tests/e2e/ use @playwright/test which
 * Vitest can't execute. Excluding them here keeps `npm test` fast
 * and focused on pure logic (services, utilities, server helpers).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  test: {
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'server/**/*.{test,spec}.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/e2e/**',
    ],
    environment: 'node',
  },
});
