import { test, expect } from '@playwright/test';
import { skipUnlessMobile } from './_lib/mobile';

/**
 * Mobile-first assertions for the principal-detail surface.
 *
 * Companion to plans-mobile.spec.ts and canon-mobile.spec.ts: same
 * canon discipline (`dev-web-mobile-first-required`), different
 * surface. The principal focus mode renders a PrincipalCard +
 * PrincipalSkill + PrincipalActivity stack under a FocusBanner; on
 * a 390px viewport the contract is a single column, no horizontal
 * scroll, and 44 CSS-pixel tap targets on the controls an operator
 * actually touches.
 *
 * Helpers come from tests/e2e/_lib/mobile.ts (extracted at N=3 in
 * the canon-mobile PR per canon `dev-extract-at-n-equals-2`). This
 * spec uses skipUnlessMobile from there; the principal id
 * (cto-actor) is hardcoded because the principal store always ships
 * with cto-actor in this repo's fixtures.
 */

test.describe('principal-detail mobile surface', () => {
  test.beforeEach(async ({ page }) => {
    /*
     * cto-actor is the canonical principal that ships with both a
     * SKILL.md and ample plan history. The mobile spec uses the same
     * fixture as the desktop principal-drilldown spec so the two
     * bodies of evidence stay aligned.
     */
    await page.goto('/principals/cto-actor');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });
  });

  test('renders FocusBanner + card + skill + activity panels in single column', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * Each panel must be present. The skill / activity panels each
     * have three states (loading / content / empty); the OR locator
     * accepts any non-error terminal state so a fresh-install fixture
     * (no skill md, no activity) doesn't false-fail the test.
     */
    await expect(page.getByTestId('focus-banner')).toBeVisible();
    await expect(page.getByTestId('principal-card')).toHaveCount(1);

    const skillContent = page.getByTestId('principal-skill-content');
    const skillEmpty = page.getByTestId('principal-skill-empty');
    await expect(skillContent.or(skillEmpty)).toBeVisible({ timeout: 10_000 });

    const activityContent = page.getByTestId('principal-activity-content');
    const activityEmpty = page.getByTestId('principal-activity-empty');
    await expect(activityContent.or(activityEmpty)).toBeVisible({ timeout: 15_000 });

    /*
     * Single-column assertion: at 390px the principal panels MUST
     * stack vertically AND share a column. Top-edge ordering
     * (card -> skill -> activity y values strictly increase) proves
     * vertical sequence, and center-x equality within plus-or-minus
     * 2px proves they share the same column rather than rendering
     * as separate columns that happen to be ordered top-to-bottom.
     * The card may render in any of the focus-mode load states, so
     * we resolve which of skill/activity surfaced (content vs empty)
     * before measuring.
     */
    const card = page.getByTestId('principal-card');
    const skill = (await skillContent.count()) > 0 ? skillContent : skillEmpty;
    const activity = (await activityContent.count()) > 0 ? activityContent : activityEmpty;
    const cardBox = await card.boundingBox();
    const skillBox = await skill.boundingBox();
    const activityBox = await activity.boundingBox();
    expect(cardBox, 'card must be in the layout flow').not.toBeNull();
    expect(skillBox, 'skill panel must be in the layout flow').not.toBeNull();
    expect(activityBox, 'activity panel must be in the layout flow').not.toBeNull();
    /*
     * Stacking assertion: each subsequent panel's top edge must be
     * at or below the previous panel's BOTTOM edge. Top-edge-only
     * ordering allows overlapping panels to pass; the bottom-edge
     * comparison rules that out.
     */
    expect(skillBox!.y, 'skill panel must stack below card bottom').toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height);
    expect(activityBox!.y, 'activity panel must stack below skill bottom').toBeGreaterThanOrEqual(skillBox!.y + skillBox!.height);
    /*
     * Center-x comparison defends against a regression where a panel
     * floats into a side-by-side column at the same vertical band as
     * its predecessor.
     */
    const centerX = (b: { x: number; width: number }) => Math.round(b.x + b.width / 2);
    const cardCx = centerX(cardBox!);
    expect(
      Math.abs(centerX(skillBox!) - cardCx),
      'skill panel must share the card column on mobile',
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(centerX(activityBox!) - cardCx),
      'activity panel must share the card column on mobile',
    ).toBeLessThanOrEqual(2);
  });

  test('no horizontal scroll at mobile viewport width', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * documentElement.scrollWidth > clientWidth is the canonical
     * "page overflows horizontally" signal. iPhone 13 viewport is
     * 390px; any extra horizontal pixel is a layout bug per canon
     * `dev-web-mobile-first-required`.
     */
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll, `page horizontally overflows: scroll=${overflow.scroll} client=${overflow.client}`)
      .toBeLessThanOrEqual(overflow.client);
  });

  test('Clear-focus button meets 44px tap-target minimum', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * FocusBanner exposes a clear-focus action; the operator taps
     * it to leave focus mode. A tap target smaller than 44x44 CSS
     * px fails Apple HIG and is a canon-bound gate per
     * `dev-web-mobile-first-required`.
     */
    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible();
    const clear = page.getByTestId('focus-clear');
    const box = await clear.boundingBox();
    expect(box, 'clear-focus button must be in the layout flow').not.toBeNull();
    expect(box!.width, `clear button width=${box!.width} below 44px tap floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `clear button height=${box!.height} below 44px tap floor`).toBeGreaterThanOrEqual(44);
  });

  test('activity-entry buttons (when present) meet 44px tap-target minimum', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * If the principal has activity, the feed renders clickable
     * entries. Each entry is the navigable surface to its atom; the
     * tap target must satisfy the 44px floor on both dimensions.
     * When no entries exist (fresh-install fixture), skip rather
     * than false-fail.
     */
    const items = page.getByTestId('principal-activity-item');
    const count = await items.count();
    test.skip(count === 0, 'no activity entries to measure');

    const first = items.first();
    const box = await first.boundingBox();
    expect(box, 'first activity entry must be in the layout flow').not.toBeNull();
    expect(box!.width, `entry width=${box!.width} below 44px tap floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `entry height=${box!.height} below 44px tap floor`).toBeGreaterThanOrEqual(44);
  });
});
