import { test, expect } from '@playwright/test';

/**
 * Mobile bottom-nav label fits the constrained tab bar.
 *
 * On iPhone-13-class viewports the sidebar collapses to a fixed
 * bottom-tab row whose tabs are flex:1 and ~37dp wide. The desktop
 * label "Dashboard" overflows this width, so the dashboard tab
 * ships a shorter `mobileLabel` ("Home") that the CSS swaps in
 * below the 48rem media-query breakpoint.
 *
 * This regression guard pins:
 *   - the visible dashboard nav text on mobile is exactly "Home"
 *     (not "Dashboard", not "DashboardHome", which would mean the
 *     desktop span was not hidden)
 *   - the desktop span is still in the DOM (CSS-only toggle, no
 *     JS viewport read), but display:none on mobile
 *   - the chromium project still sees "Dashboard" (the desktop
 *     copy is the source of truth above the breakpoint)
 *
 * Pair with `views.spec.ts` which guards the broader nav contract.
 */

test.describe('mobile nav label', () => {
  test('dashboard tab reads "Home" below the breakpoint', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');
    const tab = page.getByTestId('nav-dashboard');
    await expect(tab).toBeVisible();
    // Visible text is what the operator sees. Playwright's
    // `toHaveText` matches against `textContent`, which includes
    // hidden (display:none) spans; using `innerText` via evaluate
    // is the right primitive for "what's rendered on screen".
    // Poll because the CSS-modules class hash and the visible text
    // both settle after the first paint.
    await expect.poll(
      async () => tab.evaluate((el) => (el as HTMLElement).innerText.trim()),
      { timeout: 5_000 },
    ).toBe('Home');
  });

  test('desktop span remains in the DOM (CSS-only toggle)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');
    const tab = page.getByTestId('nav-dashboard');
    await expect(tab).toBeVisible();
    // The desktop span exists in markup but is display:none on
    // mobile. `innerText` returns visible text only; `textContent`
    // returns markup-order text including hidden spans. The two
    // diverging is the proof the toggle is CSS-driven, not JS.
    const visible = await tab.evaluate((el) => (el as HTMLElement).innerText.trim());
    const inMarkup = await tab.evaluate((el) => el.textContent?.trim() ?? '');
    expect(visible).toBe('Home');
    expect(inMarkup).toContain('Dashboard');
    expect(inMarkup).toContain('Home');
  });

  test('desktop project still shows "Dashboard"', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only assertion');
    await page.goto('/');
    const tab = page.getByTestId('nav-dashboard');
    await expect(tab).toBeVisible();
    // Same `innerText`-vs-`textContent` distinction as the mobile
    // case: above the breakpoint the mobile span is display:none,
    // so visible text is "Dashboard" while textContent would
    // include both copies.
    await expect.poll(
      async () => tab.evaluate((el) => (el as HTMLElement).innerText.trim()),
      { timeout: 5_000 },
    ).toBe('Dashboard');
  });
});
