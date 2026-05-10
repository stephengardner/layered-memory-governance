import { test, expect } from '@playwright/test';

/**
 * Pulse pipeline-state tile e2e.
 *
 * Coverage:
 *   - The tile renders on /live-ops with three bucket counts visible:
 *     running, dispatched-pending-merge, intent-fulfilled.
 *   - Each bucket count is a number (never undefined, never NaN).
 *   - Clicking the Running bucket header navigates to /pipelines with
 *     the `state=running` query param so the existing filter chip-row
 *     reflects the bucket the operator just clicked.
 *   - Page renders cleanly on the mobile project (390x844) so the
 *     canonical mobile-first floor is exercised; the touch targets on
 *     the bucket headers measure >= 44x44 CSS pixels.
 *
 * These tests run against the live atom store. An empty store still
 * paints the tile with zero counts; a populated store paints non-zero
 * counts. Both are valid; assert on the structure, not the magnitude.
 */

test.describe('pulse pipeline-state tile', () => {
  test('tile renders three bucket counts on the Pulse dashboard', async ({ page }) => {
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    const tile = page.getByTestId('pulse-pipeline-tile');
    await expect(tile).toBeVisible({ timeout: 10_000 });

    // Three buckets, each with a count + label visible.
    const running = page.getByTestId('pulse-pipeline-tile-running');
    const pending = page.getByTestId('pulse-pipeline-tile-pending-merge');
    const fulfilled = page.getByTestId('pulse-pipeline-tile-fulfilled');
    await expect(running).toBeVisible();
    await expect(pending).toBeVisible();
    await expect(fulfilled).toBeVisible();

    /*
     * Each count is a numeric string. A "0" is acceptable when the store
     * carries no matching pipelines; a missing count would surface as
     * empty text which the regex below rejects.
     */
    const runningCount = await page.getByTestId('pulse-pipeline-tile-running-count').innerText();
    const pendingCount = await page.getByTestId('pulse-pipeline-tile-pending-merge-count').innerText();
    const fulfilledCount = await page.getByTestId('pulse-pipeline-tile-fulfilled-count').innerText();
    expect(runningCount.trim()).toMatch(/^\d+$/);
    expect(pendingCount.trim()).toMatch(/^\d+$/);
    expect(fulfilledCount.trim()).toMatch(/^\d+$/);
  });

  test('clicking the Running bucket header navigates to /pipelines?state=running', async ({ page }) => {
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    const runningHeader = page.getByTestId('pulse-pipeline-tile-running-header');
    await expect(runningHeader).toBeVisible({ timeout: 10_000 });
    await runningHeader.click();

    /*
     * After the click the URL should reflect /pipelines and the
     * `state=running` filter so the existing chip-row pre-selects the
     * Running chip. The pipelines view itself reads the same
     * PIPELINE_FILTER_QUERY_KEY ('state') as the chip-row.
     */
    await expect(page).toHaveURL(/\/pipelines(\?.*)?$/);
    await expect(page).toHaveURL(/state=running/);
  });

  test('bucket header is at least 44x44 CSS pixels (mobile-first touch target floor)', async ({ page }) => {
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    const header = page.getByTestId('pulse-pipeline-tile-running-header');
    await expect(header).toBeVisible({ timeout: 10_000 });
    const box = await header.boundingBox();
    expect(box, 'bucket header should have a layout box').toBeTruthy();
    // Per canon `dev-mobile-first-floor`, every touch target meets the
    // 44x44 CSS-pixel minimum. The tile is a primary mobile entry point
    // to /pipelines so this constraint applies to the bucket header.
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
