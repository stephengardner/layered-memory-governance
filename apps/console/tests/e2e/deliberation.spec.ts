import { test, expect } from '@playwright/test';

/**
 * Deliberation Trail e2e: surface the planner's reasoning trail
 * (alternatives weighed, principles applied, canon cited) for every
 * plan atom that carries deliberation metadata.
 *
 * Coverage:
 *   - List view loads with at least one card and the new sidebar tab
 *     is active.
 *   - Clicking a card navigates to /deliberation/<plan-id> and
 *     renders the detail trail.
 *   - The detail view renders the "Alternatives considered" and
 *     "Citations" sections (assertion picks a data-aware target with
 *     both counts > 0; principles are exercised by unit tests).
 *
 * The test relies on at least one plan atom in `.lag/atoms/` carrying
 * either `metadata.alternatives_rejected`, `metadata.principles_applied`,
 * or `provenance.derived_from`. Plans this org generates carry all
 * three; a fresh atom store with no plans is correctly handled by
 * skip-on-empty.
 */
test.describe('deliberation trail', () => {
  test('list view renders cards and the new sidebar tab is active', async ({ page }) => {
    await page.goto('/deliberation');
    // The sidebar tab activates immediately on route resolution, even
    // before the plans query settles, so it's the right invariant to
    // assert before branching on data.
    const active = page.getByTestId('nav-deliberation');
    await expect(active).toHaveAttribute('aria-current', 'page');

    // The view either renders the populated hero + cards or the empty
    // state. Both are acceptable; the assertion is that ONE of them
    // settles (the loading spinner does not stay forever).
    const firstCard = page.locator('[data-testid="deliberation-card"]').first();
    const empty = page.getByTestId('deliberation-empty');
    await Promise.race([
      firstCard.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);
    test.skip(
      await empty.isVisible(),
      'no plans with deliberation metadata in atom store; this test requires at least one',
    );
    await expect(page.getByRole('heading', { name: 'Deliberation Trail' })).toBeVisible();
    await expect(firstCard).toBeVisible();
  });

  test('clicking a card opens the trail with section headers', async ({ page }) => {
    await page.goto('/deliberation');

    const firstCard = page.locator('[data-testid="deliberation-card"]').first();
    const empty = page.getByTestId('deliberation-empty');
    await Promise.race([
      firstCard.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);
    test.skip(
      await empty.isVisible(),
      'no plans with deliberation metadata in atom store; cannot exercise detail view',
    );

    // listDeliberations keeps a plan if it has ANY of alternatives /
    // citations / principles, so the recency-first card may carry just
    // one of those. The detail asserts below need both alternatives AND
    // citations rendered, so pick a data-aware target: the first card
    // whose data-* counts say it carries both. If none match (atom store
    // has plans with only one signal each), skip rather than fail with
    // a misleading "section missing" diff.
    const allCards = page.locator('[data-testid="deliberation-card"]');
    const cardCount = await allCards.count();
    let target: ReturnType<typeof page.locator> | null = null;
    for (let i = 0; i < cardCount; i++) {
      const c = allCards.nth(i);
      const altRaw = await c.getAttribute('data-alternatives-count');
      const citRaw = await c.getAttribute('data-citations-count');
      const alt = Number.parseInt(altRaw ?? '0', 10);
      const cit = Number.parseInt(citRaw ?? '0', 10);
      if (alt > 0 && cit > 0) {
        target = c;
        break;
      }
    }
    test.skip(
      target === null,
      'no plan carries both alternatives and citations; detail-section assertion needs both',
    );

    const planId = await target!.getAttribute('data-plan-id');
    expect(planId, 'target card should carry a plan id').toBeTruthy();
    await target!.click();

    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/deliberation/${escaped}$`));

    // Focus banner shows the plan id we navigated to.
    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(planId!);

    // Top-level deliberation sections render.
    await expect(page.getByTestId('deliberation-alternatives')).toBeVisible();
    await expect(page.getByTestId('deliberation-citations')).toBeVisible();
    // Section heading text is present.
    await expect(
      page.getByRole('heading', { name: 'Alternatives considered' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Citations' })).toBeVisible();
  });
});
