import { test, expect } from '@playwright/test';

/**
 * Unified-error-state contract for query-backed views.
 *
 * Every console feature that calls useQuery should render the canonical
 * ErrorState (title + monospace error detail) when the backend is
 * unreachable or returns a non-2xx envelope. Earlier, three views
 * (PrincipalActivity, PrincipalSkill, the LiveOps PipelinesTile) shipped
 * bespoke error rendering that drifted from the shared design - flat
 * paragraph text instead of the danger-toned card every other view
 * used. This spec intercepts the named API endpoint, returns 500, and
 * asserts the canonical error UI surfaces with a query-key-aware title.
 *
 * Coverage runs on both chromium and the iPhone 13 mobile project per
 * canon dev-web-mobile-first-required: error states must be legible on
 * a 390px viewport where the centered ErrorState card sits below the
 * focused panel's heading.
 */

test.describe('unified error states across queries', () => {
  test('PrincipalActivity renders ErrorState when actor-activity.stream returns 500', async ({ page }) => {
    /*
     * Fail the actor-activity endpoint that PrincipalActivity calls
     * with the focused principal id. The skill endpoint stays live so
     * we are isolating the activity-panel error path from the skill
     * panel's parallel query. cto-actor is the canonical principal
     * shipped with this repo's fixtures so the focus surface always
     * mounts both panels.
     */
    await page.route('**/api/actor-activity.stream', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'test-injected', message: 'simulated activity stream failure' } }),
      });
    });

    await page.goto('/principals/cto-actor');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });

    const errorPanel = page.getByTestId('principal-activity-error');
    const errorState = page.getByTestId('principal-activity-error-state');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorState).toBeVisible();
    /*
     * Assert the canonical ErrorState surface - the title is
     * query-key-aware (NOT a generic "Error") and the error code
     * surfaces in the monospace detail strip so an operator can copy
     * it for triage.
     */
    await expect(errorState).toContainText('Failed to load activity');
    await expect(errorState).toContainText('test-injected');
  });

  test('PrincipalSkill renders ErrorState when principals.skill returns 500', async ({ page }) => {
    /*
     * Fail the skill endpoint exclusively. Activity stays live so this
     * test isolates the skill panel's error path. The route matcher
     * intentionally targets the named method to avoid blocking other
     * principal-related calls (principals.list, principals.stats).
     */
    await page.route('**/api/principals.skill', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'test-injected', message: 'simulated skill failure' } }),
      });
    });

    await page.goto('/principals/cto-actor');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });

    const errorPanel = page.getByTestId('principal-skill-error');
    const errorState = page.getByTestId('principal-skill-error-state');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorState).toBeVisible();
    await expect(errorState).toContainText('Failed to load skill content');
    await expect(errorState).toContainText('test-injected');
  });

  test('LiveOps PipelinesTile renders ErrorState when pipelines.live-ops returns 500', async ({ page }) => {
    /*
     * The LiveOps view runs a live-ops.snapshot query for the page
     * shell AND a separate pipelines.live-ops query for the in-flight
     * pipelines tile. Fail only the pipelines call so the rest of the
     * Pulse dashboard renders normally and we isolate the tile-level
     * error path.
     */
    await page.route('**/api/pipelines.live-ops', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'test-injected', message: 'simulated pipelines failure' } }),
      });
    });

    await page.goto('/');
    /*
     * Wait for the LiveOps shell to mount before asserting the tile.
     * The pulse heartbeat tile is the most reliable mount signal
     * because it surfaces on a fast 2s cadence regardless of fixture
     * shape.
     */
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    const errorState = page.getByTestId('live-ops-pipelines-error');
    await expect(errorState).toBeVisible({ timeout: 10_000 });
    /*
     * The canonical ErrorState carries the query-key-aware title
     * "Failed to load pipelines" (not the bespoke flat
     * "Could not load pipelines snapshot." paragraph that shipped
     * before the audit). The error code surfaces in the monospace
     * detail strip.
     */
    await expect(errorState).toContainText('Failed to load pipelines');
    await expect(errorState).toContainText('test-injected');
  });
});
