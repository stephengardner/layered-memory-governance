import { test, expect } from '@playwright/test';

/**
 * E2E coverage for the /file-intent surface.
 *
 * Runs in BOTH the chromium (desktop) and mobile (iPhone 13) projects
 * per canon `dev-web-mobile-first-required` -- the mobile assertions
 * are gated via `project.name === 'mobile'` and the desktop ones via
 * the inverse so each test runs exactly once in the right viewport.
 *
 * Backend writes are gated behind LAG_CONSOLE_ALLOW_WRITES=1; the
 * Playwright server is started without that env var by default, so the
 * "submission fails with a typed 403" path is the green-state for the
 * default install. We assert the error toast surfaces the gate. A
 * write-enabled run (LAG_CONSOLE_ALLOW_WRITES=1 set in the harness env)
 * exercises the success path; otherwise the spec runs the read-only
 * branch which IS the live wire contract for the default install.
 */

test.describe('file-intent panel', () => {
  test('renders the form with default values', async ({ page }) => {
    await page.goto('/file-intent');
    await expect(page.getByTestId('file-intent-view')).toBeVisible();
    await expect(page.getByTestId('file-intent-form')).toBeVisible();
    await expect(page.getByTestId('file-intent-request')).toBeVisible();
    await expect(page.getByTestId('file-intent-scope')).toHaveValue('tooling');
    await expect(page.getByTestId('file-intent-blast-radius')).toHaveValue('tooling');
    await expect(page.getByTestId('file-intent-expires')).toHaveValue('24h');
    /*
     * code-author is in the default sub-actor allowlist; the chip
     * should render with the active styling. We assert via the
     * data-testid the panel attaches to each checkbox row.
     */
    await expect(page.getByTestId('file-intent-sub-actor-code-author')).toBeVisible();
    await expect(page.getByTestId('file-intent-sub-actor-auditor-actor')).toBeVisible();
    await expect(page.getByTestId('file-intent-submit')).toBeDisabled();
  });

  test('enables submit once a valid request is typed', async ({ page }) => {
    await page.goto('/file-intent');
    const textarea = page.getByTestId('file-intent-request');
    await textarea.fill('Add a TODO badge to the plans header');
    await expect(page.getByTestId('file-intent-submit')).toBeEnabled();
  });

  test('shows inline error for empty / too-short request after blur', async ({ page }) => {
    await page.goto('/file-intent');
    const textarea = page.getByTestId('file-intent-request');
    /*
     * Type then clear so the inline-error renderer has something to
     * trigger on (the panel validates on every change, so a fresh
     * empty doesn't fire until the operator interacts with the field).
     */
    await textarea.fill('A');
    await expect(page.getByTestId('file-intent-request-error')).toBeVisible();
    /*
     * Clearing also produces an error -- the "too short" branch
     * collapses into the "describe the intent" branch when the field
     * is empty.
     */
    await textarea.fill('');
    await expect(page.getByTestId('file-intent-request-error')).toBeVisible();
    await expect(page.getByTestId('file-intent-submit')).toBeDisabled();
  });

  test('updates the confidence value chip when the slider moves', async ({ page }) => {
    await page.goto('/file-intent');
    const chip = page.getByTestId('file-intent-confidence-value');
    await expect(chip).toHaveText('0.75');
    /*
     * Use keyboard navigation on the slider instead of setting
     * value directly -- this exercises the same code path a real
     * operator would (a tap + drag emits the same change events as
     * keypresses on the native range input).
     */
    await page.getByTestId('file-intent-confidence').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    // 0.75 + 2 * 0.05 = 0.85
    await expect(chip).toHaveText('0.85');
  });

  test('toggles a sub-actor checkbox on click', async ({ page }) => {
    await page.goto('/file-intent');
    /*
     * auditor-actor starts unchecked (default sub-actor set is
     * ['code-author']). Click once to add it; the underlying input
     * MUST register checked=true. Click again to remove; the input
     * MUST register checked=false. Asserting on the input's
     * checked-state (rather than just clicking without an assertion)
     * is the difference between testing "does the click event fire"
     * vs "does the click event actually update the form state" --
     * a future refactor that breaks the controlled-component wiring
     * would silently slip past a click-only assertion.
     */
    const auditorPill = page.getByTestId('file-intent-sub-actor-auditor-actor');
    const auditorInput = auditorPill.locator('input[type="checkbox"]');
    await expect(auditorInput).not.toBeChecked();

    await auditorPill.click();
    await expect(auditorInput).toBeChecked();

    await auditorPill.click();
    await expect(auditorInput).not.toBeChecked();
  });

  test('every interactive control meets the 44px tap-target floor on mobile', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/file-intent');
    await expect(page.getByTestId('file-intent-view')).toBeVisible();

    /*
     * Per canon `dev-web-mobile-first-required`, every interactive
     * control needs a 44 CSS-pixel minimum tap target. We measure
     * each form control individually rather than relying on a CSS
     * inspection so a regression to a smaller pill / button surfaces
     * here instead of in production.
     */
    const targets = [
      'file-intent-scope',
      'file-intent-blast-radius',
      'file-intent-sub-actor-code-author',
      'file-intent-sub-actor-auditor-actor',
      'file-intent-expires',
      'file-intent-trigger-toggle',
      'file-intent-submit',
    ];
    for (const tid of targets) {
      const el = page.getByTestId(tid);
      await expect(el).toBeVisible();
      const box = await el.boundingBox();
      expect(box, `${tid} must be in the layout flow`).not.toBeNull();
      expect(box!.height, `${tid} height ${box!.height} < 44px floor`).toBeGreaterThanOrEqual(44);
    }
  });

  test('no horizontal scroll at the iPhone-13 viewport', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/file-intent');
    await expect(page.getByTestId('file-intent-view')).toBeVisible();

    /*
     * iPhone 13 is 390 CSS px wide. Horizontal scroll on mobile is a
     * substrate violation (`dev-web-mobile-first-required` says
     * "horizontal scroll on mobile width <=400px is always a bug").
     */
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll, `horizontal overflow: scroll=${overflow.scroll} client=${overflow.client}`)
      .toBeLessThanOrEqual(overflow.client);
  });

  test('form fields stack single-column at the iPhone-13 viewport', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
    await page.goto('/file-intent');
    await expect(page.getByTestId('file-intent-form')).toBeVisible();

    /*
     * Scope + blast-radius live in the same form row that becomes a
     * 2-column grid above 36rem. On 390px iPhone-13 width the grid
     * collapses to a single column; we assert the bounding boxes
     * stack vertically (no two controls share the same row).
     */
    const scopeBox = await page.getByTestId('file-intent-scope').boundingBox();
    const radiusBox = await page.getByTestId('file-intent-blast-radius').boundingBox();
    expect(scopeBox).not.toBeNull();
    expect(radiusBox).not.toBeNull();
    /*
     * Stack assertion: radius top must be strictly below scope's
     * BOTTOM edge. A "y > y" check would still pass on overlap.
     */
    expect(radiusBox!.y, 'blast-radius must stack below scope on mobile')
      .toBeGreaterThanOrEqual(scopeBox!.y + scopeBox!.height);
  });

  test('submission surfaces the read-only error when console writes are disabled', async ({ page }) => {
    /*
     * Default install: LAG_CONSOLE_ALLOW_WRITES is unset, so the
     * backend returns 403 `console-read-only`. The form's error
     * surface should render the message verbatim so the operator
     * sees the gate inline rather than via a silent network failure.
     *
     * When LAG_CONSOLE_ALLOW_WRITES=1 is set in the harness env (a
     * write-enabled CI lane), this test skips because the success
     * path is the right green-state -- it's covered by the
     * "shows success toast on a write-enabled run" branch below.
     */
    await page.goto('/file-intent');
    const textarea = page.getByTestId('file-intent-request');
    await textarea.fill('Add a TODO badge to the plans header');

    await page.getByTestId('file-intent-submit').click();

    /*
     * Wait for either the error OR the toast to appear. Whichever
     * lands first tells us which environment we are in:
     *   - error  -> console writes disabled (default)
     *   - toast  -> console writes enabled
     */
    const errorOrToast = page.getByTestId('file-intent-error').or(page.getByTestId('file-intent-toast'));
    await expect(errorOrToast).toBeVisible({ timeout: 10_000 });

    /*
     * Branch-specific assertions: the spec covers BOTH lanes so a
     * change to the env contract (e.g. enabling writes in CI) does
     * not silently degrade test coverage to "test passed because UI
     * appeared somehow". Each branch asserts the contract that lane
     * is supposed to honor.
     */
    const errorCount = await page.getByTestId('file-intent-error').count();
    if (errorCount > 0) {
      /*
       * Read-only lane: the error message must point at the
       * console-read-only gate so a regression that silently widens
       * the surface (and hands the operator a generic 500) is caught.
       */
      const errorText = await page.getByTestId('file-intent-error').innerText();
      expect(errorText.toLowerCase()).toContain('console');
    } else {
      /*
       * Write-enabled lane: the toast must surface a real intent id
       * (matching the substrate's intent-<nonce>-<iso> shape) AND a
       * "View intent" action that routes to the atom-detail viewer.
       * A bare "Intent filed" without the id or the action would
       * regress the success UX -- the operator's next step is to
       * inspect the atom, so the link is the load-bearing affordance.
       */
      const toast = page.getByTestId('file-intent-toast');
      await expect(toast).toBeVisible();
      const intentIdEl = page.getByTestId('file-intent-toast-id');
      await expect(intentIdEl).toBeVisible();
      const intentId = await intentIdEl.innerText();
      expect(intentId, 'toast must show a real intent id').toMatch(/^intent-/);
      const viewBtn = page.getByTestId('file-intent-toast-view');
      await expect(viewBtn).toBeVisible();
      await expect(viewBtn).toHaveText(/view intent/i);
    }
  });
});
