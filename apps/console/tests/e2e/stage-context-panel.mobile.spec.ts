import { test, expect, type Page } from '@playwright/test';
import { skipUnlessMobile } from './_lib/mobile';

/**
 * Mobile-first assertions for the StageContextPanel disclosure.
 *
 * Companion to stage-context.spec.ts: the desktop spec covers the
 * panel's structural contract (panel collapsed by default, three
 * disclosure section headers each with aria-expanded + aria-controls,
 * multi-open accordion semantics). This spec tightens the mobile-only
 * surface and pins the contract from the operator's deep-pipeline
 * intent at 390x844 (iPhone 13 viewport):
 *
 *   1. No horizontal scroll on the document at the rendered route.
 *   2. All three section headers are visible and clickable; clicking
 *      flips aria-expanded from "false" to "true" and reveals the
 *      matching <section role="region"> body.
 *   3. Each header's bounding box height meets the >= 44 CSS-pixel
 *      tap-target floor (canon dev-web-mobile-first-required).
 *   4. On first paint, all three section headers report
 *      aria-expanded="false" and no region body is visible. The
 *      tab-strip approach the panel previously rendered would
 *      auto-show one tabpanel; the disclosure approach must not.
 *
 * The spec discovers a pipeline-stage atom (brainstorm-output /
 * spec-output / review-report / dispatch-record) or a plan carrying
 * pipeline_id metadata and routes to /atom/<id>. Skips cleanly when
 * the fixture store has no qualifying atoms so a fresh install does
 * not false-fail.
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
  const stageOutput = activities.find((a) => PIPELINE_STAGE_TYPES.has(a.type));
  if (stageOutput) return stageOutput;
  return activities.find(
    (a) =>
      a.type === 'plan'
      && a.metadata !== undefined
      && typeof a.metadata['pipeline_id'] === 'string',
  ) ?? null;
}

test.describe('stage-context panel mobile disclosure', () => {
  test('three sections stack as collapsibles at 390x844 with no horizontal scroll', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    const target = await findPipelineStageAtom(page);
    test.skip(target === null, 'no pipeline-stage atoms in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    await expect(page.getByTestId('atom-detail-view')).toBeVisible({ timeout: 10_000 });

    /*
     * Expand the outer panel so the three section headers render. The
     * outer collapsible is a separate concern from the disclosure
     * trio under test (it gates the lazy stage-context fetch).
     */
    await page.getByTestId('stage-context-toggle').click();
    await expect(page.getByTestId('stage-context-body')).toBeVisible({ timeout: 10_000 });

    /*
     * Document-level horizontal-scroll assertion. documentElement
     * (not body) is the right target: body width is influenced by
     * margins and ignores overflow on the document. Per canon
     * dev-web-mobile-first-required, scrollWidth <= clientWidth at
     * 390x844 is non-negotiable.
     */
    const horizontalOverflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(horizontalOverflow, 'document must not exhibit horizontal scroll at 390x844').toBeLessThanOrEqual(0);

    /*
     * Discover all three section headers and their corresponding
     * region bodies. Use the test-id contract emitted by
     * StageContextPanel.tsx so a structural change to the
     * underlying DOM (id strings, ordering) surfaces here.
     */
    const sections = ['soul', 'chain', 'canon'] as const;
    const headers = sections.map((name) =>
      page.getByTestId(`stage-context-section-header-${name}`),
    );
    const regions = sections.map((name) =>
      page.getByTestId(`stage-context-section-region-${name}`),
    );

    /* All three headers visible. */
    for (const header of headers) {
      await expect(header).toBeVisible();
    }

    /*
     * On first paint each header reports aria-expanded="false" and
     * no region body is visible. The disclosure pattern must NOT
     * auto-open a section the way the prior tab strip auto-selected
     * the soul tab; the operator's intent is explicit on this point.
     */
    for (const header of headers) {
      await expect(header).toHaveAttribute('aria-expanded', 'false');
    }
    for (const region of regions) {
      await expect(region).toBeHidden();
    }

    /*
     * Each header meets the >= 44 CSS-pixel tap-target floor. Use
     * boundingBox().height as the measurement (matches what the
     * tap-target heuristics in our other mobile specs use).
     */
    for (const header of headers) {
      const box = await header.boundingBox();
      expect(box, 'section header must be in the layout flow').not.toBeNull();
      expect(box!.height, 'section header tap target must be >= 44px').toBeGreaterThanOrEqual(44);
    }

    /*
     * Click each header in turn. aria-expanded flips false -> true
     * and the matching region becomes visible. Multi-open accordion:
     * a click on one section does not close another.
     */
    for (let i = 0; i < sections.length; i++) {
      const header = headers[i]!;
      const region = regions[i]!;
      await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      await expect(region).toBeVisible();
    }

    /* All three end up open without having closed each other. */
    for (const header of headers) {
      await expect(header).toHaveAttribute('aria-expanded', 'true');
    }
  });
});
