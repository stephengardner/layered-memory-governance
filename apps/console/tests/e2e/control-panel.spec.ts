import { test, expect } from '@playwright/test';

/**
 * Operator Control Panel e2e.
 *
 * Covers the contract the feature makes:
 *   1. /control route loads (sidebar link + direct URL).
 *   2. Hero card renders kill-switch state (engaged or not-engaged).
 *   3. Tier banner renders with one of soft|medium|hard.
 *   4. All four metric tiles render with non-empty values.
 *   5. The "Engage Kill Switch" button opens the confirmation
 *      dialog -- and the dialog presents the manual `touch` command,
 *      NOT a button that writes the sentinel.
 *
 * Per canon `dev-web-playwright-coverage-required`, every feature
 * ships with at least one Playwright e2e. This spec is that minimum
 * for the Operator Control Panel.
 */

test.describe('operator control panel', () => {
  test('navigates to /control via sidebar and renders the panel', async ({ page }) => {
    await page.goto('/');
    /*
     * The control link is operator-critical, so we verify both that
     * the sidebar entry exists AND that clicking it routes to the
     * panel. data-testid="nav-control" is the sidebar item; the
     * panel itself surfaces via data-testid="control-panel".
     */
    const navControl = page.getByTestId('nav-control');
    await expect(navControl).toBeVisible();
    await navControl.click();
    await expect(page).toHaveURL(/\/control$/);
    await expect(page.getByTestId('control-panel')).toBeVisible({ timeout: 10_000 });
  });

  test('hero card surfaces the kill-switch state', async ({ page }) => {
    await page.goto('/control');
    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible({ timeout: 10_000 });
    /*
     * The fixture .lag/STOP file may or may not be present; both
     * states are valid. We assert the title is one of the two known
     * copy variants and that the data-engaged attribute is a
     * boolean string ("true" or "false").
     */
    const titleText = (await page.getByTestId('control-kill-switch-title').innerText()).trim();
    expect(['Engaged', 'Not engaged']).toContain(titleText);
    const engagedAttr = await hero.getAttribute('data-engaged');
    expect(['true', 'false']).toContain(engagedAttr);
  });

  test('tier banner renders one of the three known autonomy tiers', async ({ page }) => {
    await page.goto('/control');
    const banner = page.getByTestId('control-tier-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const tier = await banner.getAttribute('data-tier');
    expect(['soft', 'medium', 'hard']).toContain(tier);
    /*
     * Tier badge mirrors the data-tier; confirm at least one of the
     * three known badges is visible (the active one) so the operator-
     * facing copy stays in sync with the data attribute.
     */
    const activeBadge = page.getByTestId(`control-tier-${tier}`);
    await expect(activeBadge).toBeVisible();
  });

  test('all four metric tiles render with non-empty values', async ({ page }) => {
    await page.goto('/control');
    await page.getByTestId('control-metrics').waitFor({ timeout: 10_000 });
    const ids = [
      'control-metric-actors',
      'control-metric-policies',
      'control-metric-canon',
      'control-metric-operator',
    ];
    for (const id of ids) {
      const tile = page.getByTestId(id);
      await expect(tile).toBeVisible();
      const valueText = (await page.getByTestId(`${id}-value`).innerText()).trim();
      expect(valueText.length).toBeGreaterThan(0);
    }
    /*
     * Sanity check: the actors metric should be a non-negative integer
     * in the dogfooded fixture (we always have at least one governed
     * actor). This catches a broken handler that returns "" or "NaN".
     */
    const actorsValue = (await page.getByTestId('control-metric-actors-value').innerText()).trim();
    expect(actorsValue).toMatch(/^\d+$/);
  });

  test('engage button opens the confirmation dialog with the manual touch command', async ({ page }) => {
    /*
     * Read-only-contract negative assertion is the load-bearing point
     * of this test: the dialog MUST NOT offer a button that writes the
     * sentinel. A short-circuit on `engageButton.isDisabled()` would
     * silently skip the assertion whenever the dogfood fixture has
     * .lag/STOP present, so we stub the backend response to force
     * `kill_switch.engaged: false` regardless of fixture state. This
     * is lighter than mutating .lag/STOP on disk (no afterEach
     * cleanup) and isolates the test from concurrent operator
     * activity in the dogfood worktree.
     *
     * The transport envelope is `{ ok: true, data: T }` (see
     * apps/console/src/services/transport/http.ts); the stubbed body
     * mirrors the live ControlStatus shape so the React view renders
     * the not-engaged path with all four metric tiles populated.
     */
    await page.route('**/api/control.status', async (route) => {
      const body = {
        ok: true,
        data: {
          kill_switch: {
            engaged: false,
            sentinel_path: '.lag/STOP',
            engaged_at: null,
          },
          autonomy_tier: 'soft',
          actors_governed: 7,
          policies_active: 12,
          last_canon_apply: '2026-04-26T00:00:00.000Z',
          operator_principal_id: 'apex-operator',
        },
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    await page.goto('/control');
    const engageButton = page.getByTestId('control-engage-button');
    await expect(engageButton).toBeVisible({ timeout: 10_000 });
    await expect(engageButton).toBeEnabled();
    await engageButton.click();
    const dialog = page.getByTestId('control-engage-dialog');
    await expect(dialog).toBeVisible();
    /*
     * The dialog MUST present a manual `touch .lag/STOP` command and
     * MUST NOT offer a UI "really engage" button that writes the
     * sentinel. This is the read-only contract.
     */
    const command = page.getByTestId('control-engage-command');
    await expect(command).toBeVisible();
    const commandText = (await command.innerText()).trim();
    expect(commandText).toContain('touch');
    expect(commandText).toContain('.lag/STOP');
    /*
     * Negative assertion: there is exactly one button in the dialog
     * (Close). A "Confirm engage" or similar would violate the v1
     * read-only contract.
     */
    const dialogButtons = dialog.locator('button');
    await expect(dialogButtons).toHaveCount(1);
    /*
     * a11y: Escape dismisses the dialog; scrim click dismisses too.
     * Operator-critical surfaces follow the standard modal contract.
     */
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await engageButton.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('control-engage-dialog-scrim').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toBeHidden();
    await engageButton.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('control-engage-dialog-close').click();
    await expect(dialog).toBeHidden();
  });
});
