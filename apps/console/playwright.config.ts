import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SIBLING_MAIN_LAG = resolve(REPO_ROOT, '..', 'memory-governance', '.lag');

const LAG_DIR = process.env.LAG_CONSOLE_LAG_DIR ?? SIBLING_MAIN_LAG;

// Validate explicitly: empty-string env (which docker-compose, CI
// configs, and dotenv files all produce by accident) coerces via
// `Number('') === 0`, after which the test server would bind to an
// OS-assigned random port and silently break the proxy target.
// `Number('abc')` is `NaN` similarly. Fail loud on bad input.
function parsePort(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`playwright.config.ts: ${envName}=${JSON.stringify(raw)} is not a valid port (expected 1-65535)`);
  }
  return n;
}

/*
 * PORT defaults to 9080 (the dashboard's reserved port). In CI and the
 * primary worktree this is the only sane value. When a parallel worktree
 * needs to spin its OWN test server (because port 9080 is held by the
 * primary checkout's dev process), set LAG_CONSOLE_E2E_PORT and the
 * Vite test server adopts that port.
 *
 * BACKEND_PORT is independent. When unset, it defaults to PORT+1 (the
 * convention shared with vite.config.ts and docs/ports.md), but the
 * `+1` rule isn't a hard contract -- two parallel worktrees that pick
 * adjacent dashboard ports (9082 + 9084) would otherwise collide on
 * the same 9083 backend. Setting LAG_CONSOLE_E2E_BACKEND_PORT lets
 * each worktree claim its own backend port without the dashboard
 * port choice locking the backend slot.
 */
const PORT = parsePort('LAG_CONSOLE_E2E_PORT', 9080);
const BACKEND_PORT = parsePort('LAG_CONSOLE_E2E_BACKEND_PORT', PORT + 1);
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
      // When a non-default port is requested (parallel worktree), pass
      // the values through to vite + tsx so both halves bind to the
      // same shifted ports as Playwright is targeting.
      LAG_CONSOLE_PORT: String(PORT),
      LAG_CONSOLE_BACKEND_PORT: String(BACKEND_PORT),
      // The backend's CORS allowlist defaults to 9080 + 127.0.0.1:9080
      // (set in server/security.ts). When PORT shifts, the dashboard
      // origin shifts too; extend the allowlist via the documented env.
      LAG_CONSOLE_ALLOWED_ORIGINS: `http://localhost:${PORT},http://127.0.0.1:${PORT}`,
    },
  },
});
