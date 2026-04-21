import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SIBLING_MAIN_LAG = resolve(REPO_ROOT, '..', 'memory-governance', '.lag');

const LAG_DIR = process.env.LAG_CONSOLE_LAG_DIR ?? SIBLING_MAIN_LAG;
const PORT = 9080;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    /*
     * Mobile project enforces canon `dev-web-mobile-first-required`.
     * Every spec runs against an iPhone 13 profile so desktop-only
     * assumptions (hidden mobile nav, oversized cards, un-tappable
     * buttons) surface at PR time, not after release.
     */
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      LAG_CONSOLE_LAG_DIR: LAG_DIR,
    },
  },
});
