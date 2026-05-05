import { test, expect, type Page } from '@playwright/test';

/**
 * Deliberation surface e2e: surfaces the heuristic-thinking trail
 * INLINE on plan and canon detail views.
 *
 * Scope: the shared <Deliberation> component renders four sub-sections
 * (principles_applied, alternatives_rejected, what_breaks_if_revisit,
 * derived_from) on the atom-detail viewer's plan renderer (route
 * /atom/<plan-id>) and on the canon-card's expanded panel
 * (route /canon, expand a card). Distinct from the standalone
 * /deliberation route which is exercised by deliberation.spec.ts.
 *
 * Both surfaces render the SAME shared component, so the assertions
 * are identical in shape; the test bodies pick a fixture-aware
 * target on each surface and assert the section structure.
 *
 * Mobile + desktop: every spec runs under the `chromium` and `mobile`
 * Playwright projects (per dev-mobile-first-required canon). The
 * mobile project enforces that touch targets render at >=44 css px
 * and that the surface does not introduce horizontal scroll at
 * 390 css px.
 */

interface ListAtom {
  readonly id: string;
  readonly type: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provenance?: { readonly derived_from?: ReadonlyArray<string> };
}

async function fetchPlans(page: Page): Promise<ReadonlyArray<ListAtom>> {
  /*
   * Use atoms.list rather than activities.list so we get plans
   * specifically without any rate-limit semantics. plans.list does
   * not exist server-side; we use the wider list and filter in-test.
   * The activities.list endpoint with a generous limit is reliable
   * across fixtures.
   */
  const response = await page.request.post('/api/activities.list', {
    data: { limit: 200 },
  });
  if (!response.ok()) return [];
  const body = await response.json();
  const all: ReadonlyArray<ListAtom> = body?.data ?? [];
  return all.filter((a) => a.type === 'plan');
}

async function fetchCanon(page: Page): Promise<ReadonlyArray<ListAtom>> {
  const response = await page.request.post('/api/canon.list');
  expect(response.ok(), 'canon.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data ?? [];
}

/*
 * Pick a plan that carries enough deliberation metadata to drive a
 * meaningful assertion. We need at least ONE of the deliberation
 * fields populated; tests skip cleanly if no fixture plan qualifies.
 */
function pickPlanWithDeliberation(plans: ReadonlyArray<ListAtom>): ListAtom | null {
  for (const p of plans) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const principles = Array.isArray(meta['principles_applied']) ? meta['principles_applied'] : [];
    const alternatives = Array.isArray(meta['alternatives_rejected']) ? meta['alternatives_rejected'] : [];
    const whatBreaks = typeof meta['what_breaks_if_revisit'] === 'string' && (meta['what_breaks_if_revisit'] as string).trim().length > 0;
    const derivedFrom = p.provenance?.derived_from ?? [];
    if (principles.length > 0 || alternatives.length > 0 || whatBreaks || derivedFrom.length > 0) {
      return p;
    }
  }
  return null;
}

test.describe('deliberation surface (inline on plan + canon detail)', () => {
  test('atom-detail viewer renders the deliberation block on a plan with deliberation metadata', async ({ page }) => {
    const plans = await fetchPlans(page);
    const target = pickPlanWithDeliberation(plans);
    test.skip(target === null, 'no plan with deliberation metadata in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    const view = page.getByTestId('atom-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    const block = page.getByTestId('atom-detail-deliberation');
    await expect(block).toBeVisible({ timeout: 10_000 });

    // The deliberation block shows the section title once.
    await expect(block.getByRole('heading', { name: 'Deliberation' })).toBeVisible();

    // At least one of the four sub-sections must be present (we
    // already filtered the plan to carry deliberation, so SOMETHING
    // renders). The asserter just verifies the parent block is
    // populated rather than picking which section -- different
    // fixture plans carry different subsets.
    const subSectionCount = await block
      .locator('[data-testid^="atom-detail-deliberation-"]')
      .count();
    expect(subSectionCount).toBeGreaterThan(0);
  });

  test('atom-detail viewer renders the four sub-sections in spec order when all are present', async ({ page }) => {
    const plans = await fetchPlans(page);
    /*
     * Need a plan carrying ALL four signals to exercise the order
     * assertion. Find the first one that satisfies all four; skip
     * if none in fixture (a real-world acceptable outcome that
     * teaches the test reader something instead of fabricating).
     */
    let target: ListAtom | null = null;
    for (const p of plans) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      const principles = Array.isArray(meta['principles_applied']) ? meta['principles_applied'] : [];
      const alternatives = Array.isArray(meta['alternatives_rejected']) ? meta['alternatives_rejected'] : [];
      const whatBreaks = typeof meta['what_breaks_if_revisit'] === 'string' && (meta['what_breaks_if_revisit'] as string).trim().length > 0;
      const derivedFrom = p.provenance?.derived_from ?? [];
      if (principles.length > 0 && alternatives.length > 0 && whatBreaks && derivedFrom.length > 0) {
        target = p;
        break;
      }
    }
    test.skip(target === null, 'no plan with all four deliberation fields populated in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    const block = page.getByTestId('atom-detail-deliberation');
    await expect(block).toBeVisible({ timeout: 10_000 });

    /*
     * Spec order: principles -> alternatives -> what-breaks ->
     * derived-from. Read the four sub-section testids in document
     * order and assert the sequence matches.
     *
     * SECTION_TESTIDS is the closed set we care about; child
     * elements (alternative items, principle chips) share the
     * `atom-detail-deliberation-` prefix but are filtered out by
     * inclusion in this set.
     */
    const SECTION_TESTIDS = new Set([
      'atom-detail-deliberation-principles',
      'atom-detail-deliberation-alternatives',
      'atom-detail-deliberation-what-breaks',
      'atom-detail-deliberation-derived-from',
    ]);
    const observed = await block
      .locator('[data-testid^="atom-detail-deliberation-"]')
      .evaluateAll((els, knownArr) =>
        (els as HTMLElement[])
          .map((e) => e.getAttribute('data-testid') ?? '')
          .filter((id) => (knownArr as string[]).includes(id)),
        Array.from(SECTION_TESTIDS),
      );
    expect(observed).toEqual([
      'atom-detail-deliberation-principles',
      'atom-detail-deliberation-alternatives',
      'atom-detail-deliberation-what-breaks',
      'atom-detail-deliberation-derived-from',
    ]);
  });

  test('atom-detail viewer omits the deliberation block when plan has no deliberation fields', async ({ page }) => {
    /*
     * Pick a NON-plan atom that legitimately carries no deliberation
     * fields. canon-list always includes the apex-agent self-bootstrap
     * atoms; some of them have no metadata.alternatives_rejected, no
     * principles_applied, no derived_from (very early bootstrap).
     */
    const canon = await fetchCanon(page);
    let target: ListAtom | null = null;
    for (const c of canon) {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const principles = Array.isArray(meta['principles_applied']) ? meta['principles_applied'] : [];
      const alternatives = Array.isArray(meta['alternatives_rejected']) ? meta['alternatives_rejected'] : [];
      const whatBreaks = typeof meta['what_breaks_if_revisit'] === 'string' && (meta['what_breaks_if_revisit'] as string).trim().length > 0;
      const whatBreaks2 = typeof meta['what_breaks_if_revisited'] === 'string' && (meta['what_breaks_if_revisited'] as string).trim().length > 0;
      const derivedFrom = c.provenance?.derived_from ?? [];
      if (principles.length === 0 && alternatives.length === 0 && !whatBreaks && !whatBreaks2 && derivedFrom.length === 0) {
        target = c;
        break;
      }
    }
    test.skip(target === null, 'no canon atom without any deliberation fields in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    const view = page.getByTestId('atom-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });
    /*
     * The atom renders, but the deliberation block does NOT. This
     * is the legacy-atom case from the spec; an atom carrying no
     * deliberation should render gracefully without an empty
     * placeholder section.
     */
    await expect(page.getByTestId('atom-detail-deliberation')).toHaveCount(0);
  });

  test('canon viewer renders the deliberation block on an expanded canon card carrying deliberation', async ({ page }) => {
    /*
     * Many directives carry alternatives + derived_from in their
     * metadata. Pick a canon atom with at least one populated
     * deliberation field to drive the surface.
     */
    const canon = await fetchCanon(page);
    let target: ListAtom | null = null;
    for (const c of canon) {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const principles = Array.isArray(meta['principles_applied']) ? meta['principles_applied'] : [];
      const alternatives = Array.isArray(meta['alternatives_rejected']) ? meta['alternatives_rejected'] : [];
      const whatBreaks = typeof meta['what_breaks_if_revisit'] === 'string' && (meta['what_breaks_if_revisit'] as string).trim().length > 0;
      const whatBreaks2 = typeof meta['what_breaks_if_revisited'] === 'string' && (meta['what_breaks_if_revisited'] as string).trim().length > 0;
      const derivedFrom = c.provenance?.derived_from ?? [];
      if (principles.length > 0 || alternatives.length > 0 || whatBreaks || whatBreaks2 || derivedFrom.length > 0) {
        target = c;
        break;
      }
    }
    test.skip(target === null, 'no canon atom with any deliberation fields in fixture');

    await page.goto(`/canon/${encodeURIComponent(target!.id)}`);

    const card = page.locator(`[data-testid="canon-card"][data-atom-id="${target!.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    /*
     * Card starts collapsed; expand to mount the DetailsPanel that
     * hosts the deliberation block.
     */
    const expand = card.getByRole('button', { name: /Show details/ });
    await expand.click();

    const block = page.getByTestId('atom-detail-deliberation');
    await expect(block).toBeVisible({ timeout: 10_000 });

    // Same shared component, so the section heading reads identically.
    await expect(block.getByRole('heading', { name: 'Deliberation' })).toBeVisible();
  });

  /*
   * Note on missing-principle coverage: the load-bearing assertion
   * (chip renders as strikethrough + missing tooltip when the cited
   * id does not resolve) is exercised below by mocking the
   * /api/atoms.exists response. We deliberately do NOT add a
   * fixture-dependent variant that walks real plans for a broken
   * citation -- doing so would skip cleanly on every run because
   * the dogfood fixture has no plan citing a fabricated id, and a
   * skipped test teaches future readers nothing about coverage. The
   * mocked variant runs deterministically every CI pass.
   */
  test('mocked missing-atom resolution paints the strikethrough chip even when fixture has no missing citation', async ({ page }) => {
    /*
     * Real fixture data may or may not include a plan citing a
     * non-existent principle (a drafter confabulation). To prove
     * the surface ITSELF works regardless of fixture coverage, we
     * intercept the atoms.exists call and force the response to
     * mark a known-real principle as missing. The chip then has to
     * render the strikethrough variant on the next render.
     *
     * Rationale: per dev-drafter-citation-verification-required
     * canon, this is the failure mode the affordance is built for;
     * shipping it untested would leave the most important branch
     * unverified.
     *
     * We pick a plan with at least one principles_applied entry
     * (any plan with the field will do). If no plan has principles,
     * skip cleanly.
     */
    const plans = await fetchPlans(page);
    let target: { id: string; firstPrinciple: string } | null = null;
    for (const p of plans) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      const raw = meta['principles_applied'];
      if (!Array.isArray(raw)) continue;
      const first = raw.find((v): v is string => typeof v === 'string' && v.length > 0);
      if (first) {
        target = { id: p.id, firstPrinciple: first };
        break;
      }
    }
    test.skip(target === null, 'no plan with at least one principles_applied entry in fixture');

    /*
     * Force atoms.exists to mark every cited principle as missing.
     * The route mock must run before page.goto, otherwise the first
     * render races the route handler.
     */
    await page.route('**/api/atoms.exists', async (route) => {
      const body = JSON.parse((route.request().postData() ?? '{}'));
      const ids: ReadonlyArray<string> = Array.isArray(body.ids) ? body.ids : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: ids.map((id) => ({ id, exists: false })),
        }),
      });
    });

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    const chip = page.locator(
      `[data-testid="atom-detail-deliberation-principle"][data-atom-id="${target!.firstPrinciple}"]`,
    );
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute('data-missing', 'true', { timeout: 10_000 });
    const title = await chip.getAttribute('title');
    expect(title).toMatch(/Missing atom:/);
    /*
     * Negative assertion: the strikethrough class on the anchor
     * differs from the normal-chip class. We don't assert the class
     * name directly (that would couple the test to CSS-modules
     * hashing), but the data-missing="true" attribute IS the public
     * contract for the variant. Coverage stays at the contract layer.
     */
  });

  test('mobile viewport: no horizontal scroll on the deliberation block', async ({ page }) => {
    const plans = await fetchPlans(page);
    const target = pickPlanWithDeliberation(plans);
    test.skip(target === null, 'no plan with deliberation metadata in fixture');
    /*
     * The mobile Playwright project runs this spec at iPhone 13
     * dimensions (390x844). dev-mobile-first-required canon makes
     * a horizontal scrollbar at <= 400px a hard fail; assert the
     * document body is not wider than the viewport.
     */
    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    await expect(page.getByTestId('atom-detail-deliberation')).toBeVisible({
      timeout: 10_000,
    });
    const overflow = await page.evaluate(() => {
      // Compare the rendered body width to the viewport width. A
      // 1px-or-better difference is a layout overflow.
      const body = document.body;
      const html = document.documentElement;
      const docWidth = Math.max(
        body.scrollWidth,
        body.offsetWidth,
        html.clientWidth,
        html.scrollWidth,
        html.offsetWidth,
      );
      return docWidth - window.innerWidth;
    });
    expect(overflow, 'document should not exceed viewport width').toBeLessThanOrEqual(0);
  });
});
