import { test, expect } from '@playwright/test';

/**
 * Operator Control Panel mobile top-section regression guard.
 *
 * The desktop control panel uses a 3-column hero grid
 * (`auto 1fr auto`) with a 64x64 icon chip, generous --space-7
 * outer padding, and a right-aligned "Engage Kill Switch" CTA. On
 * iPhone-13 (390x844) that layout collapsed:
 *   - the heroTitle ("Not engaged") wrapped one syllable per line
 *     because the 1fr middle column got squeezed between a 64px
 *     icon and a 100+px button
 *   - the engage button itself wrapped to three lines
 *   - the hero card came in at ~451px tall, blowing past one
 *     above-the-fold view
 *   - the topbar route title rendered character-stacked vertically
 *     because `titleGroup` was `flex: 0 1 auto` next to a 277px
 *     actions cluster, leaving ~18px for the heading
 *
 * This spec pins the fixed mobile shape so the issue cannot
 * regress silently. We assert structurally (widths, heights,
 * absence of horizontal overflow) rather than against pixel
 * snapshots, which would flake across font-rendering differences
 * between local + CI macOS/Linux. A debug screenshot lands in
 * `test-results/` for visual review when the structural check
 * fails on CI.
 */
const HERO_ICON_MAX_HEIGHT_PX = 60;
const HERO_DETAIL_MAX_LINES = 4;

test.describe('control panel mobile top section', () => {
  test('renders within iPhone-13 viewport with no horizontal overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/control');

    /*
     * Wait for the kill-switch hero to mount before measuring.
     * TanStack Query primes the control-status payload from the
     * 9109 backend; until the hero appears the page is in the
     * LoadingState shell, which has its own (smaller) layout.
     */
    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible();
    await expect(page.getByTestId('control-kill-switch-title')).toBeVisible();

    /*
     * No horizontal scrollbar at any scroll position. Document and
     * body scrollWidth must both equal the viewport width; either
     * exceeding would mean some descendant pushed past 390px and
     * iOS Safari shows a horizontal scroll indicator on touch.
     */
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(overflow.docScrollWidth).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.viewport);

    /*
     * Hero card fits within the viewport. We allow an exact match
     * (the card stretches edge-to-edge inside the viewport padding)
     * but not an overflow.
     */
    const heroBox = await hero.boundingBox();
    expect(heroBox).not.toBeNull();
    expect(heroBox!.width).toBeLessThanOrEqual(overflow.viewport);

    /*
     * Hero icon chip <= 60px tall on mobile. The desktop chip is
     * --space-9 (64px); the mobile override drops to --space-8
     * (48px). 60px is the tolerance band: anything above means the
     * mobile media query was bypassed.
     */
    const heroIconBox = await hero.locator('> div').first().boundingBox();
    expect(heroIconBox).not.toBeNull();
    expect(heroIconBox!.height).toBeLessThanOrEqual(HERO_ICON_MAX_HEIGHT_PX);

    /*
     * Caption renders without overflow. We compute lineCount by
     * dividing the rendered height by the line-height; with --font-
     * size-sm + --line-height-normal that's ~21px per line. The
     * caption is at most HERO_DETAIL_MAX_LINES lines (the not-
     * engaged copy is ~120 chars; at ~30 chars/line on iPhone that
     * lands at 4 lines worst case). More than that signals either a
     * narrower-than-expected card or a font-size regression.
     */
    const captionInfo = await hero.locator('p').last().evaluate((el) => {
      const cs = getComputedStyle(el);
      const lineHeight = parseFloat(cs.lineHeight);
      const height = el.getBoundingClientRect().height;
      return {
        lineHeight,
        height,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    const lineCount = Math.round(captionInfo.height / captionInfo.lineHeight);
    expect(lineCount).toBeLessThanOrEqual(HERO_DETAIL_MAX_LINES);
    /*
     * scrollWidth > clientWidth means the inner text is clipped --
     * i.e. some character escaped the line-wrap and pushed past the
     * caption width.
     */
    expect(captionInfo.scrollWidth).toBeLessThanOrEqual(captionInfo.clientWidth);

    /*
     * Engage CTA fits the hero column and shows on one line. Mobile
     * media query stretches the button to width:100%, justify:center.
     * If the desktop layout leaks through, the button shrinks to its
     * content width (~100px) and "Engage Kill Switch" wraps to 3
     * lines, blowing the button up to ~76px tall.
     */
    const button = page.getByTestId('control-engage-button');
    await expect(button).toBeVisible();
    const buttonBox = await button.boundingBox();
    expect(buttonBox).not.toBeNull();
    /*
     * Single-line CTA: 1.0 line-height * --font-size-sm (~14px) +
     * 2 * --space-4 padding (~24px) = ~38-50px tall. 60px is the
     * tolerance ceiling; a wrapping CTA lands at 70+.
     */
    expect(buttonBox!.height).toBeLessThanOrEqual(60);

    /*
     * Tier banner + metrics grid both within viewport.
     */
    const tierBox = await page.getByTestId('control-tier-banner').boundingBox();
    expect(tierBox).not.toBeNull();
    expect(tierBox!.x + tierBox!.width).toBeLessThanOrEqual(overflow.viewport);

    const metricsBox = await page.getByTestId('control-metrics').boundingBox();
    expect(metricsBox).not.toBeNull();
    expect(metricsBox!.x + metricsBox!.width).toBeLessThanOrEqual(overflow.viewport);

    /*
     * Visual debug artifact -- saved to test-results/ via
     * testInfo.outputPath so the operator can eyeball the layout if
     * the structural assertions ever drift. Always written on success
     * so we have a baseline for a future "looks-the-same" check.
     */
    await page.screenshot({
      path: testInfo.outputPath('control-panel-mobile-top.png'),
      fullPage: true,
    });
  });

  test('hero stack lays out vertically on mobile (no horizontal squeeze)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/control');

    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible();
    await expect(page.getByTestId('control-kill-switch-title')).toBeVisible();

    /*
     * Stack ordering: the hero icon, body, and engage button render
     * top-to-bottom on mobile. We measure their `top` offsets and
     * assert they are strictly increasing -- i.e. no two elements
     * share the same row. This is the mechanical signal that the
     * desktop 3-column grid (`grid-template-columns: auto 1fr auto`)
     * was overridden by the mobile single-column rule.
     */
    const positions = await hero.evaluate((heroEl) => {
      const icon = heroEl.children[0] as HTMLElement;
      const body = heroEl.children[1] as HTMLElement;
      const button = heroEl.querySelector('[data-testid="control-engage-button"]') as HTMLElement;
      return {
        iconTop: icon.getBoundingClientRect().top,
        bodyTop: body.getBoundingClientRect().top,
        buttonTop: button.getBoundingClientRect().top,
      };
    });
    expect(positions.bodyTop).toBeGreaterThan(positions.iconTop);
    expect(positions.buttonTop).toBeGreaterThan(positions.bodyTop);
  });

  test('chromium project still uses the desktop hero grid', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only assertion');
    await page.goto('/control');

    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible();
    await expect(page.getByTestId('control-kill-switch-title')).toBeVisible();

    /*
     * On desktop the icon, body, and engage button share a single
     * row (the original 3-column grid). We assert their top offsets
     * are within a small tolerance -- the bodies of children of a
     * grid-template-columns row align to the same vertical baseline.
     */
    const positions = await hero.evaluate((heroEl) => {
      const icon = heroEl.children[0] as HTMLElement;
      const body = heroEl.children[1] as HTMLElement;
      const button = heroEl.querySelector('[data-testid="control-engage-button"]') as HTMLElement;
      return {
        iconTop: icon.getBoundingClientRect().top,
        bodyTop: body.getBoundingClientRect().top,
        buttonTop: button.getBoundingClientRect().top,
      };
    });
    /*
     * Loose tolerance: align-items: center on the grid row pushes
     * each child to its own vertical offset depending on intrinsic
     * height. We expect them within ~64px (the icon chip diameter).
     */
    const verticalSpread = Math.max(positions.iconTop, positions.bodyTop, positions.buttonTop)
      - Math.min(positions.iconTop, positions.bodyTop, positions.buttonTop);
    expect(verticalSpread).toBeLessThanOrEqual(80);
  });
});
