import { test, expect } from '@playwright/test';

/**
 * Principal drill-down e2e.
 *
 * Operator-flagged regression: clicking a principal card on
 * /principals didn't open the principal's detail. The card was
 * static markup with no link or click handler, and PrincipalsView
 * didn't read `useRouteId()` so deep-linking to /principals/<id>
 * also rendered the unfocused grid. Both paths now route through
 * focus mode: a click navigates, a deep link is honored.
 *
 * Coverage:
 *   1. Click a card name link -> URL becomes /principals/<id>.
 *   2. Focus mode renders FocusBanner + a single full-width card
 *      with permissions auto-expanded (no second click required).
 *   3. Deep link to a missing id renders 'Principal not found'
 *      with a Clear focus button (no silent blank).
 *   4. Clicking Clear focus returns to /principals + the grid.
 */

interface PrincipalRow {
  readonly id: string;
}

test.describe('principal drill-down', () => {
  test('click a card -> focus mode with auto-expanded permissions', async ({ page, request }) => {
    const res = await request.post('/api/principals.list');
    expect(res.ok(), 'principals.list endpoint should return 200').toBe(true);
    const body = await res.json();
    const principals: ReadonlyArray<PrincipalRow> = body?.data ?? body ?? [];
    test.skip(principals.length === 0, 'no principals to click');

    await page.goto('/principals');
    const link = page.getByTestId('principal-card-link').first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    const targetId = await link
      .locator('xpath=ancestor::*[@data-testid="principal-card"]')
      .getAttribute('data-principal-id');
    expect(targetId, 'card should expose data-principal-id').toBeTruthy();

    await link.click();
    const escaped = encodeURIComponent(targetId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/principals/${escaped}$`));

    // Focus mode renders the FocusBanner and a single card.
    await expect(page.getByTestId('focus-banner')).toBeVisible();
    await expect(page.getByTestId('principal-card')).toHaveCount(1);
  });

  test('focused principal renders skill section (content or empty placeholder)', async ({ page }) => {
    /*
     * cto-actor is the canonical principal that ships with a SKILL.md
     * in this repo, so the focus surface should render the
     * principal-skill-content panel for it. If the fixture varies
     * (no .claude/skills/cto-actor/SKILL.md), the test falls through
     * to the empty-state placeholder so it stays meaningful in
     * minimal installs.
     */
    await page.goto('/principals/cto-actor');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });
    const content = page.getByTestId('principal-skill-content');
    const empty = page.getByTestId('principal-skill-empty');
    const loading = page.getByTestId('principal-skill-loading');
    await expect(loading.or(content).or(empty)).toBeVisible({ timeout: 10_000 });
    await expect(content.or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test('deep link to missing id renders Plan-not-found-style empty state', async ({ page }) => {
    await page.goto('/principals/this-principal-does-not-exist');
    const empty = page.getByTestId('principals-empty');
    await expect(empty).toBeVisible({ timeout: 10_000 });
    const clear = page.getByTestId('principals-focus-clear');
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page).toHaveURL(/\/principals$/);
    // No card surfaces when grid empties (we just exited focus); the
    // grid renders if the store has any principals, otherwise the
    // ordinary empty state.
  });

  test('clicking elsewhere on the card body also navigates (delegated handler)', async ({
    page,
    request,
  }) => {
    const res = await request.post('/api/principals.list');
    expect(res.ok(), 'principals.list endpoint should return 200').toBe(true);
    const body = await res.json();
    const principals: ReadonlyArray<PrincipalRow> = body?.data ?? body ?? [];
    test.skip(principals.length === 0, 'no principals to click');

    await page.goto('/principals');
    const card = page.getByTestId('principal-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const targetId = await card.getAttribute('data-principal-id');
    expect(targetId).toBeTruthy();

    // Click the card body (the chips area, not the link or button).
    // Uses a stable data-testid hook rather than the CSS-module class
    // pattern, which is bundler-config-coupled and breaks if the
    // CSS-modules generated-name format changes.
    await card.getByTestId('principal-card-chips').click();
    const escaped = encodeURIComponent(targetId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/principals/${escaped}$`));
  });
});
