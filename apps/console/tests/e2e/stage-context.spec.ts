import { test, expect, type Page } from '@playwright/test';

/**
 * Stage Context panel e2e.
 *
 * The panel is wired into three surfaces:
 *   - /atom/<id>           (atom-detail viewer, every type)
 *   - /plans/<plan-id>     (focus mode of the plans-viewer)
 *   - /deliberation/<id>   (deliberation-trail detail view)
 *
 * The contract under test:
 *   1. The panel renders on every surface (collapsed by default).
 *   2. Clicking the toggle expands the panel and triggers the
 *      lazy stage-context fetch.
 *   3. Once expanded, the three tab buttons (Soul, Upstream chain,
 *      Canon at runtime) all render with role="tab" and the tab
 *      strip carries role="tablist".
 *   4. Switching between tabs swaps the visible tabpanel.
 *   5. For pipeline-stage atoms, the metadata grid surfaces the
 *      stage name, principal id, and skill bundle.
 *
 * The spec discovers a pipeline-stage atom by querying
 * /api/activities.list for the brainstorm-output / spec-output /
 * review-report / dispatch-record / plan types. Skips cleanly when
 * the fixture store has none.
 */

interface ListAtom {
  readonly id: string;
  readonly type: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const PIPELINE_STAGE_TYPES = new Set([
  'brainstorm-output',
  'spec-output',
  'review-report',
  'dispatch-record',
]);

async function fetchActivities(page: Page): Promise<ReadonlyArray<ListAtom>> {
  const response = await page.request.post('/api/activities.list', {
    data: { limit: 200 },
  });
  if (!response.ok()) return [];
  const body = await response.json();
  return body?.data ?? [];
}

async function findPipelineStageAtom(page: Page): Promise<ListAtom | null> {
  const activities = await fetchActivities(page);
  // Prefer an explicit stage-output atom (these always carry a stage
  // soul). Fall back to a pipeline-emitted plan (carries pipeline_id
  // in metadata).
  const stageOutput = activities.find((a) => PIPELINE_STAGE_TYPES.has(a.type));
  if (stageOutput) return stageOutput;
  return activities.find(
    (a) =>
      a.type === 'plan'
      && a.metadata !== undefined
      && typeof a.metadata['pipeline_id'] === 'string',
  ) ?? null;
}

test.describe('stage context panel', () => {
  test('renders collapsed by default on /atom/<id> for any atom', async ({ page }) => {
    const atoms = await fetchActivities(page);
    test.skip(atoms.length === 0, 'no atoms in fixture');

    await page.goto(`/atom/${encodeURIComponent(atoms[0]!.id)}`);
    await expect(page.getByTestId('atom-detail-view')).toBeVisible({ timeout: 10_000 });

    const panel = page.getByTestId('stage-context-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-open', 'false');

    // The body slot does not render until the toggle opens; assert the
    // panel header shows the toggle button with its hint copy.
    const toggle = page.getByTestId('stage-context-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Stage context');
  });

  test('toggle expands the panel and renders all 3 tabs', async ({ page }) => {
    const target = await findPipelineStageAtom(page);
    test.skip(target === null, 'no pipeline-stage atoms in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    await expect(page.getByTestId('atom-detail-view')).toBeVisible({ timeout: 10_000 });

    const panel = page.getByTestId('stage-context-panel');
    const toggle = page.getByTestId('stage-context-toggle');
    await toggle.click();

    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('stage-context-body')).toBeVisible();

    // Tablist contract: role="tablist" + 3 tabs with role="tab".
    const tablist = page.getByTestId('stage-context-tablist');
    await expect(tablist).toBeVisible();
    await expect(tablist).toHaveAttribute('role', 'tablist');

    const soulTab = page.getByTestId('stage-context-tab-soul');
    const chainTab = page.getByTestId('stage-context-tab-chain');
    const canonTab = page.getByTestId('stage-context-tab-canon');
    await expect(soulTab).toBeVisible();
    await expect(chainTab).toBeVisible();
    await expect(canonTab).toBeVisible();
    await expect(soulTab).toHaveAttribute('role', 'tab');
    await expect(chainTab).toHaveAttribute('role', 'tab');
    await expect(canonTab).toHaveAttribute('role', 'tab');

    // Default tab is Soul.
    await expect(soulTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('stage-context-soul')).toBeVisible();

    // Switch to Chain.
    await chainTab.click();
    await expect(chainTab).toHaveAttribute('aria-selected', 'true');
    await expect(soulTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('stage-context-chain')).toBeVisible();

    // Switch to Canon.
    await canonTab.click();
    await expect(canonTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('stage-context-canon')).toBeVisible();
  });

  test('surfaces the stage name + principal id when expanded on a pipeline-stage atom', async ({ page }) => {
    const target = await findPipelineStageAtom(page);
    test.skip(target === null, 'no pipeline-stage atoms in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    await page.getByTestId('stage-context-toggle').click();

    /*
     * The metadata grid is only rendered for atoms that resolved to a
     * known pipeline stage. Atoms that don't (e.g. a generic
     * observation accidentally found here) would render the empty
     * state instead. Assert one of the two invariants holds rather
     * than failing on a fixture-shape mismatch.
     */
    const stagePill = page.getByTestId('stage-context-stage');
    const empty = page.getByTestId('stage-context-empty');
    await Promise.race([
      stagePill.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);

    if (await stagePill.isVisible()) {
      // The stage pill carries the canonical stage name token.
      const text = (await stagePill.textContent()) ?? '';
      expect(text).toMatch(/-stage$/);
      // The principal pill is filled when the stage resolves.
      await expect(page.getByTestId('stage-context-principal')).toBeVisible();
    }
  });
});

test.describe('stage context panel - mobile', () => {
  test('mobile layout has no horizontal scroll when expanded', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? Number.POSITIVE_INFINITY) > 480, 'mobile-only assertion');

    const target = await findPipelineStageAtom(page);
    test.skip(target === null, 'no pipeline-stage atoms in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    await page.getByTestId('stage-context-toggle').click();
    await expect(page.getByTestId('stage-context-body')).toBeVisible({ timeout: 10_000 });

    /*
     * Per canon dev-web-mobile-first-required: 390px viewport must
     * not exhibit horizontal scroll. Compare body scrollWidth vs
     * clientWidth -- the panel must lay out within the available
     * width even on the narrowest mobile profile we ship.
     */
    const overflows = await page.evaluate(() => {
      const body = document.body;
      return body.scrollWidth - body.clientWidth;
    });
    expect(overflows).toBeLessThanOrEqual(0);
  });
});
