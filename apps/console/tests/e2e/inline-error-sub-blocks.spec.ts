import { test, expect, type Page } from '@playwright/test';

/**
 * InlineError sub-block contract.
 *
 * Five sub-block useQuery callsites in the Console silent-absorbed
 * errors before this PR -- they short-circuited on `query.isPending
 * || data.length === 0` and treated a load failure as "no data". The
 * fix is the InlineError component plus the subBlockState helper, used
 * across each of:
 *   1. CanonCard.ReferencedBy           (expanded canon card)
 *   2. CanonCard.WhyThisAtom            (expanded canon card)
 *   3. CanonCard.CascadeIfTainted       (expanded canon card)
 *   4. AtomDetailView.ReferencedByBlock (atom-detail surface)
 *   5. PrincipalsView.statsQuery        (principals toolbar)
 *
 * Each test below intercepts the relevant API endpoint, returns 500,
 * and asserts the InlineError surfaces with the right testId and
 * carries the surfaced error code so an operator can copy it for
 * triage.
 *
 * Coverage runs on both chromium and the iPhone 13 mobile project per
 * canon dev-web-mobile-first-required: error states must be legible
 * inside an expanded card on a 390px viewport without horizontal
 * scroll. Single-line layout with overflow-wrap is the contract; the
 * mobile project enforces it.
 *
 * Follow-up to PR #300 (which unified the canonical ErrorState across
 * top-level views). The InlineError shape is the quieter sibling --
 * see InlineError.tsx for the role="status" + aria-live="polite"
 * accessibility contract.
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

test.describe('InlineError sub-block contract', () => {
  test('CanonCard.ReferencedBy renders InlineError when atoms.references returns 500', async ({ page }) => {
    /*
     * Intercept the reverse-references endpoint exclusively. Other
     * canon-card sub-blocks (atoms.chain, atoms.cascade) stay live so
     * we isolate the ReferencedBy error path. The card-expand button
     * mounts ReferencedBy on demand; we expand the first card on the
     * page and assert the InlineError testId surfaces inside it.
     */
    await page.route('**/api/atoms.references', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'test-injected', message: 'simulated references failure' },
        }),
      });
    });

    const canon = await fetchCanon(page);
    test.skip(canon.length === 0, 'no canon atoms in fixture');
    const target = canon[0]!;

    await page.goto('/canon');
    const card = page.locator(`[data-testid="canon-card"][data-atom-id="${target.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`card-expand-${target.id}`).click();

    const inlineError = page.getByTestId(`referenced-by-error-${target.id}`);
    await expect(inlineError).toBeVisible({ timeout: 10_000 });
    /*
     * Assert the canonical InlineError surface: the "Failed to load:"
     * prefix plus the surfaced error code. The role="status" attribute
     * is asserted at the unit-test layer (InlineError.test.tsx); a
     * Playwright role-assertion against role="status" is brittle here
     * because PrincipalActivity etc. also expose role="status" on
     * unrelated panels.
     */
    await expect(inlineError).toContainText('Failed to load:');
    await expect(inlineError).toContainText('test-injected');
  });

  test('CanonCard.WhyThisAtom renders InlineError when atoms.chain returns 500', async ({ page }) => {
    await page.route('**/api/atoms.chain', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'test-injected', message: 'simulated chain failure' },
        }),
      });
    });

    const canon = await fetchCanon(page);
    test.skip(canon.length === 0, 'no canon atoms in fixture');
    const target = canon[0]!;

    await page.goto('/canon');
    const card = page.locator(`[data-testid="canon-card"][data-atom-id="${target.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`card-expand-${target.id}`).click();

    const inlineError = page.getByTestId(`provenance-chain-error-${target.id}`);
    await expect(inlineError).toBeVisible({ timeout: 10_000 });
    await expect(inlineError).toContainText('Failed to load:');
    await expect(inlineError).toContainText('test-injected');
  });

  test('CanonCard.CascadeIfTainted renders InlineError when atoms.cascade returns 500', async ({ page }) => {
    await page.route('**/api/atoms.cascade', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'test-injected', message: 'simulated cascade failure' },
        }),
      });
    });

    const canon = await fetchCanon(page);
    test.skip(canon.length === 0, 'no canon atoms in fixture');
    const target = canon[0]!;

    await page.goto('/canon');
    const card = page.locator(`[data-testid="canon-card"][data-atom-id="${target.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`card-expand-${target.id}`).click();

    const inlineError = page.getByTestId(`cascade-error-${target.id}`);
    await expect(inlineError).toBeVisible({ timeout: 10_000 });
    await expect(inlineError).toContainText('Failed to load:');
    await expect(inlineError).toContainText('test-injected');
  });

  test('AtomDetailView.ReferencedByBlock renders InlineError when atoms.references returns 500', async ({ page }) => {
    /*
     * Same endpoint as CanonCard.ReferencedBy but consumed on a
     * different surface: /atom/<id> mounts AtomDetailView, which has
     * its own reverse-link block. The two share the cache key in
     * TanStack but the assertion here targets the atom-detail-keyed
     * testId so we are pinning the AtomDetailView wiring specifically.
     */
    await page.route('**/api/atoms.references', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'test-injected', message: 'simulated references failure' },
        }),
      });
    });

    const canon = await fetchCanon(page);
    test.skip(canon.length === 0, 'no canon atoms in fixture');
    const target = canon[0]!;

    await page.goto(`/atom/${encodeURIComponent(target.id)}`);
    /*
     * The atom-detail view mounts the type chip + attributes from
     * independent queries; wait on those before asserting the error
     * subblock so we know the page shell rendered before the error
     * branch was reached.
     */
    await expect(page.getByTestId('atom-detail-view')).toBeVisible({ timeout: 10_000 });

    const inlineError = page.getByTestId('atom-detail-referenced-by-error');
    await expect(inlineError).toBeVisible({ timeout: 10_000 });
    await expect(inlineError).toContainText('Failed to load:');
    await expect(inlineError).toContainText('test-injected');
  });

  test('PrincipalsView.statsQuery renders InlineError when principals.stats returns 500', async ({ page }) => {
    /*
     * Fail the per-principal stats endpoint exclusively. The list
     * endpoint stays live so the principal grid still renders -- we
     * are isolating the stats-query error path. Earlier this silently
     * fell back to an empty stats object, so cards rendered without
     * the chip strip and the operator could not tell whether the
     * stats were genuinely empty or the endpoint was down.
     */
    await page.route('**/api/principals.stats', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'test-injected', message: 'simulated stats failure' },
        }),
      });
    });

    await page.goto('/principals');
    /*
     * The principals view mounts immediately; wait for any principal
     * card to appear (driven by the unaffected list query) before
     * asserting the toolbar's stats-error annotation.
     */
    await expect(page.getByTestId('principal-card').first()).toBeVisible({ timeout: 10_000 });

    const inlineError = page.getByTestId('principals-stats-error');
    await expect(inlineError).toBeVisible({ timeout: 10_000 });
    await expect(inlineError).toContainText('Failed to load:');
    await expect(inlineError).toContainText('test-injected');
  });
});
