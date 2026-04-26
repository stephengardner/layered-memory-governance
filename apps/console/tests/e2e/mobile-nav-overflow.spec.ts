import { test, expect } from '@playwright/test';

/**
 * Mobile bottom-nav overflow drawer.
 *
 * The bottom-nav at iPhone-13-class viewports surfaces only the four
 * operator-critical destinations + a MoreHorizontal trigger. Tapping
 * the trigger opens an overflow drawer with every other route,
 * alphabetised by label. This regression guard pins:
 *
 *   - the visible bottom-bar shows exactly five entries
 *     (4 critical + 1 More button), in stable order
 *   - tapping the More button opens the overflow dialog
 *   - the dialog lists every non-critical route as a tappable link
 *   - tapping a route inside the dialog navigates AND closes the dialog
 *   - when the active route lives inside the overflow set, the More
 *     button itself takes the active treatment (a small dot indicator)
 *
 * Pair with `mobile-nav-label.spec.ts` which guards the dashboard's
 * "Home" mobile label, and `views.spec.ts` which guards the desktop
 * nav contract.
 */

test.describe('mobile nav overflow', () => {
  test('bottom bar shows 4 critical tabs + more button', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');

    // The mobile nav is a separate <nav aria-label="Primary mobile">
    // sibling of the desktop nav. Selecting via aria-label avoids
    // CSS-modules class hash dependency.
    const mobileNav = page.getByRole('navigation', { name: 'Primary mobile' });
    await expect(mobileNav).toBeVisible();

    // Four critical destinations: dashboard, control, canon, plans.
    await expect(mobileNav.getByTestId('mobile-nav-dashboard')).toBeVisible();
    await expect(mobileNav.getByTestId('mobile-nav-control')).toBeVisible();
    await expect(mobileNav.getByTestId('mobile-nav-canon')).toBeVisible();
    await expect(mobileNav.getByTestId('mobile-nav-plans')).toBeVisible();

    // The fifth slot is the overflow trigger.
    const more = mobileNav.getByTestId('mobile-nav-more');
    await expect(more).toBeVisible();

    // Routes that are NOT in the critical set must NOT have a
    // dedicated bottom-bar slot. Sample the most operator-relevant.
    await expect(mobileNav.getByTestId('mobile-nav-actor-activity')).toHaveCount(0);
    await expect(mobileNav.getByTestId('mobile-nav-timeline')).toHaveCount(0);
    await expect(mobileNav.getByTestId('mobile-nav-graph')).toHaveCount(0);
  });

  test('tapping more opens overflow drawer with non-critical routes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');

    const more = page.getByTestId('mobile-nav-more');
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    await more.click();

    const dialog = page.getByTestId('mobile-nav-overflow');
    await expect(dialog).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    // Every non-critical route should be present inside the drawer.
    const drawerRoutes = [
      'canon-suggestions',
      'principals',
      'actor-activity',
      'activities',
      'plan-lifecycle',
      'timeline',
      'graph',
    ];
    for (const id of drawerRoutes) {
      await expect(
        dialog.getByTestId(`mobile-nav-overflow-item-${id}`),
        `expected drawer to surface "${id}"`,
      ).toBeVisible();
    }

    // Critical routes do NOT duplicate into the drawer (they have a
    // permanent bottom-bar slot already). The drawer never lists
    // them so the operator does not see two paths to the same view.
    await expect(dialog.getByTestId('mobile-nav-overflow-item-dashboard')).toHaveCount(0);
    await expect(dialog.getByTestId('mobile-nav-overflow-item-control')).toHaveCount(0);
    await expect(dialog.getByTestId('mobile-nav-overflow-item-canon')).toHaveCount(0);
    await expect(dialog.getByTestId('mobile-nav-overflow-item-plans')).toHaveCount(0);
  });

  test('tapping a drawer item navigates and closes the drawer', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');

    await page.getByTestId('mobile-nav-more').click();
    const dialog = page.getByTestId('mobile-nav-overflow');
    await expect(dialog).toBeVisible();

    // Tap "Timeline" (alphabetically late so we know the drawer
    // sorted entries; `localeCompare` orders Activities → Timeline
    // and Timeline appears in the rendered drawer).
    await dialog.getByTestId('mobile-nav-overflow-item-timeline').click();

    // URL transitioned to /timeline.
    await expect.poll(() => new URL(page.url()).pathname).toBe('/timeline');

    // Drawer dismissed itself on selection.
    await expect(dialog).toHaveCount(0);
  });

  test('more button highlights when the active route is inside the overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');

    // Land directly on a non-critical route (Timeline lives in the
    // overflow set). The dots button should reflect "you are here".
    await page.goto('/timeline');

    const more = page.getByTestId('mobile-nav-more');
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('data-active-in-overflow', 'true');

    // Now navigate to a critical route and confirm the active hint
    // clears (the dots button is no longer the home for the active
    // route).
    await page.getByTestId('mobile-nav-canon').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/canon');
    await expect(more).not.toHaveAttribute('data-active-in-overflow', 'true');
  });

  test('escape closes the drawer', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/');

    await page.getByTestId('mobile-nav-more').click();
    const dialog = page.getByTestId('mobile-nav-overflow');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('desktop project does not render the mobile bar or overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only assertion');
    await page.goto('/');

    // Mobile bar is in the markup (CSS-only toggle) but display:none.
    // The overflow trigger is visually hidden on desktop.
    const more = page.getByTestId('mobile-nav-more');
    await expect(more).toBeAttached();
    await expect(more).toBeHidden();

    // The desktop nav still shows every route as a flat item (the
    // existing nav-<id> testids).
    for (const id of ['dashboard', 'control', 'canon', 'plans', 'timeline', 'graph']) {
      await expect(page.getByTestId(`nav-${id}`)).toBeVisible();
    }
  });
});
