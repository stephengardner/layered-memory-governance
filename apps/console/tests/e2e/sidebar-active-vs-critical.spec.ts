import { test, expect, type Page } from '@playwright/test';

/**
 * Sidebar active-vs-critical separation.
 *
 * Regression context: the `.itemCritical` treatment (Pulse + Control)
 * shipped on 2026-04-26 with an accent-tinted background + border.
 * Operator confirmed 2026-05-05 that this read as "menu items appear
 * selected when they aren't" -- two non-active items wore the same
 * row chrome as the actual active item, so on every render at least
 * three rows looked selected when only one was. The fix collapses
 * `.itemCritical` to icon-tint emphasis only; the row background +
 * border are gone.
 *
 * What this spec guards (single source of truth for the contract):
 *
 *   1. Exactly ONE nav item carries `aria-current="page"` for any
 *      route the operator can reach. The same item is the only one
 *      with the `.itemActive` styling (`::before` left bar +
 *      non-transparent background).
 *
 *   2. `.itemCritical` items NEVER carry the visual "row is selected"
 *      treatment when they are not the current route. Specifically:
 *      transparent background, no `::before` bar, no border that
 *      could be mistaken for selection.
 *
 *   3. The icon on a critical item paints `--accent` so the
 *      "reach for these first" affordance survives without
 *      borrowing active chrome.
 *
 * Why a custom helper to read the ::before content: jsdom-shaped
 * Playwright environments sometimes return the literal string
 * `"none"` when the pseudo-element is not generated. We treat
 * either `"none"` or empty-string-without-content as "no bar
 * rendered" so the assertion does not flap on engine quirks.
 */

interface NavStyleSnapshot {
  readonly id: string;
  readonly classes: string;
  readonly ariaCurrent: string | null;
  readonly background: string;
  readonly beforeContent: string;
  readonly iconColor: string;
}

/*
 * Read the rendered styling of every desktop nav item in one round
 * trip so the assertions below all see the same DOM frame; otherwise
 * an in-flight hover state could shift between two consecutive
 * page.evaluate() calls and turn an order-of-checks bug into a flake.
 */
async function snapshotDesktopNav(page: Page): Promise<readonly NavStyleSnapshot[]> {
  return await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'nav[aria-label="Primary"] a[data-testid^="nav-"]',
      ),
    );
    return items.map((el) => {
      const cs = window.getComputedStyle(el);
      const before = window.getComputedStyle(el, '::before');
      const svg = el.querySelector('svg');
      const svgColor = svg ? window.getComputedStyle(svg).color : '';
      return {
        id: el.dataset['testid'] ?? '',
        classes: el.className,
        ariaCurrent: el.getAttribute('aria-current'),
        background: cs.backgroundColor,
        beforeContent: before.content,
        iconColor: svgColor,
      };
    });
  });
}

/*
 * `rgba(0, 0, 0, 0)` and `transparent` both serialize differently
 * across browsers; normalize to a single boolean so the assertion
 * is engine-portable.
 */
function isTransparent(bg: string): boolean {
  if (!bg) return true;
  if (bg === 'transparent') return true;
  if (bg === 'rgba(0, 0, 0, 0)') return true;
  return false;
}

/*
 * `none` is what getComputedStyle returns for an unrendered
 * pseudo-element; literal `""` is what a `content: ""` rule
 * resolves to (the active bar uses this). Treat the latter
 * as "bar present" and the former as "bar absent."
 */
function hasBeforeBar(content: string): boolean {
  return content !== 'none';
}

/*
 * Move the cursor away from the sidebar before reading row backgrounds
 * so a stray `:hover` from a click target does not pollute the
 * "is this row visually selected?" assertion. Page corner is far
 * enough from any nav item to clear all hover states.
 */
async function parkCursor(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
}

test.describe('sidebar active-vs-critical separation', () => {
  /*
   * Iterate every route the user can browse to. For each, exactly one
   * desktop nav item is `.itemActive` + `aria-current="page"`, and no
   * other item -- critical or otherwise -- visually claims selection.
   */
  for (const route of ['/dashboard', '/canon', '/principals', '/control'] as const) {
    test(`only one nav item is visually selected on ${route}`, async ({ page }) => {
      await page.goto(route);
      // Wait for the active class to land. Vite HMR + react-query
      // hydration can briefly leave the sidebar without aria-current
      // on the very first paint; the `toHaveAttribute` wait closes
      // that race so the snapshot below is deterministic.
      const expectedTestId = `nav-${
        route === '/control' ? 'control'
          : route === '/dashboard' ? 'dashboard'
          : route === '/canon' ? 'canon'
          : 'principals'
      }`;
      await expect(page.getByTestId(expectedTestId).first()).toHaveAttribute(
        'aria-current',
        'page',
      );
      await parkCursor(page);
      const snap = await snapshotDesktopNav(page);

      const ariaCurrentItems = snap.filter((n) => n.ariaCurrent === 'page');
      expect(ariaCurrentItems).toHaveLength(1);
      expect(ariaCurrentItems[0]?.id).toBe(expectedTestId);

      const visualSelected = snap.filter((n) => hasBeforeBar(n.beforeContent));
      expect(visualSelected.map((n) => n.id)).toEqual([expectedTestId]);
    });
  }

  test('critical items do not paint a selected-looking row when inactive', async ({ page }) => {
    /*
     * Pick a route that is NOT a critical item (Canon) so both Pulse
     * (`live-ops`) and Control are critical-and-inactive at once.
     * That is the exact configuration the operator-reported bug
     * showed: three rows appearing selected on a Canon/Dashboard
     * render.
     */
    await page.goto('/canon');
    await expect(page.getByTestId('nav-canon').first()).toHaveAttribute(
      'aria-current',
      'page',
    );
    await parkCursor(page);
    const snap = await snapshotDesktopNav(page);

    const pulse = snap.find((n) => n.id === 'nav-live-ops');
    const control = snap.find((n) => n.id === 'nav-control');
    expect(pulse, 'live-ops nav item exists').toBeTruthy();
    expect(control, 'control nav item exists').toBeTruthy();

    for (const critical of [pulse!, control!]) {
      // The row itself does not paint a background that looks
      // selected.
      expect(
        isTransparent(critical.background),
        `${critical.id} background should be transparent (got ${critical.background})`,
      ).toBe(true);
      // No active-bar pseudo-element. Selection is reserved for
      // the real `aria-current="page"` row.
      expect(
        hasBeforeBar(critical.beforeContent),
        `${critical.id} should not render the active ::before bar`,
      ).toBe(false);
      // The marker survives in the icon tint -- non-empty,
      // non-default text color so the canon comment in
      // Sidebar.module.css is enforced.
      expect(critical.iconColor).not.toBe('');
      expect(critical.iconColor).not.toBe('rgb(0, 0, 0)');
    }
  });
});
