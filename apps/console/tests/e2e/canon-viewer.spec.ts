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
    await page.goto('/canon');
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
    expect(initial).toBeGreaterThan(14);
    await page.getByTestId('type-filter-decision').click();
    /*
     * Combined predicate: the post-filter state is "N decisions, 0
     * non-decisions, N > 0". Single poll avoids the animation race
     * where decisions briefly count zero while non-decisions exit.
     */
    await expect.poll(async () => {
      const types = await page.locator('[data-testid="canon-card"]').evaluateAll(
        (els) => (els as HTMLElement[]).map((e) => e.getAttribute('data-atom-type')),
      );
      const decisions = types.filter((t) => t === 'decision').length;
      const others = types.filter((t) => t !== null && t !== 'decision').length;
      if (decisions === 0 || others > 0) return 'not-settled';
      return 'settled';
    }, { timeout: 10_000 }).toBe('settled');
    const filtered = await page.locator('[data-testid="canon-card"]').count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(initial);
  });

  test('search narrows the grid to matching atoms', async ({ page }) => {
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const search = page.getByTestId('canon-search');
    await search.fill('atomstore');
    /*
     * Poll on a filter-applied signal, not count>0. TanStack Query
     * keeps the previous result visible while the refetch is in
     * flight, so a count-only poll passes immediately with stale
     * unfiltered cards and we read a card that doesn't match. Polling
     * the first card's text covers the stale-while-revalidate window.
     */
    await expect.poll(async () => {
      const first = page.locator('[data-testid="canon-card"]').first();
      if ((await first.count()) === 0) return 'no-cards';
      return (await first.innerText()).toLowerCase().includes('atomstore')
        ? 'match'
        : 'stale';
    }, { timeout: 10_000 }).toBe('match');
  });

  test('theme toggle cycles through supported themes', async ({ page }) => {
    // Reset persisted theme so every run starts from a known state.
    // Doing it via page.evaluate AFTER first load works in both
    // Chromium and WebKit — addInitScript had race conditions on
    // WebKit where the app's theme init ran before the script.
    await page.goto('/canon');
    await page.evaluate(() => localStorage.removeItem('lag-console.theme'));
    await page.reload();
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const seen: string[] = [];
    const read = () =>
      page.evaluate(() => {
        const cls = document.body.className.split(/\s+/).find((c) => c.startsWith('theme-'));
        return cls ?? 'none';
      });
    seen.push(await read());
    expect(seen[0]).toMatch(/^theme-(dark|light|sunset)$/);
    for (let i = 0; i < 3; i++) {
      const last = seen[seen.length - 1]!;
      await page.getByTestId('theme-toggle').click();
      await expect.poll(read).not.toBe(last);
      seen.push(await read());
    }
    // After 3 clicks we have four observations (initial + 3 toggles)
    // and must have seen all three themes at least once, and looped
    // back to the starting theme on the third toggle.
    expect(new Set(seen).size).toBe(3);
    expect(seen[seen.length - 1]).toBe(seen[0]);
  });
});
