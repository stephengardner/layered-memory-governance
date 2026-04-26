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
 *   6. Color semantics: default state (engaged=false, tier=soft)
 *      renders the hero in NEUTRAL tone, NOT danger. Engaged state
 *      renders danger. (2026-04-26 operator feedback: the panel
 *      should not look like an alarm in its healthy default.)
 *   7. Info-density sections render: active elevations, recent
 *      kill-switch transitions, recent operator actions, recent
 *      escalations.
 *   8. Mobile viewport (iPhone-13 project) renders without
 *      horizontal overflow.
 *
 * Per canon `dev-web-playwright-coverage-required`, every feature
 * ships with at least one Playwright e2e. This spec is that minimum
 * for the Operator Control Panel.
 */

/*
 * Shared stub builder. The dogfood fixture's atom set varies between
 * sessions, so deterministic UI assertions need a stubbed transport
 * response. Each test that asserts specific copy/colors composes its
 * own stub on top of this base.
 */
function stubControlStatus(
  base: {
    readonly engaged?: boolean;
    readonly autonomy_tier?: 'soft' | 'medium' | 'hard';
    readonly with_lists?: boolean;
  } = {},
) {
  const engaged = base.engaged ?? false;
  const autonomy_tier = base.autonomy_tier ?? 'soft';
  const withLists = base.with_lists ?? false;
  return {
    ok: true,
    data: {
      kill_switch: {
        engaged,
        sentinel_path: '.lag/STOP',
        engaged_at: engaged ? '2026-04-26T11:00:00.000Z' : null,
      },
      autonomy_tier,
      actors_governed: 7,
      policies_active: 12,
      last_canon_apply: '2026-04-26T00:00:00.000Z',
      operator_principal_id: 'apex-operator',
      recent_kill_switch_transitions: withLists
        ? [
            {
              tier: 'soft',
              at: '2026-04-26T10:00:00.000Z',
              transitioned_by: 'lag-ceo',
              reason: null,
            },
          ]
        : [],
      active_elevations: withLists
        ? [
            {
              atom_id: 'pol-cto-temp-self-approve-2026-04-26-08h',
              policy_target: 'plan-approve',
              principal: 'cto-actor',
              started_at: '2026-04-26T10:10:53.000Z',
              expires_at: '2099-12-31T00:00:00.000Z',
              time_remaining_seconds: 999_999,
            },
          ]
        : [],
      recent_operator_actions: withLists
        ? [
            {
              atom_id: 'op-action-lag-ceo-test',
              principal_id: 'lag-ceo',
              kind: 'api',
              at: '2026-04-26T11:28:00.000Z',
            },
          ]
        : [],
      recent_escalations: withLists
        ? [
            {
              atom_id: 'dispatch-escalation-test',
              at: '2026-04-26T02:00:00.000Z',
              headline: 'Sub-actor dispatch failed for plan-x.',
            },
          ]
        : [],
    },
  };
}

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

  test('default state renders neutral tone, NOT danger', async ({ page }) => {
    /*
     * Operator feedback 2026-04-26: the v1 hero rendered in red on
     * the healthy default (kill-switch off + tier=soft). This
     * regression guard pins the contract: the hero data-tone
     * attribute MUST be "neutral" when engaged=false and tier=soft.
     * If a future change re-introduces the alarming default, this
     * fails loudly.
     */
    await page.route('**/api/control.status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubControlStatus({ engaged: false, autonomy_tier: 'soft' })),
      });
    });
    await page.goto('/control');
    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible({ timeout: 10_000 });
    await expect(hero).toHaveAttribute('data-tone', 'neutral');
    await expect(hero).toHaveAttribute('data-engaged', 'false');
    /*
     * Plain-English caption explicitly tells the operator the system
     * is healthy. This is the second half of the fix: don't make the
     * operator infer health from the absence of red.
     */
    const captionText = (await page.getByTestId('control-kill-switch-caption').innerText()).trim();
    expect(captionText).toMatch(/running normally/i);
  });

  test('engaged state renders danger tone', async ({ page }) => {
    /*
     * Mirror of the previous test: when the kill switch IS engaged,
     * the hero MUST be in danger tone. The two assertions together
     * pin both ends of the color-semantics contract.
     */
    await page.route('**/api/control.status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubControlStatus({ engaged: true, autonomy_tier: 'soft' })),
      });
    });
    await page.goto('/control');
    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible({ timeout: 10_000 });
    await expect(hero).toHaveAttribute('data-tone', 'danger');
    await expect(hero).toHaveAttribute('data-engaged', 'true');
    const captionText = (await page.getByTestId('control-kill-switch-caption').innerText()).trim();
    expect(captionText).toMatch(/Kill switch engaged/i);
  });

  test('renders info-density sections with stubbed list contents', async ({ page }) => {
    /*
     * The four richer sections each render at least one row when the
     * stubbed payload includes one. The combined assertion answers
     * "did the new payload shape wire through end-to-end?" without
     * pinning the exact dogfood-fixture contents.
     */
    await page.route('**/api/control.status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubControlStatus({ with_lists: true })),
      });
    });
    await page.goto('/control');
    await expect(page.getByTestId('control-active-elevations')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('control-kill-switch-history')).toBeVisible();
    await expect(page.getByTestId('control-operator-actions')).toBeVisible();
    await expect(page.getByTestId('control-escalations')).toBeVisible();
    /*
     * At least one row in each section. The active elevations row
     * specifically surfaces the policy_target and the countdown so
     * the operator can read both without expanding.
     */
    await expect(page.getByTestId('control-elevation-row')).toHaveCount(1);
    await expect(page.getByTestId('control-history-row')).toHaveCount(1);
    await expect(page.getByTestId('control-action-row')).toHaveCount(1);
    await expect(page.getByTestId('control-escalation-row')).toHaveCount(1);
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubControlStatus({ engaged: false, autonomy_tier: 'soft' })),
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
    /*
     * Scrim-click dismisses the dialog. We dispatch the click via the
     * scrim's onclick handler directly (page.evaluate) so the
     * assertion is layout-independent: the dialog itself reaches the
     * edges of the scrim's content area on narrow viewports
     * (iPhone-13: 390px wide), and a Playwright click at the scrim
     * box corner can be intercepted by the html backdrop because of
     * the backdrop-filter stacking context. The contract under test
     * is "the scrim's click handler closes the dialog"; firing the
     * onClick is the load-bearing assertion, not the pointer-event
     * routing.
     */
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="control-engage-dialog-scrim"]') as HTMLElement | null;
      el?.click();
    });
    await expect(dialog).toBeHidden();
    await engageButton.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('control-engage-dialog-close').click();
    await expect(dialog).toBeHidden();
  });

  test('mobile viewport renders without horizontal overflow', async ({ page }) => {
    /*
     * iPhone-13 viewport is 390x844; the panel MUST fit the inner
     * viewport without horizontal overflow. We stub the response so
     * the assertion is deterministic regardless of dogfood-fixture
     * variability.
     *
     * The check compares document scrollWidth to clientWidth: if the
     * hero or any list row overflows, scrollWidth exceeds clientWidth
     * and the assertion fails. This is the load-bearing mobile-fit
     * test for the control panel.
     *
     * We explicitly pin the viewport here so the assertion is
     * self-contained: it exercises the 390x844 contract regardless
     * of which Playwright project (chromium desktop, mobile, etc.)
     * runs the test, instead of relying on an external `mobile`
     * project to enforce the constraint.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/control.status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubControlStatus({ with_lists: true })),
      });
    });
    await page.goto('/control');
    await expect(page.getByTestId('control-kill-switch')).toBeVisible({ timeout: 10_000 });
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const sw = Math.max(root.scrollWidth, body.scrollWidth);
      const cw = Math.max(root.clientWidth, body.clientWidth);
      return { scrollWidth: sw, clientWidth: cw, diff: sw - cw };
    });
    /*
     * Allow a 1px slop for sub-pixel rounding; anything beyond is a
     * real overflow that mangles the layout on a 390px-wide phone.
     */
    expect(overflow.diff).toBeLessThanOrEqual(1);
  });
});
