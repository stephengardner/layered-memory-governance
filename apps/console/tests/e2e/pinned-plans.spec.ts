import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'lag-pinned-plans';

test.describe('Pinned plans persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }, STORAGE_KEY);
  });

  test('pin, persist across reload, then unpin', async ({ page }) => {
    await page.goto('/plans');

    const pinnedRow = page.getByTestId('pinned-plans-row');
    await expect(pinnedRow).toHaveCount(0);

    const firstCard = page.getByTestId('plan-card').first();
    const planId = await firstCard.getAttribute('data-plan-atom-id');
    expect(planId).toBeTruthy();

    const pinButton = firstCard.getByRole('button', { name: /^Pin plan / });
    await pinButton.click();

    await expect(page.getByTestId('pinned-plans-row')).toBeVisible();
    const pinnedCard = page
      .getByTestId('pinned-plans-grid')
      .locator(`[data-pinned-card-id="${planId}"]`);
    await expect(pinnedCard).toBeVisible();
    await expect(
      pinnedCard.getByRole('button', { name: new RegExp(`^Unpin plan `) }),
    ).toHaveAttribute('aria-pressed', 'true');

    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    expect(stored && JSON.parse(stored)).toContain(planId);

    await page.reload();
    await expect(
      page
        .getByTestId('pinned-plans-grid')
        .locator(`[data-pinned-card-id="${planId}"]`),
    ).toBeVisible();

    const unpinButton = page
      .getByTestId('pinned-plans-grid')
      .locator(`[data-pinned-card-id="${planId}"]`)
      .getByRole('button', { name: /^Unpin plan / });
    await unpinButton.click();

    await expect(page.getByTestId('pinned-plans-row')).toHaveCount(0);

    const storedAfter = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    const parsed = storedAfter ? JSON.parse(storedAfter) : [];
    expect(parsed).not.toContain(planId);
  });
});
