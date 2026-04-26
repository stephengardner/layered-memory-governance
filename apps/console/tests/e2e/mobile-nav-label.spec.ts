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
 *     (not "Dashboard", not "DashboardHome")
 *   - the dashboard tab in the mobile bottom-bar is rendered by the
 *     dedicated mobile nav (testid `mobile-nav-dashboard`); the
 *     desktop nav (`nav-dashboard`) sits in the same DOM but is
 *     `display:none` below the breakpoint
 *   - the chromium project still sees "Dashboard" in the desktop nav
 *     (the desktop copy is the source of truth above the breakpoint)
 *
 * Pair with `mobile-nav-overflow.spec.ts` for the overflow drawer
 * contract and `views.spec.ts` for the broader nav contract.
 */

test.describe('mobile nav label', () => {
  test('dashboard tab reads "Home" below the breakpoint', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');
    const tab = page.getByTestId('mobile-nav-dashboard');
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

  test('desktop nav coexists in markup (CSS-only toggle)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');
    // The mobile bar is the visible nav at this viewport.
    const mobileTab = page.getByTestId('mobile-nav-dashboard');
    await expect(mobileTab).toBeVisible();
    // The desktop nav still exists in the DOM (proof the toggle is
    // CSS-driven, not a JS viewport read) but is hidden.
    const desktopTab = page.getByTestId('nav-dashboard');
    await expect(desktopTab).toBeAttached();
    await expect(desktopTab).toBeHidden();
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
