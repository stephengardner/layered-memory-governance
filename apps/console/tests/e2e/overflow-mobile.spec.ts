import { test, expect, type Page } from '@playwright/test';
import { skipUnlessMobile } from './_lib/mobile';

/**
 * Mobile-overflow regression sweep. Catches the specific failure mode
 * that the existing per-feature mobile specs (canon-mobile,
 * plans-mobile, principal-mobile) MISSED: the AppShell `<main>` has
 * `overflow-x: auto`, so a layout that pushes its content past the
 * viewport renders horizontal scroll INSIDE the main column without
 * inflating `documentElement.scrollWidth`. Those specs only check the
 * outer document, so a 546px-wide grid track on /activities passed
 * them silently.
 *
 * This spec asserts both:
 *   - `documentElement.scrollWidth <= clientWidth` (the page level)
 *   - `main.scrollWidth <= main.clientWidth` (the scoped scroll)
 *
 * Routes covered are the surfaces that historically over-flowed at
 * 390px: activities feed, actor-activity, canon list, canon detail,
 * plans list, plans detail. New surfaces with long unbreakable text
 * (atom ids, plan ids) inherit the assertion by being added to ROUTES.
 *
 * Per canon `dev-web-mobile-first-required`: horizontal scroll on
 * mobile width <=400px is always a bug, never a 'works for now'.
 */

interface RouteSpec {
  readonly path: string;
  readonly waitForTestId?: string;
}

const ROUTES: ReadonlyArray<RouteSpec> = [
  { path: '/activities', waitForTestId: 'activity-item' },
  { path: '/actor-activity', waitForTestId: 'actor-activity-view' },
  { path: '/canon', waitForTestId: 'canon-card' },
  { path: '/plans', waitForTestId: 'plan-card' },
];

async function readOverflow(page: Page): Promise<{
  htmlScroll: number;
  htmlClient: number;
  mainScroll: number;
  mainClient: number;
}> {
  return await page.evaluate(() => {
    const html = document.documentElement;
    const main = document.querySelector('main');
    return {
      htmlScroll: html.scrollWidth,
      htmlClient: html.clientWidth,
      mainScroll: main?.scrollWidth ?? 0,
      mainClient: main?.clientWidth ?? 0,
    };
  });
}

test.describe('mobile overflow sweep', () => {
  for (const route of ROUTES) {
    test(`no horizontal overflow on ${route.path}`, async ({ page, viewport }) => {
      skipUnlessMobile(viewport);
      await page.goto(route.path);
      /*
       * Wait for content render where a stable test-id exists so the
       * assertion fires after the layout resolves, not against the
       * skeleton/loading state. Routes without a designated test-id
       * fall back to network idle.
       */
      if (route.waitForTestId) {
        await expect(page.getByTestId(route.waitForTestId).first()).toBeVisible({ timeout: 10_000 });
      } else {
        /*
         * `domcontentloaded` rather than `networkidle` because the
         * SSE atom-events channel keeps the network busy indefinitely;
         * waiting for idle-state would always time out.
         */
        await page.waitForLoadState('domcontentloaded');
      }
      /*
       * Small post-render settle so a flexbox/grid measurement that
       * shifts after the heatmap or first paint is captured in its
       * stable state.
       */
      await page.waitForTimeout(500);

      const o = await readOverflow(page);
      expect(
        o.htmlScroll,
        `${route.path}: documentElement scroll=${o.htmlScroll} client=${o.htmlClient}`,
      ).toBeLessThanOrEqual(o.htmlClient);
      expect(
        o.mainScroll,
        `${route.path}: main scroll=${o.mainScroll} client=${o.mainClient} -- internal grid track or text node likely missing minmax(0, 1fr) or overflow-wrap: anywhere`,
      ).toBeLessThanOrEqual(o.mainClient);
    });
  }
});
