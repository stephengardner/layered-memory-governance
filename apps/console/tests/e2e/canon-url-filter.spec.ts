import { test, expect } from '@playwright/test';

/**
 * Canon URL-state filter e2e.
 *
 * Operator-flagged 2026-04-26: 'should i be able to quickly see
 * specifically canons by level? right now there's no filter, and
 * filtering should be a proper url state.'
 *
 * The CanonViewer already had type chips (Directives/Decisions/
 * Preferences/References + All) but they used `useState` only - the
 * filter didn't survive refresh and wasn't shareable as a deep link.
 * Now the filter writes to the URL query (?type=directive). The URL
 * is the source of truth: a refresh keeps the filter, a back/forward
 * round-trips the chip state, and a copy-pasted URL preserves it.
 *
 * Coverage:
 *   1. Click a chip -> URL grows ?type=<id>.
 *   2. Reload the page on /canon?type=directive -> chip stays
 *      selected and the rendered list is filtered.
 *   3. Click 'All' -> URL clears the ?type param (no `?type=all`
 *      noise on the default view).
 *   4. Invalid ?type value falls back to All gracefully.
 */

test.describe('canon URL-state filter', () => {
  test('clicking a chip writes the filter to the URL query', async ({ page }) => {
    await page.goto('/canon');
    const directiveChip = page.locator('[data-testid="type-filter-directive"]');
    await expect(directiveChip).toBeVisible({ timeout: 10_000 });
    await directiveChip.click();
    await expect(page).toHaveURL(/\/canon\?(?:.*&)?type=directive/);
    await expect(directiveChip).toHaveAttribute('aria-selected', 'true');
  });

  test('filter survives reload (URL is the source of truth)', async ({ page }) => {
    await page.goto('/canon?type=decision');
    const decisionChip = page.locator('[data-testid="type-filter-decision"]');
    await expect(decisionChip).toBeVisible({ timeout: 10_000 });
    await expect(decisionChip).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(decisionChip).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking All clears the ?type param', async ({ page }) => {
    await page.goto('/canon?type=preference');
    const allChip = page.locator('[data-testid="type-filter-all"]');
    await allChip.click();
    /*
     * URL should be /canon (no query string) - 'all' is the default
     * and writes a clean URL rather than ?type=all.
     */
    await expect(page).toHaveURL(/\/canon$/);
    await expect(allChip).toHaveAttribute('aria-selected', 'true');
  });

  test('invalid ?type value falls back to All', async ({ page }) => {
    await page.goto('/canon?type=this-is-not-a-real-filter');
    const allChip = page.locator('[data-testid="type-filter-all"]');
    await expect(allChip).toBeVisible({ timeout: 10_000 });
    await expect(allChip).toHaveAttribute('aria-selected', 'true');
  });
});
