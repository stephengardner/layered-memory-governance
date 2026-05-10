import { test, expect } from '@playwright/test';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAPED_TOGGLE_STORAGE_KEY } from '../../src/features/activities-viewer/reapedToggle';

/**
 * Reaped-atoms toggle e2e (canon `dev-mobile-first-floor` runs both
 * desktop AND mobile via the playwright config's two projects).
 *
 * Operator concern: the pipeline reaper (PR #377) marks stale
 * pipeline / pipeline-stage / agent-session / agent-turn atoms with
 * `metadata.reaped_at`. The activities feed defaults to HIDING those
 * atoms so the timeline reflects live work, with a "Show reaped (N)"
 * toggle for the audit case. Provenance navigation MUST still resolve
 * reaped atoms even when they are hidden from the feed (the filter
 * is projection-layer, not substrate-layer).
 *
 * What this test asserts:
 *   1. The toggle button renders with `aria-pressed="false"` by
 *      default and reads "Show reaped" with the count from the
 *      server's `reaped_count` field.
 *   2. The seeded reaped atom is absent from the feed by default.
 *   3. Clicking the toggle flips it to `aria-pressed="true"`,
 *      relabels to "Hide reaped", and the seeded reaped atom now
 *      appears with a `reaped` badge.
 *   4. The toggle state persists across reloads (storage.service
 *      round-trip).
 *   5. /api/atoms.get still resolves the seeded reaped atom by id
 *      (the projection-layer filter does NOT block single-atom
 *      reads, preserving derived_from navigation).
 *
 * The seed atom is written directly to the LAG dir via fs.writeFile
 * so the test does not depend on a live reaper run. The filename
 * uses a unique nonce per run so a parallel-run collision is
 * impossible. afterAll deletes the seed regardless of outcome.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_CONSOLE = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(APPS_CONSOLE, '..', '..');
const DEFAULT_LAG = resolve(REPO_ROOT, '.lag');
const LAG_DIR = process.env['LAG_CONSOLE_LAG_DIR'] ?? DEFAULT_LAG;
const ATOMS_DIR = resolve(LAG_DIR, 'atoms');

const NONCE = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SEED_ID = `pipeline-cto-reaped-toggle-${NONCE}`;
const SEED_FILE = resolve(ATOMS_DIR, `${SEED_ID}.json`);

const SEED_REAPED_AT = '2026-05-09T12:00:00.000Z';

/*
 * Mirrors the substrate's pipeline-reaper output shape: the leaf
 * write is `metadata.reaped_at` + `metadata.reaped_reason`, plus a
 * confidence floor (0.01) so arbitration deprioritizes reaped atoms.
 * The atom otherwise looks like any other terminal-state pipeline
 * atom -- created_at recent enough to land inside the 20000-atom
 * activities slice; pipeline_state="completed" so the reaper's
 * `terminal-pipeline-ttl` reason is plausible.
 */
const SEED_REAPED_ATOM = {
  schema_version: 1,
  id: SEED_ID,
  content: `e2e seed: terminal pipeline atom marked reaped at ${SEED_REAPED_AT}`,
  type: 'pipeline',
  layer: 'L1',
  provenance: {
    kind: 'agent-observed',
    source: { tool: 'e2e-seed', agent_id: 'cto-actor' },
    derived_from: [],
  },
  confidence: 0.01,
  created_at: new Date().toISOString(),
  last_reinforced_at: new Date().toISOString(),
  expires_at: null,
  supersedes: [],
  superseded_by: [],
  scope: 'project',
  signals: {
    agrees_with: [],
    conflicts_with: [],
    validation_status: 'unchecked',
    last_validated_at: null,
  },
  principal_id: 'cto-actor',
  taint: 'clean',
  pipeline_state: 'completed',
  metadata: {
    pipeline_id: SEED_ID,
    reaped_at: SEED_REAPED_AT,
    reaped_reason: 'terminal-pipeline-ttl',
    completed_at: '2026-04-08T12:00:00.000Z',
  },
};

const STORAGE_KEY = `lag-console.${REAPED_TOGGLE_STORAGE_KEY}`;

test.describe('activities-feed reaped toggle', () => {
  test.beforeAll(async () => {
    await mkdir(ATOMS_DIR, { recursive: true });
    await writeFile(SEED_FILE, JSON.stringify(SEED_REAPED_ATOM, null, 2), 'utf8');
  });

  test.afterAll(async () => {
    try { await unlink(SEED_FILE); } catch { /* already gone */ }
  });

  test('hides reaped by default; toggle reveals + persists; provenance still resolves', async ({
    page,
    request,
  }) => {
    /*
     * Wait for the file watcher to pick up the seeded atom. The
     * server primes its index on startup and watches for changes;
     * a deterministic round-trip is to poll /api/activities.list
     * until the seed appears in the include_reaped variant. This
     * also serves as the wire-shape probe.
     */
    let reapedCount = 0;
    let seedVisible = false;
    for (let i = 0; i < 20 && !seedVisible; i++) {
      const probe = await request.post('/api/activities.list', {
        data: { limit: 20000, include_reaped: true },
      });
      if (probe.ok()) {
        const body = await probe.json();
        const data = body?.data;
        const atoms: ReadonlyArray<{ id: string }> = data?.atoms ?? [];
        seedVisible = atoms.some((a) => a.id === SEED_ID);
        reapedCount = data?.reaped_count ?? 0;
      }
      if (!seedVisible) await page.waitForTimeout(250);
    }
    expect(seedVisible, `seed atom ${SEED_ID} should appear in include_reaped:true`).toBe(true);
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    /*
     * Sanity: the default-hide variant returns the same reaped_count
     * but excludes the seed atom from the visible list.
     */
    const hiddenResponse = await request.post('/api/activities.list', {
      data: { limit: 20000 },
    });
    expect(hiddenResponse.ok()).toBe(true);
    const hiddenBody = await hiddenResponse.json();
    const hiddenData = hiddenBody?.data;
    expect(hiddenData?.reaped_count).toBe(reapedCount);
    const hiddenIds: ReadonlyArray<string> = (hiddenData?.atoms ?? []).map(
      (a: { id: string }) => a.id,
    );
    expect(hiddenIds).not.toContain(SEED_ID);

    /*
     * Clear any persisted toggle so the test starts from a true
     * fresh-load. localStorage outlives reloads and would otherwise
     * leak state from a prior dev session.
     */
    await page.goto('/activities');
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
    await page.reload();

    const toggle = page.getByTestId('activities-reaped-toggle');
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Default state: aria-pressed=false, label = "Show reaped".
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toContainText('Show reaped');

    const count = page.getByTestId('activities-reaped-count');
    await expect(count).toHaveText(String(reapedCount));

    // Seed atom is NOT visible by default.
    await expect(page.locator(`[data-atom-id="${SEED_ID}"]`)).toHaveCount(0);

    // No reaped badge anywhere (the items rendered are all live).
    await expect(page.getByTestId('activity-item-reaped-badge')).toHaveCount(0);

    // Click toggle -> aria-pressed=true, label flips, seed atom appears.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toContainText('Hide reaped');

    const seedItem = page.locator(`[data-atom-id="${SEED_ID}"]`);
    await expect(seedItem).toBeVisible();
    await expect(seedItem).toHaveAttribute('data-reaped', 'true');
    await expect(seedItem.getByTestId('activity-item-reaped-badge')).toBeVisible();

    /*
     * Persistence: toggle state survives a page reload. The
     * aria-pressed=true assertion after reload exercises the
     * storage.service round-trip end-to-end.
     */
    await page.reload();
    await expect(page.getByTestId('activities-reaped-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Seed still visible after reload (toggle persisted ON).
    await expect(page.locator(`[data-atom-id="${SEED_ID}"]`)).toBeVisible();

    /*
     * Provenance navigation: /api/atoms.get must still resolve the
     * reaped seed by id. The projection-layer default-hide MUST
     * NOT block single-atom reads; otherwise a `derived_from` link
     * from a live atom to a reaped ancestor would 404 in the audit
     * chain.
     */
    const detailResponse = await request.post('/api/atoms.get', {
      data: { id: SEED_ID },
    });
    expect(
      detailResponse.ok(),
      'atoms.get must resolve reaped atoms even when the activities feed hides them',
    ).toBe(true);
    const detailBody = await detailResponse.json();
    expect(detailBody?.data?.id).toBe(SEED_ID);
    expect(detailBody?.data?.metadata?.reaped_at).toBe(SEED_REAPED_AT);
  });
});
