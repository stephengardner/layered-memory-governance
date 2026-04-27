import { test, expect, devices } from '@playwright/test';

/**
 * Mobile-first assertions for the canon-detail surface (/canon/<id>).
 *
 * Companion to principal-mobile.spec.ts and plans-mobile.spec.ts:
 * same canon discipline (`dev-web-mobile-first-required`), different
 * surface. The canon focus-mode renders one or more CanonCards; on a
 * 390px viewport the contract is no horizontal scroll, 44 CSS-pixel
 * tap targets on the controls an operator touches, and a
 * single-column flow.
 *
 * Each test runtime-skips on the chromium project so the spec stays
 * meaningful in the mobile project (iPhone 13) without producing
 * false negatives in the desktop project. The skipUnlessMobile helper
 * is duplicated locally; once principal-mobile.spec.ts lands (#229)
 * three specs hold the same helper definition and a follow-up PR
 * extracts to tests/e2e/_lib/mobile.ts per canon
 * `dev-extract-at-n-equals-2`.
 */

const MOBILE_WIDTH = devices['iPhone 13'].viewport.width;

function skipUnlessMobile(viewport: { width: number } | null | undefined): void {
  // Fail-closed: unknown viewport defaults to skip, not run.
  const width = viewport?.width ?? Number.POSITIVE_INFINITY;
  test.skip(width > MOBILE_WIDTH, 'mobile-only assertion');
}

interface CanonRow {
  readonly id: string;
}

/**
 * Discover a stable canon atom id at runtime via /api/canon.list so
 * the spec stays meaningful regardless of which fixtures the local
 * install ships. Skips cleanly when the store has no canon (fresh
 * install) so the spec never false-fails.
 */
async function gotoFirstCanon(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
): Promise<void> {
  const res = await request.post('/api/canon.list', { data: {} });
  expect(res.ok(), 'canon.list endpoint should return 200').toBe(true);
  const body = await res.json();
  const atoms: ReadonlyArray<CanonRow> = body?.data ?? body ?? [];
  test.skip(atoms.length === 0, 'no canon atoms to focus');
  await page.goto(`/canon/${encodeURIComponent(atoms[0]!.id)}`);
}

test.describe('canon-detail mobile surface', () => {
  test('focus-mode renders FocusBanner + CanonCard in single column', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstCanon(page, request);

    await expect(page.getByTestId('focus-banner')).toBeVisible({ timeout: 10_000 });
    /*
     * The canon focus mode renders the focused atom plus optional
     * supersession-chain context, so >= 1 canon-card is the right
     * cardinality assertion (not exactly 1).
     */
    const cards = page.getByTestId('canon-card');
    const cardCount = await cards.count();
    expect(cardCount, 'canon focus mode must render at least one canon-card').toBeGreaterThanOrEqual(1);

    const banner = page.getByTestId('focus-banner');
    const firstCard = cards.first();
    const bannerBox = await banner.boundingBox();
    const cardBox = await firstCard.boundingBox();
    expect(bannerBox, 'focus-banner must be in the layout flow').not.toBeNull();
    expect(cardBox, 'canon-card must be in the layout flow').not.toBeNull();
    expect(cardBox!.y, 'canon-card must stack below focus-banner').toBeGreaterThan(bannerBox!.y);
    /*
     * Center-x equality between the FocusBanner and the first
     * CanonCard proves they share the column; a regression that
     * floats one panel into a side column at the same vertical band
     * would still pass any "below" check.
     */
    const centerX = (b: { x: number; width: number }) => Math.round(b.x + b.width / 2);
    expect(
      Math.abs(centerX(cardBox!) - centerX(bannerBox!)),
      'canon-card must share the focus-banner column on mobile',
    ).toBeLessThanOrEqual(2);
  });

  test('no horizontal scroll at mobile viewport width', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstCanon(page, request);
    await expect(page.getByTestId('canon-card').first()).toBeVisible({ timeout: 10_000 });

    /*
     * Canon prose contains long atom-id refs and code-fences; the
     * markdown components must wrap them. iPhone 13 is 390 CSS px;
     * any extra horizontal pixel violates canon
     * `dev-web-mobile-first-required` ("horizontal scroll on mobile
     * width <=400px is always a bug").
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
    await gotoFirstCanon(page, request);
    await expect(page.getByTestId('focus-banner')).toBeVisible({ timeout: 10_000 });

    /*
     * Same FocusBanner component as the principals/plans surfaces;
     * the tap floor lives on the .clear class via
     * --size-touch-target-min. Re-asserting here lets a future
     * regression in the canon-only styling surface fail this spec
     * rather than silently slipping past the other mobile specs.
     */
    const clear = page.getByTestId('focus-clear');
    const box = await clear.boundingBox();
    expect(box, 'clear-focus button must be in the layout flow').not.toBeNull();
    expect(box!.width, `clear width=${box!.width} below 44px floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `clear height=${box!.height} below 44px floor`).toBeGreaterThanOrEqual(44);
  });
});
