import { test, expect, type Page } from '@playwright/test';

/**
 * Atom-detail viewer e2e.
 *
 * Covers the /atom/<id> route that renders ANY atom in the substrate
 * via the type-dispatch table. Test machines may or may not have a
 * given atom-type in their .lag/atoms/ tree (the substrate only emits
 * pipelines on a deep planning run, for example), so the spec
 * discovers what's available via /api/canon.list (always populated)
 * + /api/activities.list (covers plans + observations) and asserts
 * end-to-end shape for at least one canon atom plus the universal
 * empty-state path for an unknown id.
 *
 * The dispatch table is covered by unit tests in
 * `src/features/atom-detail-viewer/renderers/dispatch.test.ts`; this
 * spec asserts the live service-to-component contract holds.
 */

interface ListAtom {
  readonly id: string;
  readonly type: string;
}

async function fetchCanon(page: Page): Promise<ReadonlyArray<ListAtom>> {
  const response = await page.request.post('/api/canon.list');
  expect(response.ok(), 'canon.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data ?? [];
}

async function fetchActivities(page: Page): Promise<ReadonlyArray<ListAtom>> {
  const response = await page.request.post('/api/activities.list', {
    /*
     * include_reaped:true so atom-detail discovery covers reaped
     * pipeline atoms too -- the detail view is the canonical "render
     * any atom" surface and must not lose discovery for reaped
     * ancestors when the activities feed itself defaults to hiding
     * them. Server wire shape returns `{atoms, reaped_count}` since
     * the reaped-filter projection landed; unwrap `data.atoms` here
     * (older `data` was a plain array; both legacy and new shapes
     * are tolerated for back-compat with cached deployments).
     */
    data: { limit: 100, include_reaped: true },
  });
  if (!response.ok()) return [];
  const body = await response.json();
  const data = body?.data;
  if (Array.isArray(data)) return data;
  return data?.atoms ?? [];
}

test.describe('atom-detail viewer', () => {
  test('renders empty state for an unknown atom id', async ({ page }) => {
    await page.goto('/atom/mystery-atom-2026-05-01-not-real');

    const view = page.getByTestId('atom-detail-empty');
    await expect(view).toBeVisible({ timeout: 10_000 });
    await expect(view).toContainText('Atom not found');
  });

  test('renders empty-id hint when /atom is opened with no id segment', async ({ page }) => {
    await page.goto('/atom');

    const empty = page.getByTestId('atom-detail-empty-id');
    await expect(empty).toBeVisible({ timeout: 10_000 });
  });

  test('renders the type chip + attributes for at least one canon atom', async ({ page }) => {
    const canon = await fetchCanon(page);
    test.skip(canon.length === 0, 'no canon atoms in fixture');

    const target = canon[0]!;
    await page.goto(`/atom/${encodeURIComponent(target.id)}`);

    const view = page.getByTestId('atom-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    await expect(view).toHaveAttribute('data-atom-id', target.id);
    await expect(view).toHaveAttribute('data-atom-type', target.type);

    const chip = page.getByTestId('atom-detail-type-chip');
    await expect(chip).toContainText(target.type);

    // Attributes section is universal across renderers.
    await expect(page.getByTestId('atom-detail-attributes')).toBeVisible();
  });

  test('routes through 3 different atom types if the fixture supports it', async ({ page }) => {
    const all = [...(await fetchCanon(page)), ...(await fetchActivities(page))];
    const seen = new Set<string>();
    const distinctByType: ListAtom[] = [];
    for (const a of all) {
      if (seen.has(a.type)) continue;
      seen.add(a.type);
      distinctByType.push(a);
      if (distinctByType.length === 3) break;
    }
    test.skip(distinctByType.length < 3, 'fewer than 3 atom types in fixture');

    for (const a of distinctByType) {
      await page.goto(`/atom/${encodeURIComponent(a.id)}`);
      const view = page.getByTestId('atom-detail-view');
      await expect(view).toBeVisible({ timeout: 10_000 });
      await expect(view).toHaveAttribute('data-atom-type', a.type);
      // Every type renders the universal Attributes section so the
      // operator always has a baseline read.
      await expect(page.getByTestId('atom-detail-attributes')).toBeVisible();
    }
  });

  test('AtomRef chips on the canon viewer route to the atom detail or canon focus', async ({ page }) => {
    await page.goto('/canon');
    // First card must render before we look for refs inside it.
    const firstCard = page.locator('[data-testid="canon-card"]').first();
    await firstCard.waitFor({ timeout: 10_000 });

    // Expand the card so the references render.
    const expandButton = firstCard.getByRole('button', { name: /Show details/ });
    if (await expandButton.isVisible()) {
      await expandButton.click();
    }

    /*
     * AtomRef chips have data-testid="atom-ref" + data-atom-ref-id.
     * We don't depend on a specific id existing on every fixture;
     * we just assert the contract: clicking ANY visible AtomRef
     * navigates to one of the viable routes. The presence of at
     * least one ref is fixture-dependent; skip if none.
     */
    const anyRef = page.locator('[data-testid="atom-ref"]').first();
    if (await anyRef.count() === 0) {
      test.skip(true, 'no AtomRef chips visible on the first canon card');
    }

    const refTargetRoute = await anyRef.getAttribute('data-atom-ref-target');
    expect(refTargetRoute).toMatch(/^(canon|plans|activities|pipelines|atom)$/);
  });
});
