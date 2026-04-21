import { test, expect } from '@playwright/test';

/**
 * Smoke tests across the four top-level views. Each one:
 *   - loads without console errors
 *   - renders the route-specific data (or a well-formed empty state)
 *   - shows the correct sidebar active item
 *
 * Deeper per-view assertions (filter, search, expand) live in
 * view-specific specs; this file guards the cross-view contract.
 */

test.describe('views smoke', () => {
  test('canon renders at least one canon-card', async ({ page }) => {
    await page.goto('/canon');
    await expect(page.locator('[data-testid="canon-card"]').first()).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-canon');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('principals renders at least one principal-card', async ({ page }) => {
    await page.goto('/principals');
    await expect(page.locator('[data-testid="principal-card"]').first()).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-principals');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('activities renders at least one activity-item', async ({ page }) => {
    await page.goto('/activities');
    await expect(page.locator('[data-testid="activity-item"]').first()).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-activities');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('plans renders a plan-card or empty state', async ({ page }) => {
    await page.goto('/plans');
    // Either a plan card or the empty-state hint renders.
    const hasCard = page.locator('[data-testid="plan-card"]').first();
    const empty = page.locator('[data-testid="plans-empty"]');
    await Promise.race([
      hasCard.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);
    const active = page.getByTestId('nav-plans');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('clicking a sidebar item navigates without page reload', async ({ page }) => {
    await page.goto('/canon');
    const before = await page.evaluate(() => performance.now());
    await page.getByTestId('nav-principals').click();
    await expect(page).toHaveURL(/\/principals$/);
    await expect(page.getByTestId('nav-principals')).toHaveAttribute('aria-current', 'page');
    const after = await page.evaluate(() => performance.now());
    // `performance.now()` resets on full page load. If `after < before`
    // we reloaded; if `after > before` we pushState-navigated.
    expect(after).toBeGreaterThan(before);
  });

  test('atom-ref link navigates to /<view>/<id>', async ({ page }) => {
    await page.goto('/canon');
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    // Expand the first card and click an atom-ref chip if any.
    const firstCard = page.locator('[data-testid="canon-card"]').first();
    const expand = firstCard.locator('[data-testid^="card-expand-"]');
    await expand.click();
    const ref = firstCard.locator('[data-testid="atom-ref"]').first();
    const targetId = await ref.getAttribute('data-atom-ref-id');
    const targetRoute = await ref.getAttribute('data-atom-ref-target');
    if (!targetId || !targetRoute) test.skip(true, 'no atom-ref to click');
    await ref.click();
    const escaped = encodeURIComponent(targetId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/${targetRoute}/${escaped}$`));
  });

  test('plan card is clickable → opens in focus mode', async ({ page }) => {
    await page.goto('/plans');
    const firstCard = page.locator('[data-testid="plan-card"]').first();
    await firstCard.waitFor();
    const planId = await firstCard.getAttribute('data-atom-id');
    if (!planId) test.skip(true, 'no plan card to click');
    const link = firstCard.locator('[data-testid="plan-card-link"]');
    await link.click();
    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/plans/${escaped}$`));
    await expect(page.getByTestId('focus-banner')).toBeVisible();
  });

  test('graph view renders nodes from the substrate', async ({ page }) => {
    await page.goto('/graph');
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible();
    await expect.poll(() => page.locator('[data-testid="graph-node"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(10);
  });

  test('kill-switch pill renders in header', async ({ page }) => {
    await page.goto('/canon');
    await expect(page.getByTestId('kill-switch-pill')).toBeVisible();
    const tier = await page.getByTestId('kill-switch-pill').getAttribute('data-tier');
    expect(tier).toMatch(/^(off|soft|medium|hard)$/);
  });

  /*
   * Regression guard for the canon focus flash: when navigating
   * directly to /canon/<id>, the page should never briefly render
   * the unfiltered canon grid. We sample the visible card set on
   * every animation frame for 500ms after navigation and assert
   * that the count never exceeded the search-match cardinality.
   *
   * Earlier this test asserted <= 1 but backend search is a
   * substring filter — any atom whose CONTENT cites the focused
   * id also matches (e.g. "per arch-atomstore-source-of-truth").
   * A handful of legitimate matches is not a flash. 10 is a
   * generous ceiling — the pre-fix flash exceeded 70.
   */
  test('/canon/:id never flashes the unfiltered grid', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const atomId = 'arch-atomstore-source-of-truth';
    await page.goto(`/canon/${atomId}`);
    const samples: number[] = [];
    const end = Date.now() + 500;
    while (Date.now() < end) {
      samples.push(await page.locator('[data-testid="canon-card"]').count());
      await page.waitForTimeout(25);
    }
    const maxSeen = Math.max(...samples, 0);
    expect(maxSeen, `canon focus flashed unfiltered data: saw up to ${maxSeen} cards`).toBeLessThanOrEqual(10);
    await expect(page.locator(`[data-testid="canon-card"][data-atom-id="${atomId}"]`)).toBeVisible();
  });
});
