import { test, expect, type Page } from '@playwright/test';

/**
 * Pipelines view e2e.
 *
 * Operator concern: deep planning runs emit a chain (pipeline atom +
 * stage events + audit findings + optional failure/resume) that
 * previously had no visual surface. The /pipelines route is the
 * primary projection — list grid + drill-in.
 *
 * The atom store on the test machine may or may not contain pipeline
 * atoms (the substrate just shipped; runs are intentionally rare).
 * Tests cover both states:
 *   - empty store        -> empty-state copy renders, no horizontal
 *                           scroll on either viewport
 *   - populated store    -> filter chips, cards, and drill-in render
 *                           with the right structure
 *
 * The bottom sheet of "structural" assertions (no horizontal scroll,
 * tap targets, headers) runs in both cases; coverage scales with the
 * data the dev's machine happens to have.
 *
 * Discovery is dynamic against /api/pipelines.list so the spec stays
 * meaningful regardless of fixture content. Test.skip is used when a
 * given assertion needs data that does not exist locally.
 */

interface PipelineRow {
  readonly pipeline_id: string;
  readonly pipeline_state: string;
  readonly title: string;
}

async function fetchPipelines(page: Page): Promise<ReadonlyArray<PipelineRow>> {
  const response = await page.request.post('/api/pipelines.list');
  expect(response.ok(), 'pipelines.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data?.pipelines ?? [];
}

test.describe('pipelines list view', () => {
  test('renders the page header and either an empty state or the filter chip row', async ({ page }) => {
    await page.goto('/pipelines');

    const view = page.getByTestId('pipelines-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    // The hero title is always present.
    await expect(view).toContainText('Pipelines');

    const pipelines = await fetchPipelines(page);

    if (pipelines.length === 0) {
      // Empty state must be polished, not a blank page.
      await expect(page.getByTestId('pipelines-empty')).toBeVisible();
      return;
    }

    // Populated: the filter chip row renders.
    const chips = page.getByTestId('pipelines-filter-chips');
    await expect(chips).toBeVisible();

    const allChip = page.getByTestId('pipelines-filter-chip-all');
    const runningChip = page.getByTestId('pipelines-filter-chip-running');
    const pausedChip = page.getByTestId('pipelines-filter-chip-paused');
    const completedChip = page.getByTestId('pipelines-filter-chip-completed');
    const failedChip = page.getByTestId('pipelines-filter-chip-failed');

    await expect(allChip).toBeVisible();
    await expect(runningChip).toBeVisible();
    await expect(pausedChip).toBeVisible();
    await expect(completedChip).toBeVisible();
    await expect(failedChip).toBeVisible();

    // Default bucket is 'all'.
    await expect(allChip).toHaveAttribute('aria-pressed', 'true');
    await expect(runningChip).toHaveAttribute('aria-pressed', 'false');

    // Card count matches the bucket size.
    await expect(page.getByTestId('pipeline-card')).toHaveCount(pipelines.length);

    // Each card has the required structural pieces.
    const firstCard = page.getByTestId('pipeline-card').first();
    await expect(firstCard.getByTestId('pipeline-card-state')).toBeVisible();
    await expect(firstCard.getByTestId('pipeline-card-progress')).toBeVisible();
    await expect(firstCard.getByTestId('pipeline-card-cost')).toBeVisible();
    await expect(firstCard.getByTestId('pipeline-card-duration')).toBeVisible();
    await expect(firstCard.getByTestId('pipeline-card-findings')).toBeVisible();
  });

  test('drill-in view renders for a real pipeline id when one exists', async ({ page }) => {
    const pipelines = await fetchPipelines(page);
    test.skip(pipelines.length === 0, 'no pipeline atoms in store; cannot verify drill-in');

    const target = pipelines[0]!;
    await page.goto(`/pipelines/${encodeURIComponent(target.pipeline_id)}`);

    const view = page.getByTestId('pipeline-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });
    await expect(view.getByTestId('pipeline-detail-state')).toContainText(target.pipeline_state);

    // The stat row exposes the four primary numbers.
    await expect(page.getByTestId('pipeline-detail-cost')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-duration')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-stage-count')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-finding-count')).toBeVisible();

    // The Stages and Findings sections render even when one of them is empty.
    await expect(page.getByTestId('pipeline-detail-stages')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-findings')).toBeVisible();
  });

  test('drill-in renders the post-dispatch lifecycle section', async ({ page }) => {
    /*
     * The post-dispatch lifecycle section stitches the chain of atoms
     * that lives downstream of dispatch-stage (dispatch-record +
     * code-author-invoked + pr-observation + plan-merge-settled). The
     * section always renders below the stages list — even when the
     * pipeline never crossed dispatch, the section shows an empty
     * placeholder so the operator knows the surface exists.
     *
     * Discovery is dynamic: pick the first pipeline from the list, drill
     * in, and assert the lifecycle section is present + has the six row
     * test ids regardless of which downstream blocks are populated.
     */
    const pipelines = await fetchPipelines(page);
    test.skip(pipelines.length === 0, 'no pipeline atoms in store; cannot verify lifecycle');

    const target = pipelines[0]!;
    await page.goto(`/pipelines/${encodeURIComponent(target.pipeline_id)}`);

    const section = page.getByTestId('pipeline-lifecycle');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('Post-dispatch lifecycle');

    /*
     * Wait for the lifecycle query to resolve before asserting on row
     * test ids: the loading placeholder shares the section's test id
     * but doesn't render the rows. Once any post-dispatch data lands
     * OR the empty placeholder shows, the rows become discoverable.
     * Two outcomes are valid: either the six rows render (data exists)
     * or the empty placeholder shows (no atoms yet).
     */
    const empty = page.getByTestId('pipeline-lifecycle-empty');
    const dispatchRow = page.getByTestId('pipeline-lifecycle-dispatch');
    await expect(dispatchRow.or(empty)).toBeVisible({ timeout: 10_000 });

    if (await dispatchRow.isVisible().catch(() => false)) {
      // Data path: every row test id is present.
      await expect(page.getByTestId('pipeline-lifecycle-dispatch')).toBeVisible();
      await expect(page.getByTestId('pipeline-lifecycle-code-author')).toBeVisible();
      await expect(page.getByTestId('pipeline-lifecycle-pr')).toBeVisible();
      await expect(page.getByTestId('pipeline-lifecycle-review')).toBeVisible();
      await expect(page.getByTestId('pipeline-lifecycle-ci')).toBeVisible();
      await expect(page.getByTestId('pipeline-lifecycle-merge')).toBeVisible();
    }
  });

  test('drill-in for an unknown id renders the empty state with a back affordance', async ({ page }) => {
    /*
     * Use a fake id that the projection guarantees will never match a
     * real atom. The detail endpoint replies 404; the view collapses
     * to an EmptyState with a Back button instead of a stack trace.
     * Assert the back button actually navigates so the affordance the
     * test name calls out is real, not just visible-but-broken.
     */
    await page.goto('/pipelines/pipeline-does-not-exist-zzz');
    await expect(page.getByTestId('pipeline-detail-empty')).toBeVisible({ timeout: 10_000 });
    const backButton = page.getByRole('button', { name: 'Back to pipelines' });
    await expect(backButton).toBeVisible();
    await backButton.click();
    await expect(page).toHaveURL(/\/pipelines$/);
    await expect(page.getByTestId('pipelines-view')).toBeVisible({ timeout: 10_000 });
  });

  test('drill-in on mobile renders the lifecycle section without horizontal scroll', async ({ page, viewport }) => {
    /*
     * Mobile-first per dev-web-mobile-first-required: the lifecycle
     * section's row layout MUST stack to a single column at 390px.
     * Skip when no pipeline data is available on the dev's machine —
     * the test is meaningful only when we can drill in.
     */
    const pipelines = await fetchPipelines(page);
    test.skip(pipelines.length === 0, 'no pipeline atoms; cannot verify lifecycle mobile layout');
    const target = pipelines[0]!;
    await page.goto(`/pipelines/${encodeURIComponent(target.pipeline_id)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(
      widths.scroll,
      `inner=${widths.inner} scroll=${widths.scroll}`,
    ).toBeLessThanOrEqual(widths.inner + 1);

    // Wait for either the lifecycle data or empty state to render
    // before any geometry assertions; this makes the test resilient to
    // the lifecycle query's network latency.
    const dispatchRow = page.getByTestId('pipeline-lifecycle-dispatch');
    const empty = page.getByTestId('pipeline-lifecycle-empty');
    await expect(dispatchRow.or(empty)).toBeVisible({ timeout: 10_000 });

    // On mobile, if the PR link exists, its tap target meets the 44px
    // floor per --size-touch-target-min (Apple HIG / Material baseline).
    // Skip when the link is not present.
    if (viewport && viewport.width <= 480) {
      const prLink = page.getByTestId('pipeline-lifecycle-pr-link');
      if (await prLink.isVisible().catch(() => false)) {
        const box = await prLink.boundingBox();
        expect(box, 'pr link box').not.toBeNull();
        if (box) {
          expect(box.height, 'pr link height >= 44').toBeGreaterThanOrEqual(44);
        }
      }
    }
  });

  test('mobile (390px) viewport renders without horizontal scroll', async ({ page, viewport }) => {
    /*
     * The mobile project pins viewport to 390x844 (iPhone 13). The
     * desktop project also runs this test at its own viewport; the
     * width assertion is the canonical "no horizontal scroll" check
     * the canon `dev-web-mobile-first-required` enforces. Read
     * window.innerWidth + scrollWidth at runtime so the test stays
     * meaningful regardless of which project is running.
     */
    await page.goto('/pipelines');
    await expect(page.getByTestId('pipelines-view')).toBeVisible({ timeout: 10_000 });

    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));

    // Allow a 1px tolerance for sub-pixel layout rounding.
    expect(widths.scroll, `inner=${widths.inner} scroll=${widths.scroll}`).toBeLessThanOrEqual(widths.inner + 1);

    /*
     * On mobile, the filter chip row wraps; chip touch targets meet
     * the 44px floor per `dev-web-mobile-first-required`. We pick the
     * 'all' chip when present and check its bounding box.
     */
    if (viewport && viewport.width <= 480) {
      const allChip = page.getByTestId('pipelines-filter-chip-all');
      if (await allChip.isVisible().catch(() => false)) {
        const box = await allChip.boundingBox();
        expect(box, 'chip box').not.toBeNull();
        if (box) {
          expect(box.height, 'chip height >= 44').toBeGreaterThanOrEqual(44);
        }
      }
    }
  });
});

test.describe('pulse pipelines tile', () => {
  test('renders the in-flight pipelines tile in the live-ops dashboard', async ({ page }) => {
    await page.goto('/live-ops');
    const tile = page.getByTestId('live-ops-pipelines');
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await expect(tile).toContainText('Pipelines in flight');

    /*
     * Tile renders one of three child states (loading / list / empty).
     * Wait for at least one to materialize so the assertion isn't
     * timing-sensitive against TanStack Query's first-fetch delay.
     */
    const loading = page.getByTestId('live-ops-pipelines-loading');
    const list = page.getByTestId('live-ops-pipelines-list');
    const empty = page.getByTestId('live-ops-pipelines-empty');
    await expect(loading.or(list).or(empty)).toBeVisible();
  });
});

test.describe('sidebar nav', () => {
  test('exposes a Pipelines entry that routes to /pipelines', async ({ page, viewport }) => {
    await page.goto('/');
    /*
     * Below 48rem the desktop nav is hidden; the entry then lives in
     * the mobile overflow drawer. Skip on mobile since exercising the
     * drawer is its own spec; the desktop projects exercise the
     * primary nav here.
     */
    if (viewport && viewport.width < 768) {
      test.skip(true, 'mobile nav covered by mobile-nav-overflow.spec.ts');
      return;
    }
    const navLink = page.getByTestId('nav-pipelines');
    await expect(navLink).toBeVisible({ timeout: 10_000 });
    await navLink.click();
    await expect(page).toHaveURL(/\/pipelines/);
    await expect(page.getByTestId('pipelines-view')).toBeVisible();
  });
});
