import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
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
 * 390px: activities feed, actor-activity, canon list AND focused
 * canon detail (12px overflow on /canon/<id> in the original audit),
 * plans list AND focused plan detail (62px overflow on /plans/<id>
 * with a long plan id). Stage-output renderers and atom-detail
 * (/atom/<id>) inherit the assertion via the canon focus tests where
 * shared layout primitives are exercised.
 *
 * Per canon `dev-web-mobile-first-required`: horizontal scroll on
 * mobile width <=400px is always a bug, never a 'works for now'.
 */

interface ListRouteSpec {
  readonly path: string;
  readonly waitForTestId: string;
}

const LIST_ROUTES: ReadonlyArray<ListRouteSpec> = [
  { path: '/activities', waitForTestId: 'activity-item' },
  { path: '/actor-activity', waitForTestId: 'actor-activity-view' },
  { path: '/canon', waitForTestId: 'canon-card' },
  { path: '/plans', waitForTestId: 'plan-card' },
];

/**
 * Detail surfaces require a runtime-discovered id (the focus mode lives
 * at `/canon/<id>` and `/plans/<id>`). The id-fetch helpers mirror
 * the pattern in tests/e2e/_lib/mobile.ts (gotoFirstCanon /
 * gotoFirstPlan). We use the local helpers here so the spec controls
 * the wait-for-render contract directly.
 */
function extractIdArray(body: unknown): ReadonlyArray<{ id: string }> | null {
  if (Array.isArray(body)) return body as ReadonlyArray<{ id: string }>;
  if (body && typeof body === 'object' && 'data' in body) {
    const data = (body as { data: unknown }).data;
    if (Array.isArray(data)) return data as ReadonlyArray<{ id: string }>;
  }
  return null;
}

async function fetchFirstId(request: APIRequestContext, endpoint: string): Promise<string | null> {
  const res = await request.post(endpoint, { data: {} });
  if (!res.ok()) return null;
  const body = (await res.json()) as unknown;
  const items = extractIdArray(body);
  if (!items || items.length === 0) return null;
  return items[0]!.id;
}

async function readOverflow(page: Page): Promise<{
  htmlScroll: number;
  htmlClient: number;
  mainScroll: number;
  mainClient: number;
  mainPresent: boolean;
}> {
  return await page.evaluate(() => {
    const html = document.documentElement;
    const main = document.querySelector('main');
    return {
      htmlScroll: html.scrollWidth,
      htmlClient: html.clientWidth,
      /*
       * NaN sentinels (rather than 0) so a regression that REMOVES
       * the AppShell <main> element fails the test loud at the
       * mainPresent assertion below; without this guard the
       * `main?.scrollWidth ?? 0` coercion would pass `0 <= 0` and
       * mask the structural break.
       */
      mainScroll: main?.scrollWidth ?? Number.NaN,
      mainClient: main?.clientWidth ?? Number.NaN,
      mainPresent: main !== null,
    };
  });
}

async function assertNoOverflow(page: Page, label: string): Promise<void> {
  /*
   * Small post-render settle so a flexbox/grid measurement that
   * shifts after the heatmap or first paint is captured in its
   * stable state.
   */
  await page.waitForTimeout(500);

  const o = await readOverflow(page);
  expect(o.mainPresent, `${label}: AppShell <main> missing -- structural regression`).toBe(true);
  expect(
    o.htmlScroll,
    `${label}: documentElement scroll=${o.htmlScroll} client=${o.htmlClient}`,
  ).toBeLessThanOrEqual(o.htmlClient);
  expect(
    o.mainScroll,
    `${label}: main scroll=${o.mainScroll} client=${o.mainClient} -- internal grid track or text node likely missing minmax(0, 1fr) or overflow-wrap: anywhere`,
  ).toBeLessThanOrEqual(o.mainClient);
}

test.describe('mobile overflow sweep', () => {
  for (const route of LIST_ROUTES) {
    test(`no horizontal overflow on ${route.path}`, async ({ page, viewport }) => {
      skipUnlessMobile(viewport);
      await page.goto(route.path);
      await expect(page.getByTestId(route.waitForTestId).first()).toBeVisible({ timeout: 10_000 });
      await assertNoOverflow(page, route.path);
    });
  }

  test('no horizontal overflow on /canon/<id> focus mode', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    const id = await fetchFirstId(request, '/api/canon.list');
    test.skip(id === null, 'no canon atoms to focus');
    await page.goto(`/canon/${encodeURIComponent(id!)}`);
    await expect(page.getByTestId('canon-card').first()).toBeVisible({ timeout: 10_000 });
    await assertNoOverflow(page, `/canon/${id!.slice(0, 30)}…`);
  });

  test('no horizontal overflow on /plans/<id> focus mode', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    const id = await fetchFirstId(request, '/api/plans.list');
    test.skip(id === null, 'no plans to focus');
    await page.goto(`/plans/${encodeURIComponent(id!)}`);
    await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 10_000 });
    await assertNoOverflow(page, `/plans/${id!.slice(0, 30)}…`);
  });
});
