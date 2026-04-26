import { test, expect } from '@playwright/test';

/**
 * Metrics rollup e2e: the conference-demo dashboard panel.
 *
 * Coverage:
 *   - `/` lands on the dashboard view (route default), with the active
 *     sidebar item.
 *   - Hero numbers (succeeded / failed / dispatched) are rendered and
 *     at least one of the autonomous-loop counts is non-zero against
 *     the live store (we have 4 succeeded plans).
 *   - Window picker renders and the "30d" toggle changes the active
 *     button without crashing the view.
 *   - Recent failures list is present and clicking a row navigates to
 *     `/plan-lifecycle/<plan-id>`.
 */

test.describe('metrics rollup', () => {
  test('/ lands on dashboard with hero numbers visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('metrics-rollup-view')).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-dashboard');
    await expect(active).toHaveAttribute('aria-current', 'page');

    // All three hero cards land.
    await expect(page.getByTestId('metrics-hero-succeeded')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('metrics-hero-failed')).toBeVisible();
    await expect(page.getByTestId('metrics-hero-dispatched')).toBeVisible();
  });

  test('autonomous-loop has at least one non-zero number against the live store', async ({ page }) => {
    /*
     * 30d window so the historical plan-merge-settled atoms (older
     * than 24h) count toward the metrics. Production fixture has 4
     * settled plans and ~10 dispatch failures; at least one of those
     * three numbers must be > 0.
     */
    await page.goto('/');
    await expect(page.getByTestId('metrics-rollup-view')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('metrics-window-30d').click();

    // Wait for the new query to settle.
    await expect(page.getByTestId('metrics-window-30d')).toHaveAttribute('aria-pressed', 'true');

    const succeededText = await page.getByTestId('metrics-hero-succeeded-value').innerText();
    const failedText = await page.getByTestId('metrics-hero-failed-value').innerText();
    const dispatchedText = await page.getByTestId('metrics-hero-dispatched-value').innerText();

    const total = Number.parseInt(succeededText, 10)
      + Number.parseInt(failedText, 10)
      + Number.parseInt(dispatchedText, 10);
    expect(total, 'at least one autonomous-loop count should be non-zero against the live store')
      .toBeGreaterThan(0);
  });

  test('window picker toggles update the metrics view', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('metrics-rollup-view')).toBeVisible({ timeout: 10_000 });

    // 24h is the default; click 7d, then 30d, and assert the
    // aria-pressed state follows along (a re-fetch is implied).
    await page.getByTestId('metrics-window-7d').click();
    await expect(page.getByTestId('metrics-window-7d')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('metrics-window-24h')).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('metrics-window-30d').click();
    await expect(page.getByTestId('metrics-window-30d')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('metrics-window-7d')).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking a recent-failure row navigates to plan-lifecycle', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('metrics-rollup-view')).toBeVisible({ timeout: 10_000 });

    /*
     * Recent-failures section may be empty in a clean store; this
     * test asserts the navigation contract WHEN failures exist.
     * Production fixture has multiple failures so the row is present.
     */
    const list = page.getByTestId('metrics-failures-list');
    const empty = page.getByTestId('metrics-failures-empty');
    await Promise.race([
      list.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);

    test.skip(
      await empty.isVisible(),
      'no failures in atom store; failure-row navigation cannot be exercised',
    );

    const firstRow = page.locator('[data-testid="metrics-failure-row"]').first();
    await expect(firstRow).toBeVisible();
    const planId = await firstRow.getAttribute('data-plan-id');
    expect(planId, 'failure row should expose data-plan-id').toBeTruthy();

    const link = firstRow.locator('a').first();
    await link.click();
    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/plan-lifecycle/${escaped}$`));
  });
});
