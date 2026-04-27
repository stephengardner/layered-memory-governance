import { test, expect, devices } from '@playwright/test';

/**
 * Mobile-first assertions for the plans-detail surface (/plans/<id>).
 *
 * Companion to principal-mobile.spec.ts: same canon discipline
 * (`dev-web-mobile-first-required`), different surface. The plans
 * focus-mode renders a single PlanCard under a FocusBanner; on a
 * 390px viewport the contract is a single column, no horizontal
 * scroll, and 44 CSS-pixel tap targets on the controls an operator
 * touches.
 *
 * Each test runtime-skips on the chromium project so the spec stays
 * meaningful in the mobile project (iPhone 13) without producing
 * false negatives in the desktop project. Once principal-mobile
 * lands (#229), both specs duplicate the skipUnlessMobile helper:
 * that is the N=2 trigger for extraction into a shared test helper
 * (tests/e2e/_lib/mobile.ts) in a follow-up PR.
 */

const MOBILE_WIDTH = devices['iPhone 13'].viewport.width;

/**
 * Fail-closed default: when viewport is missing (e.g. a future
 * Playwright project that does not declare one), the safe choice is
 * SKIP, not run. Treat unknown viewport as wider-than-mobile so the
 * mobile-only assertion does not run against a desktop-shaped page
 * and produce false positives on tap-target/horizontal-scroll
 * checks.
 */
function skipUnlessMobile(viewport: { width: number } | null | undefined): void {
  const width = viewport?.width ?? Number.POSITIVE_INFINITY;
  test.skip(width > MOBILE_WIDTH, 'mobile-only assertion');
}

interface PlanRow {
  readonly id: string;
}

/**
 * Discover a real plan id at runtime so the spec stays meaningful
 * regardless of which fixtures the local install ships, then visit
 * /plans/<id>. Skips cleanly when the store is empty so a
 * fresh-install workflow does not false-fail. Per canon
 * `dev-extract-at-n-equals-2`: this block was duplicated in three
 * tests before extraction.
 */
async function gotoFirstPlan(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
): Promise<void> {
  const res = await request.post('/api/plans.list', { data: {} });
  expect(res.ok(), 'plans.list endpoint should return 200').toBe(true);
  const body = await res.json();
  const plans: ReadonlyArray<PlanRow> = body?.data ?? body ?? [];
  test.skip(plans.length === 0, 'no plans to focus');
  await page.goto(`/plans/${encodeURIComponent(plans[0]!.id)}`);
}

test.describe('plans-detail mobile surface', () => {
  test('focus-mode renders FocusBanner + PlanCard in single column', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstPlan(page, request);

    await expect(page.getByTestId('focus-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('plan-card')).toHaveCount(1);

    /*
     * Center-x equality between the FocusBanner and the PlanCard
     * proves they share the column; a regression that floats one
     * panel into a side column at the same vertical band would still
     * pass any "below" check, so the column equality is the real
     * single-column contract.
     */
    const banner = page.getByTestId('focus-banner');
    const card = page.getByTestId('plan-card');
    const bannerBox = await banner.boundingBox();
    const cardBox = await card.boundingBox();
    expect(bannerBox, 'focus-banner must be in the layout flow').not.toBeNull();
    expect(cardBox, 'plan-card must be in the layout flow').not.toBeNull();
    expect(cardBox!.y, 'plan-card must stack below focus-banner').toBeGreaterThan(bannerBox!.y);
    const centerX = (b: { x: number; width: number }) => Math.round(b.x + b.width / 2);
    expect(
      Math.abs(centerX(cardBox!) - centerX(bannerBox!)),
      'plan-card must share the focus-banner column on mobile',
    ).toBeLessThanOrEqual(2);
  });

  test('no horizontal scroll at mobile viewport width', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstPlan(page, request);
    await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 10_000 });

    /*
     * Plan bodies render markdown with potentially long code-fences
     * and atom-id refs; the CSS uses overflow-wrap: anywhere to keep
     * them inside the card. iPhone 13 is 390 CSS px; any extra
     * horizontal pixel violates canon `dev-web-mobile-first-required`
     * ("horizontal scroll on mobile width <=400px is always a bug").
     */
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll, `page horizontally overflows: scroll=${overflow.scroll} client=${overflow.client}`)
      .toBeLessThanOrEqual(overflow.client);
  });

  test('Clear-focus button meets 44px tap-target minimum', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstPlan(page, request);
    await expect(page.getByTestId('focus-banner')).toBeVisible({ timeout: 10_000 });

    /*
     * Same FocusBanner component as the principals surface; the tap
     * floor lives on the .clear class via --size-touch-target-min.
     * Re-asserting here lets a future regression in the plans-only
     * styling surface fail this spec rather than silently slipping
     * past principal-mobile.spec.ts.
     */
    const clear = page.getByTestId('focus-clear');
    const box = await clear.boundingBox();
    expect(box, 'clear-focus button must be in the layout flow').not.toBeNull();
    expect(box!.width, `clear width=${box!.width} below 44px floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `clear height=${box!.height} below 44px floor`).toBeGreaterThanOrEqual(44);
  });
});
