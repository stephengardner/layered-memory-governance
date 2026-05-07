import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { skipUnlessMobile } from './_lib/mobile';

/**
 * Touch-target floor sweep on mobile viewport. Per canon
 * `dev-web-mobile-first-required`: every interactive element MUST
 * meet a 44x44 CSS-pixel minimum on touch devices.
 *
 * Scope: STANDALONE interactive controls - header chrome (theme,
 * density, propose, kill-switch, copy-link), canon-viewer chips and
 * expand buttons, dashboard window picker. INLINE atom-ref chips
 * embedded within sentence flow are exempt per WCAG 2.5.8 (the
 * inline-content exemption applies because forcing 44px on a
 * citation link inside a paragraph would break reading flow with
 * giant gaps between citations).
 *
 * Two anchor strategies coexist:
 *   - `testid`: data-testid attribute (preferred for components that
 *     already expose one - stable across CSS-module hash changes
 *     AND across cosmetic class renames)
 *   - `classPrefix`: class-name prefix match (used where the
 *     component has a uniquely-named CSS-module class but no
 *     data-testid; the prefix survives the hash but a class rename
 *     is a coordinated test+source change)
 */

interface ControlCheck {
  readonly route: string;
  readonly testid?: string;
  readonly classPrefix?: string;
  readonly description: string;
}

const STANDALONE_CONTROLS: ReadonlyArray<ControlCheck> = [
  { route: '/dashboard', classPrefix: '_proposeBtn_', description: 'header propose button' },
  { route: '/dashboard', classPrefix: '_themeToggle_', description: 'header theme toggle' },
  { route: '/dashboard', testid: 'density-toggle', description: 'header density toggle' },
  { route: '/dashboard', testid: 'kill-switch-pill', description: 'header kill-switch pill' },
  // copy-link only renders inside expanded CanonCards / AtomDetailView, not the dashboard chrome.
  // The copy-link case is exercised in the focus-mode test below where a real atom id is fetched.
  { route: '/dashboard', classPrefix: '_windowBtn_', description: 'dashboard window picker (24h/7d/30d)' },
  { route: '/canon', classPrefix: '_chip_', description: 'canon type-filter chip (All/Directives/...)' },
  { route: '/canon', classPrefix: '_expand_', description: 'canon-card show-details toggle' },
];

async function findFirstControl(page: Page, control: ControlCheck) {
  return await page.evaluate((spec) => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
    );
    for (const el of candidates) {
      if (spec.testid !== undefined) {
        if (el.getAttribute('data-testid') !== spec.testid) continue;
      } else if (spec.classPrefix !== undefined) {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!cls.split(/\s+/).some((c) => c.startsWith(spec.classPrefix as string))) continue;
      } else {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      return { width: rect.width, height: rect.height };
    }
    return null;
  }, { testid: control.testid, classPrefix: control.classPrefix });
}

/*
 * Subpixel tolerance for floor enforcement. Browsers under high
 * device-pixel-ratios (iPhone 13 = 3x) round CSS-px through layout
 * and can return 43.999... for a `min-height: 44px` declaration. The
 * tolerance absorbs that fp noise without weakening the floor: a real
 * 43.5px control still fails (43.5 < 43.99), only the dpr-noise margin
 * passes. Per WCAG 2.5.5 wording ('at least 44 CSS pixels'), 43.99 is
 * functionally 44.
 */
const FLOOR_PX = 44;
const SUBPIXEL_TOLERANCE = 0.01;
const MIN_FLOOR = FLOOR_PX - SUBPIXEL_TOLERANCE;

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

test.describe('touch-target floor on mobile viewport', () => {
  for (const control of STANDALONE_CONTROLS) {
    test(`${control.description} on ${control.route} >= 44x44`, async ({ page, viewport }) => {
      skipUnlessMobile(viewport);
      await page.goto(control.route);
      /*
       * Small settle so route mount + first-paint + measure-after-fonts
       * are all done before reading the rect.
       */
      await page.waitForTimeout(800);
      const box = await findFirstControl(page, control);
      const anchor = control.testid !== undefined
        ? `data-testid="${control.testid}"`
        : `class prefix ${control.classPrefix}`;
      expect(box, `${control.description}: no element matching ${anchor}`).not.toBeNull();
      expect(
        box!.width,
        `${control.description}: width=${box!.width} below 44px floor (${control.route})`,
      ).toBeGreaterThanOrEqual(MIN_FLOOR);
      expect(
        box!.height,
        `${control.description}: height=${box!.height} below 44px floor (${control.route})`,
      ).toBeGreaterThanOrEqual(MIN_FLOOR);
    });
  }

  /*
   * copy-link only renders inside an expanded CanonCard / focused
   * AtomDetailView — it lives in the actions row at the bottom of
   * the rich card body, not in the header chrome. We exercise it via
   * a runtime-discovered atom id and the atom-detail viewer (which
   * always shows the actions row) so the test is anchored to a route
   * where the control is guaranteed to be in the DOM.
   */
  test('copy-link button on /atom/<id> >= 44x44', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    const id = await fetchFirstId(request, '/api/canon.list');
    test.skip(id === null, 'no atoms available to focus');
    await page.goto(`/atom/${encodeURIComponent(id!)}`);
    await page.waitForTimeout(800);
    const box = await findFirstControl(page, { route: '', testid: 'copy-link', description: 'copy-link button' });
    expect(box, 'copy-link: no element matching data-testid="copy-link"').not.toBeNull();
    expect(box!.width, `copy-link: width=${box!.width} below 44px floor`).toBeGreaterThanOrEqual(MIN_FLOOR);
    expect(box!.height, `copy-link: height=${box!.height} below 44px floor`).toBeGreaterThanOrEqual(MIN_FLOOR);
  });
});
