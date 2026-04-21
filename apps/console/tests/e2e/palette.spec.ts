import { test, expect } from '@playwright/test';

/*
 * Cmd+K is a desktop-keyboard interaction. Mobile users would invoke
 * a command palette via a button/FAB (future work), not a shortcut —
 * so these specs skip on the mobile project.
 */
test.describe('command palette', () => {
  test.skip(({ isMobile }) => isMobile, 'palette is keyboard-shortcut-only; mobile invocation TBD');

  test('Cmd+K opens palette, typing filters, Enter navigates', async ({ page }) => {
    await page.goto('/canon');
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('command-input')).toBeFocused();
    // Filter: arch-atomstore matches a single canon atom.
    await page.getByTestId('command-input').fill('arch-atomstore');
    await expect.poll(() => page.getByTestId('command-item').first().getAttribute('data-entry-id'))
      .toBe('canon:arch-atomstore-source-of-truth');
    // Enter navigates, closes palette.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/canon\/arch-atomstore-source-of-truth$/);
    await expect(page.getByTestId('command-palette')).toBeHidden();
  });

  test('Escape closes palette without navigating', async ({ page }) => {
    await page.goto('/canon');
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    const beforeUrl = page.url();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();
    expect(page.url()).toBe(beforeUrl);
  });

  test('Arrow keys move cursor, item click navigates', async ({ page }) => {
    await page.goto('/canon');
    await page.keyboard.press('Control+k');
    await page.getByTestId('command-input').fill('arch-');
    await expect(page.getByTestId('command-item').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    // Second-down result.
    const items = page.getByTestId('command-item');
    const target = items.nth(2);
    const targetId = await target.getAttribute('data-entry-id');
    await target.click();
    await expect(page.getByTestId('command-palette')).toBeHidden();
    expect(targetId).toMatch(/^canon:/);
  });
});
