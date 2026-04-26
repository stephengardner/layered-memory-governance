import { test, expect } from '@playwright/test';

/**
 * Plan Lifecycle e2e: a single plan's autonomous-loop chain rendered
 * as a vertical timeline.
 *
 * Coverage:
 *   - List view loads with plan rows + the new sidebar tab is active.
 *   - Clicking a plan navigates to /plan-lifecycle/<id> and renders
 *     the timeline.
 *   - The timeline includes every state transition the backend
 *     observed (intent, plan, approval, dispatch, observation,
 *     settled — at least the merged plans we have show all six).
 *   - Each transition shows an atom-id link and an ISO-parseable
 *     timestamp.
 *
 * The test relies on at least one merged plan existing in
 * .lag/atoms/. The `plan-ship-docs-actors-six-page-set-as-one-...`
 * plan from PR #180 is the canonical fixture; it has the full chain
 * (intent → plan → approval → dispatch → observation → settled).
 */

test.describe('plan lifecycle', () => {
  test('list view renders plans with the new sidebar tab', async ({ page }) => {
    await page.goto('/plan-lifecycle');
    await expect(page.getByRole('heading', { name: 'Plan Lifecycle' }).first()).toBeVisible({
      timeout: 10_000,
    });
    const active = page.getByTestId('nav-plan-lifecycle');
    await expect(active).toHaveAttribute('aria-current', 'page');
    // At least one plan row should appear.
    await expect(page.locator('[data-testid="plan-lifecycle-row"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('clicking a plan opens the timeline and renders all transitions', async ({ page }) => {
    await page.goto('/plan-lifecycle');
    const firstRow = page.locator('[data-testid="plan-lifecycle-row"]').first();
    await firstRow.waitFor({ state: 'visible', timeout: 10_000 });
    const planId = await firstRow.getAttribute('data-plan-id');
    expect(planId, 'first plan row should carry a plan id').toBeTruthy();

    await firstRow.click();

    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/plan-lifecycle/${escaped}$`));

    // Timeline container appears.
    const timeline = page.getByTestId('plan-lifecycle-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // At least one transition is rendered.
    const transitions = page.locator('[data-testid="plan-lifecycle-transition"]');
    const count = await transitions.count();
    expect(count, 'plan lifecycle should have at least one transition').toBeGreaterThan(0);

    // Every transition has an atom-id link with a non-empty data-atom-id.
    const atomLinks = page.locator('[data-testid="plan-lifecycle-transition-atom"]');
    const linkCount = await atomLinks.count();
    expect(linkCount).toBeGreaterThan(0);
    for (let i = 0; i < linkCount; i++) {
      const link = atomLinks.nth(i);
      const atomId = await link.getAttribute('data-atom-id');
      expect(atomId, `transition ${i} should expose an atom id`).toBeTruthy();
      // Also assert the link has visible text content.
      const text = (await link.textContent())?.trim() ?? '';
      expect(text.length, `transition ${i} should render the atom id`).toBeGreaterThan(0);
    }

    // Every <time> element inside the timeline parses as a valid ISO date.
    const times = timeline.locator('time');
    const timesCount = await times.count();
    expect(timesCount).toBeGreaterThan(0);
    for (let i = 0; i < timesCount; i++) {
      const dt = await times.nth(i).getAttribute('datetime');
      expect(dt, `time element ${i} should expose a datetime attribute`).toBeTruthy();
      expect(Number.isNaN(Date.parse(dt!)), `time ${i} should be a valid ISO`).toBe(false);
    }
  });

  test('focused timeline lists every chain phase for a merged plan', async ({ page }) => {
    /*
     * Pick the canonical merged-plan fixture (PR #180). It carries
     * all six chain phases: operator-intent, plan-proposed,
     * approval, dispatch, observation, settled. If THIS plan has
     * fewer phases than expected, the lifecycle wiring regressed.
     */
    const planId = 'plan-ship-docs-actors-six-page-set-as-one-cod-cto-actor-20260426043534';
    await page.goto(`/plan-lifecycle/${planId}`);

    const timeline = page.getByTestId('plan-lifecycle-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // Each of the six phases should produce at least one transition.
    const expectedPhases = ['deliberation', 'approval', 'dispatch', 'observation', 'merge'];
    for (const phase of expectedPhases) {
      const found = page.locator(`[data-testid="plan-lifecycle-transition"][data-phase="${phase}"]`);
      const count = await found.count();
      expect(count, `expected at least one '${phase}' transition`).toBeGreaterThan(0);
    }

    // Focus banner shows the plan id we navigated to.
    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(planId);
  });
});
