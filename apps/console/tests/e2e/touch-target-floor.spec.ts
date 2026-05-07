import { test, expect, type Page } from '@playwright/test';
import { skipUnlessMobile } from './_lib/mobile';

/**
 * Touch-target floor sweep on mobile viewport. Per canon
 * `dev-web-mobile-first-required`: every interactive element MUST
 * meet a 44x44 CSS-pixel minimum on touch devices.
 *
 * Scope: STANDALONE interactive controls — header chrome (theme,
 * density, propose, kill-switch), canon-viewer chips and expand
 * buttons, dashboard window picker. INLINE atom-ref chips embedded
 * within sentence flow are exempt per WCAG 2.5.8 (the inline-content
 * exemption applies because forcing 44px on a citation link inside
 * a paragraph would break reading flow with giant gaps between
 * citations).
 *
 * The selectors are intentionally coarse class-based queries because
 * CSS-modules hash the class names; matching the prefix gives us a
 * stable handle that survives a hash change while still scoping to
 * the specific controls under test.
 */

interface ControlCheck {
  readonly route: string;
  readonly /** Class-prefix selector for the control under test. */ classPrefix: string;
  readonly description: string;
}

const STANDALONE_CONTROLS: ReadonlyArray<ControlCheck> = [
  { route: '/dashboard', classPrefix: '_proposeBtn_', description: 'header propose button' },
  { route: '/dashboard', classPrefix: '_themeToggle_', description: 'header theme toggle' },
  { route: '/dashboard', classPrefix: '_windowBtn_', description: 'dashboard window picker (24h/7d/30d)' },
  { route: '/canon', classPrefix: '_chip_', description: 'canon type-filter chip (All/Directives/...)' },
  { route: '/canon', classPrefix: '_expand_', description: 'canon-card show-details toggle' },
];

async function findFirstByClassPrefix(page: Page, classPrefix: string) {
  return await page.evaluate((prefix) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'));
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!cls.split(/\s+/).some((c) => c.startsWith(prefix))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    return null;
  }, classPrefix);
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
      const box = await findFirstByClassPrefix(page, control.classPrefix);
      expect(box, `${control.description}: no element matching class prefix ${control.classPrefix}`).not.toBeNull();
      expect(
        box!.width,
        `${control.description}: width=${box!.width} below 44px floor (${control.route})`,
      ).toBeGreaterThanOrEqual(44);
      expect(
        box!.height,
        `${control.description}: height=${box!.height} below 44px floor (${control.route})`,
      ).toBeGreaterThanOrEqual(44);
    });
  }
});
