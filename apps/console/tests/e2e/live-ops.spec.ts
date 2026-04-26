import { test, expect } from '@playwright/test';

/**
 * Live Ops e2e -- the "what is the org doing right now" dashboard.
 *
 * Coverage:
 *   - /live-ops navigates and renders the page header + at least one
 *     tile (heartbeat is always present, even on an empty store).
 *   - Sidebar nav entry is the active item.
 *   - Auto-refresh fires on the 2s cadence (the snapshot timestamp
 *     advances between two reads).
 *   - Every section renders gracefully against the live store: no
 *     unhandled console errors, no JSON parse failures.
 *   - The pulse indicator is present and reflects fetching state.
 */

test.describe('live ops', () => {
  test('/live-ops navigates and renders the heartbeat tile + active sidebar', async ({ page }) => {
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    /*
     * Heartbeat is always rendered -- its body is just three numeric
     * stats that fall back to 0 on an empty store, never null. So it
     * is the cheapest sentinel for "the page mounted and the snapshot
     * round-tripped successfully."
     */
    await expect(page.getByTestId('live-ops-heartbeat')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-ops-heartbeat-60s')).toBeVisible();
    await expect(page.getByTestId('live-ops-heartbeat-5m')).toBeVisible();
    await expect(page.getByTestId('live-ops-heartbeat-1h')).toBeVisible();

    const active = page.getByTestId('nav-live-ops');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('all expected tiles render against the live atom store', async ({ page }) => {
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    /*
     * Every section either renders data or its empty state. The page
     * MUST never crash on a section's missing data; this test asserts
     * every tile reaches a terminal "rendered" state within the
     * standard timeout.
     */
    await expect(page.getByTestId('live-ops-posture')).toBeVisible();
    await expect(page.getByTestId('live-ops-active-sessions')).toBeVisible();
    await expect(page.getByTestId('live-ops-deliberations')).toBeVisible();
    await expect(page.getByTestId('live-ops-in-flight')).toBeVisible();
    await expect(page.getByTestId('live-ops-transitions')).toBeVisible();
    await expect(page.getByTestId('live-ops-pr-activity')).toBeVisible();
  });

  test('auto-refresh advances the snapshot timestamp between reads', async ({ page }) => {
    /*
     * The pulse indicator carries an "As of <clock>" label that re-
     * computes on every successful refetch. After 2.5s (one full
     * refresh cycle plus jitter) the label MUST have advanced. This
     * is the closest the e2e gets to asserting refetchInterval works
     * end-to-end without hooking into TanStack internals.
     */
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    const pulse = page.getByTestId('live-ops-pulse');
    await expect(pulse).toBeVisible();
    const before = await pulse.innerText();
    await page.waitForTimeout(2_500);
    const after = await pulse.innerText();
    /*
     * The clock format is HH:MM:SS so a 2.5s wait gives the seconds
     * field at least one tick to roll. Allow text equality only when
     * we genuinely missed a refresh -- the failure message helps
     * diagnose flake from a cold-start network stall.
     */
    expect(after, `pulse label should have advanced after a refresh cycle (was=${before}, now=${after})`)
      .not.toBe(before);
  });

  test('renders without console JSON parse errors', async ({ page }) => {
    /*
     * Catches the historical "Cannot read undefined" / "JSON.parse"
     * failure modes that hit when a section's data shape changes.
     * The page MUST stay clean on the live store. Filter out
     * webpack/HMR notices that aren't real errors.
     */
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const txt = msg.text();
      if (txt.includes('[HMR]')) return;
      errors.push(txt);
    });
    page.on('pageerror', (err) => {
      errors.push(`pageerror: ${err.message}`);
    });
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-ops-heartbeat')).toBeVisible();
    // Allow the first refetch to complete so any error in the live
    // path also surfaces.
    await page.waitForTimeout(2_500);
    expect(errors, `unexpected console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('clicking a deliberation row navigates to plan-lifecycle when present', async ({ page }) => {
    /*
     * Deliberation list may be empty on a clean store; assert the
     * navigation contract WHEN proposed plans exist. Skip otherwise
     * so the test doesn't flap on store state.
     */
    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    const list = page.getByTestId('live-ops-deliberations-list');
    const empty = page.getByTestId('live-ops-deliberations-empty');
    await Promise.race([
      list.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);
    test.skip(
      await empty.isVisible(),
      'no proposed plans in the atom store; deliberation-row navigation cannot be exercised',
    );

    const firstRow = page.locator('[data-testid="live-ops-deliberation-row"]').first();
    await expect(firstRow).toBeVisible();
    const planId = await firstRow.getAttribute('data-plan-id');
    expect(planId, 'deliberation row should expose data-plan-id').toBeTruthy();
    const link = firstRow.locator('a').first();
    await link.click();
    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/plan-lifecycle/${escaped}$`));
  });
});
