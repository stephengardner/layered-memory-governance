import { test, expect, type Page } from '@playwright/test';

/**
 * Inline-expand stage cards on /pipelines/<id> e2e coverage.
 *
 * Each stage on the pipeline detail view shows a collapsed card by
 * default. The operator clicks Expand on a stage with a recorded
 * output_atom_id and the panel renders the full output content
 * (brainstorm prose, spec markdown, plan body, review findings,
 * dispatch counters) inline -- no navigation, no extra round-trip
 * after the atom resolves.
 *
 * Discovery is dynamic against the API so the spec stays meaningful
 * regardless of which atoms the dev machine happens to have. The two
 * load-bearing scenarios:
 *
 *   1. Default-collapsed: cards arrive collapsed, the Expand toggle is
 *      visible only on stages that have an output atom, no panel until
 *      the toggle is clicked.
 *   2. Expand + persist + collapse: clicking Expand mounts the inline
 *      panel; reloading the page restores the expanded state from
 *      storage; clicking Collapse removes the panel + clears storage.
 *
 * Mobile coverage rides on Playwright's project matrix (the spec runs
 * on both desktop + mobile profiles); the no-horizontal-scroll
 * assertion is the canon `dev-web-mobile-first-required` floor for the
 * panel.
 */

interface PipelineRow {
  readonly pipeline_id: string;
}

interface PipelineStageRow {
  readonly stage_name: string;
  readonly output_atom_id: string | null;
}

async function fetchPipelines(page: Page): Promise<ReadonlyArray<PipelineRow>> {
  const response = await page.request.post('/api/pipelines.list');
  expect(response.ok(), 'pipelines.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data?.pipelines ?? [];
}

async function fetchDetail(
  page: Page,
  pipelineId: string,
): Promise<{ stages: ReadonlyArray<PipelineStageRow> }> {
  const response = await page.request.post('/api/pipelines.detail', {
    data: { pipeline_id: pipelineId },
  });
  expect(response.ok(), 'pipelines.detail should return 200').toBe(true);
  const body = await response.json();
  return { stages: body?.data?.stages ?? [] };
}

/*
 * Pick the first pipeline whose detail projection has a stage with a
 * recorded output_atom_id. A pipeline that never reached
 * brainstorm-stage exit (or whose adapter dropped the output atom id)
 * cannot exercise the expand flow; skip in that case.
 */
async function findPipelineWithStageOutput(page: Page): Promise<{
  readonly pipelineId: string;
  readonly stageWithOutput: PipelineStageRow;
} | null> {
  const pipelines = await fetchPipelines(page);
  for (const p of pipelines) {
    const detail = await fetchDetail(page, p.pipeline_id);
    const stage = detail.stages.find((s) => s.output_atom_id !== null);
    if (stage) {
      return { pipelineId: p.pipeline_id, stageWithOutput: stage };
    }
  }
  return null;
}

test.describe('inline-expand stage cards', () => {
  test('cards default to collapsed; Expand toggle present only on stages with output_atom_id', async ({ page }) => {
    const target = await findPipelineWithStageOutput(page);
    test.skip(target === null, 'no pipeline with a stage output_atom_id; cannot exercise expand');
    if (!target) return; // narrowing for TS

    await page.goto(`/pipelines/${encodeURIComponent(target.pipelineId)}`);
    const view = page.getByTestId('pipeline-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    // The stage card with an output atom shows the Expand toggle.
    const stageCard = page
      .getByTestId('pipeline-stage-card')
      .filter({ has: page.getByTestId('pipeline-stage-expand') })
      .first();
    await expect(stageCard).toBeVisible({ timeout: 10_000 });
    await expect(stageCard).toHaveAttribute('data-stage-expanded', 'false');

    // No inline-output panel is rendered until the operator opts in.
    await expect(page.getByTestId('pipeline-stage-output')).toHaveCount(0);
  });

  test('Expand mounts the panel, persists across reload, Collapse clears it', async ({ page }) => {
    const target = await findPipelineWithStageOutput(page);
    test.skip(target === null, 'no pipeline with a stage output_atom_id; cannot exercise expand');
    if (!target) return;

    await page.goto(`/pipelines/${encodeURIComponent(target.pipelineId)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    // Pin to the specific stage by name so a re-render does not
    // resolve the locator to a different card mid-flight.
    const expandButton = page
      .getByTestId('pipeline-stage-expand')
      .and(page.locator(`[data-stage-name="${target.stageWithOutput.stage_name}"]`))
      .first();
    await expect(expandButton).toBeVisible({ timeout: 10_000 });
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');

    // Click Expand. The output panel mounts; query may be loading or
    // already-resolved (atom-detail pages share the cache key, so a
    // prior visit primes it). Wait for any of the three terminal
    // states before asserting on aria-expanded.
    await expandButton.click();
    const output = page.getByTestId('pipeline-stage-output');
    const loading = page.getByTestId('pipeline-stage-output-loading');
    const errorPanel = page.getByTestId('pipeline-stage-output-error');
    const empty = page.getByTestId('pipeline-stage-output-empty');
    await expect(output.or(loading).or(errorPanel).or(empty)).toBeVisible({ timeout: 10_000 });

    // Once the atom resolves, the populated panel is the load-bearing
    // signal that the renderer dispatch ran.
    await expect(output).toBeVisible({ timeout: 10_000 });
    await expect(expandButton).toHaveAttribute('aria-expanded', 'true');

    // Reload: storage restoration must paint expanded on first paint.
    // Per canon dev-web-interaction-quality (no flash-of-collapsed),
    // the panel renders on the same paint as the rest of the page.
    await page.reload();
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });
    const expandButtonAfterReload = page
      .getByTestId('pipeline-stage-expand')
      .and(page.locator(`[data-stage-name="${target.stageWithOutput.stage_name}"]`))
      .first();
    await expect(expandButtonAfterReload).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('pipeline-stage-output').first()).toBeVisible({ timeout: 10_000 });

    // Collapse: panel goes away, aria-expanded flips back, the storage
    // entry is cleared (a future expansion of a different stage in
    // this pipeline must NOT inherit a stale flag).
    await expandButtonAfterReload.click();
    await expect(expandButtonAfterReload).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('pipeline-stage-output')).toHaveCount(0);

    // Reload one more time to confirm the collapse persisted.
    await page.reload();
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });
    const expandButtonAfterCollapseReload = page
      .getByTestId('pipeline-stage-expand')
      .and(page.locator(`[data-stage-name="${target.stageWithOutput.stage_name}"]`))
      .first();
    await expect(expandButtonAfterCollapseReload).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('pipeline-stage-output')).toHaveCount(0);
  });

  test('expanded panel does not introduce horizontal scroll on mobile width', async ({ page, viewport }) => {
    /*
     * Mobile-first per canon `dev-web-mobile-first-required`: the
     * inline panel may carry long JSON / markdown lines but the page
     * itself MUST NOT gain a horizontal scrollbar at 390px. The panel
     * scrolls inside its own container instead.
     */
    const target = await findPipelineWithStageOutput(page);
    test.skip(target === null, 'no pipeline with a stage output_atom_id; cannot exercise expand');
    if (!target) return;

    await page.goto(`/pipelines/${encodeURIComponent(target.pipelineId)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const expandButton = page
      .getByTestId('pipeline-stage-expand')
      .and(page.locator(`[data-stage-name="${target.stageWithOutput.stage_name}"]`))
      .first();
    await expandButton.click();
    await expect(page.getByTestId('pipeline-stage-output')).toBeVisible({ timeout: 10_000 });

    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(
      widths.scroll,
      `inner=${widths.inner} scroll=${widths.scroll}`,
    ).toBeLessThanOrEqual(widths.inner + 1);

    // On mobile profiles, the Expand toggle's tap target meets the
    // 44px floor.
    if (viewport && viewport.width <= 480) {
      const box = await expandButton.boundingBox();
      expect(box, 'expand button box').not.toBeNull();
      if (box) {
        expect(box.height, 'expand button height >= 44').toBeGreaterThanOrEqual(44);
      }
    }
  });
});
