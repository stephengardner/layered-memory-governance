import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * Vitest config. Deliberately scoped to unit tests in src/ — the
 * Playwright e2e specs under tests/e2e/ use @playwright/test which
 * Vitest can't execute. Excluding them here keeps `npm test` fast
 * and focused on pure logic (services, utilities, pure components).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/e2e/**',
    ],
    environment: 'node',
  },
});
