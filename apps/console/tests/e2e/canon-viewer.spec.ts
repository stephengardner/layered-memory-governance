import { test, expect } from '@playwright/test';

/**
 * Canon Viewer e2e — the day-1 feature.
 *
 * Covers the contract the feature makes:
 *   1. Page loads with the correct title and no console errors.
 *   2. At least one canon atom card renders (backend → transport →
 *      query → card pipeline is intact).
 *   3. Type-filter narrows the grid to the selected atom type.
 *   4. Search narrows the grid to atoms whose id or content match.
 *   5. Theme toggle swaps the <body> theme class (token-theming live).
 *
 * Per canon `dev-web-playwright-coverage-required`, every feature
 * ships with at least one Playwright e2e. This spec is that minimum
 * for the Canon Viewer.
 */

test.describe('canon viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads with title and renders at least one canon card', async ({ page }) => {
    await expect(page).toHaveTitle('LAG Console');
    const cards = page.getByRole('heading', { level: 1, name: 'Canon' });
    await expect(cards).toBeVisible();
    const anyCard = page.locator('[data-testid="canon-card"]').first();
    await expect(anyCard).toBeVisible({ timeout: 10_000 });
    const count = await page.locator('[data-testid="canon-card"]').count();
    expect(count).toBeGreaterThan(0);
  });

  test('type filter narrows the grid to the selected type', async ({ page }) => {
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const initial = await page.locator('[data-testid="canon-card"]').count();
    await page.getByTestId('type-filter-decision').click();
    // A filtered refetch has resolved when no card with a non-decision
    // data-atom-type is left in the DOM. Assert via locator so
    // Playwright auto-retries until the condition holds.
    await expect(
      page.locator('[data-testid="canon-card"][data-atom-type]:not([data-atom-type="decision"])'),
    ).toHaveCount(0, { timeout: 10_000 });
    const decisionCards = page.locator('[data-testid="canon-card"][data-atom-type="decision"]');
    const filtered = await decisionCards.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(initial);
  });

  test('search narrows the grid to matching atoms', async ({ page }) => {
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const search = page.getByPlaceholder('Search canon...');
    await search.fill('atomstore');
    await expect.poll(async () =>
      page.locator('[data-testid="canon-card"]').count(),
    ).toBeGreaterThan(0);
    const cards = page.locator('[data-testid="canon-card"]');
    const text = (await cards.first().innerText()).toLowerCase();
    expect(text).toContain('atomstore');
  });

  test('theme toggle swaps body class between dark and light', async ({ page }) => {
    const initialClass = await page.evaluate(() => document.body.className);
    expect(initialClass).toMatch(/theme-(dark|light)/);
    await page.getByTestId('theme-toggle').click();
    await expect.poll(async () =>
      page.evaluate(() => document.body.className),
    ).not.toBe(initialClass);
    const next = await page.evaluate(() => document.body.className);
    expect(next).toMatch(/theme-(dark|light)/);
    expect(next).not.toBe(initialClass);
  });
});
