import { test, expect } from '@playwright/test';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Canon suggestions e2e: verifies the read-only inbox panel renders
 * pending agent-suggested canon atoms and produces a copy-to-clipboard
 * CLI command for each triage action. The console NEVER mutates these
 * atoms — clicking Promote/Dismiss/Defer copies the
 * `scripts/canon-suggest-triage.mjs` invocation; the operator runs it.
 *
 * The seed atom is written directly to the LAG dir via fs.writeFile so
 * the test does not depend on `dist/` being built at e2e time. The
 * filename uses a unique nonce per run so a parallel-run collision is
 * impossible. afterAll deletes the seed regardless of outcome.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_CONSOLE = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(APPS_CONSOLE, '..', '..');
// Default to the repo's own `.lag` dir so this test runs anywhere this
// substrate lands: fork, CI, sibling worktree, fresh checkout. The
// `LAG_CONSOLE_LAG_DIR` env var overrides for environments that point
// the console at a different state directory (the dev-mode loopback).
const DEFAULT_LAG = resolve(REPO_ROOT, '.lag');
const LAG_DIR = process.env['LAG_CONSOLE_LAG_DIR'] ?? DEFAULT_LAG;
const ATOMS_DIR = resolve(LAG_DIR, 'atoms');

const NONCE = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SEED_ID = `canon-suggestion-dev-e2e-canon-scout-${NONCE}`;
const SEED_FILE = resolve(ATOMS_DIR, `${SEED_ID}.json`);
const SEED_SUGGESTED_ID = `dev-e2e-canon-scout-${NONCE}`;

const SEED_ATOM = {
  schema_version: 1,
  id: SEED_ID,
  content: `[suggestion] directive ${SEED_SUGGESTED_ID}: e2e seed for the canon-suggestions panel.`,
  type: 'observation',
  layer: 'L1',
  provenance: {
    kind: 'agent-observed',
    source: { agent_id: 'canon-scout-stub', tool: 'canon-scout' },
    derived_from: [],
  },
  confidence: 0.7,
  created_at: new Date().toISOString(),
  last_reinforced_at: new Date().toISOString(),
  expires_at: null,
  supersedes: [],
  superseded_by: [],
  scope: 'project',
  signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
  principal_id: 'canon-scout-stub',
  taint: 'clean',
  metadata: {
    kind: 'canon-proposal-suggestion',
    suggested_id: SEED_SUGGESTED_ID,
    suggested_type: 'directive',
    proposed_content: 'When the operator emphasizes X with high confidence multiple times, the canon scout should propose a directive capturing X verbatim.',
    chat_excerpt: 'operator: I keep saying this and agents keep missing it',
    confidence: 0.7,
    review_state: 'pending',
  },
};

test.describe('canon suggestions panel', () => {
  test.beforeAll(async () => {
    // On a fresh checkout (or a `LAG_CONSOLE_LAG_DIR` pointing at an
    // uninitialized path), `writeFile` would ENOENT before the suite
    // could run. Creating the atoms dir up-front makes the e2e
    // self-contained per the new in-repo `.lag` default.
    await mkdir(ATOMS_DIR, { recursive: true });
    await writeFile(SEED_FILE, JSON.stringify(SEED_ATOM, null, 2), 'utf8');
  });

  test.afterAll(async () => {
    try { await unlink(SEED_FILE); } catch { /* file may already be gone */ }
  });

  test('navigates to /canon-suggestions and renders the seeded suggestion', async ({ page }) => {
    await page.goto('/canon-suggestions');
    const card = page.locator(`[data-testid="canon-suggestion-card"][data-atom-id="${SEED_ID}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId('canon-suggestion-id')).toHaveText(SEED_SUGGESTED_ID);
    // The chat excerpt is rendered verbatim so the operator sees what triggered it.
    await expect(card).toContainText('operator: I keep saying this');
    // Sidebar nav is active for the new route.
    await expect(page.getByTestId('nav-canon-suggestions')).toHaveAttribute('aria-current', 'page');
  });

  test('clicking Defer copies the triage CLI command to clipboard', async ({ page, context, browserName }) => {
    // Clipboard read permission has different rules per browser; Firefox
    // throws on the read regardless. The card itself also renders the
    // command in a `pre` element with user-select:all, which we assert
    // on directly so the test still proves the command shape regardless
    // of clipboard availability.
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await page.goto('/canon-suggestions');
    const card = page.locator(`[data-testid="canon-suggestion-card"][data-atom-id="${SEED_ID}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Visible CLI hint — the always-on copy-paste fallback.
    const hint = card.getByTestId('canon-suggestion-cli-hint');
    await expect(hint).toContainText(`canon-suggest-triage.mjs --atom-id ${SEED_ID} --action promote`);

    // Click Defer; the hint updates AND clipboard (when available) carries the command.
    await card.getByTestId('canon-suggestion-defer').click();
    await expect(hint).toContainText(`canon-suggest-triage.mjs --atom-id ${SEED_ID} --action defer`);

    if (browserName === 'chromium') {
      const clipText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipText).toContain(`canon-suggest-triage.mjs --atom-id ${SEED_ID} --action defer`);
    }
  });

  test('switching tabs filters the list — no seeded promoted suggestion exists', async ({ page }) => {
    await page.goto('/canon-suggestions');
    await expect(page.locator(`[data-testid="canon-suggestion-card"][data-atom-id="${SEED_ID}"]`)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('canon-suggestions-tab-promoted').click();
    /*
     * Either the seed is missing (it's pending, not promoted) — empty
     * state shows — OR the panel lists previously-promoted suggestions
     * which DON'T include our pending seed atom_id. Both pass the
     * filter contract.
     */
    await expect.poll(async () => {
      const our = await page.locator(`[data-testid="canon-suggestion-card"][data-atom-id="${SEED_ID}"]`).count();
      return our;
    }, { timeout: 5_000 }).toBe(0);
  });
});
