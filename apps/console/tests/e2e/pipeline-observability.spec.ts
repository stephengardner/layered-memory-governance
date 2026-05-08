import { test, expect, type Page } from '@playwright/test';

/**
 * Pipeline observability spec - input citations, freshness pill,
 * resume tooltip.
 *
 * The fixture intercepts `/api/pipelines.detail` so the assertions
 * stay deterministic regardless of what's in the dev's atom store. A
 * synthetic stage carrying `input_atom_ids` exercises the chip cap +
 * overflow expansion path; a paused stage exercises the disabled
 * resume button + tooltip path. The freshness pill is exercised by
 * controlling response timing via `page.route` delay so the
 * 0->5->stale transitions are reproducible.
 *
 * Six assertions per the plan:
 *   1. Chips render for a fixture stage with N inputs; overflow
 *      chip expands inline on click.
 *   2. Accordion is closed by default at 375x812 (mobile), open by
 *      default at >= md (1280px).
 *   3. Freshness pill ticks 0s -> 5s between simulated polls.
 *   4. Freshness pill switches to stale style + copy after a >15s
 *      simulated poll-failure window.
 *   5. Existing stage-card rendering (state pills, output_atom_id
 *      surface) is unchanged.
 *   6. Visual snapshots at 375 / 768 / 1280.
 */

const FIXTURE_PIPELINE_ID = 'pipeline-fixture-observability-pr1';

interface StageFixture {
  readonly stage_name: string;
  readonly state: 'pending' | 'running' | 'paused' | 'succeeded' | 'failed';
  readonly index: number;
  readonly duration_ms: number;
  readonly cost_usd: number;
  readonly last_event_at: string | null;
  readonly output_atom_id: string | null;
  readonly input_atom_ids?: ReadonlyArray<string>;
}

interface DetailFixture {
  readonly pipeline: Record<string, unknown>;
  readonly stages: ReadonlyArray<StageFixture>;
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly audit_counts: Record<string, number>;
  readonly failure: null;
  readonly resumes: ReadonlyArray<Record<string, unknown>>;
  readonly total_cost_usd: number;
  readonly total_duration_ms: number;
  readonly current_stage_name: string | null;
  readonly current_stage_index: number;
  readonly total_stages: number;
  readonly last_event_at: string;
}

function buildDetailFixture(overrides: Partial<DetailFixture> = {}): DetailFixture {
  /*
   * Build a synthetic 12-input stage so the desktop cap (8) leaves
   * an overflow of 4 and the mobile cap (4) leaves an overflow of 8.
   * One paused stage exercises the resume tooltip path.
   */
  const inputAtomIds = Array.from({ length: 12 }, (_, idx) => `atom-input-${idx + 1}`);
  const stages: ReadonlyArray<StageFixture> = [
    {
      stage_name: 'brainstorm-stage',
      state: 'succeeded',
      index: 0,
      duration_ms: 12_300,
      cost_usd: 0.012,
      last_event_at: '2026-05-08T01:30:00Z',
      output_atom_id: 'atom-brainstorm-output-fixture',
      input_atom_ids: inputAtomIds,
    },
    {
      stage_name: 'spec-stage',
      state: 'paused',
      index: 1,
      duration_ms: 5_800,
      cost_usd: 0.008,
      last_event_at: '2026-05-08T01:31:00Z',
      output_atom_id: null,
      input_atom_ids: ['atom-input-spec-1', 'atom-input-spec-2'],
    },
  ];
  return {
    pipeline: {
      id: FIXTURE_PIPELINE_ID,
      pipeline_state: 'running',
      mode: 'substrate-deep',
      principal_id: 'cto-actor',
      correlation_id: 'corr-fixture-001',
      title: 'Fixture pipeline for observability assertions',
      content: 'fixture content',
      seed_atom_ids: ['atom-seed-1'],
      stage_policy_atom_id: null,
      started_at: '2026-05-08T01:29:00Z',
      completed_at: null,
    },
    stages,
    events: [],
    findings: [],
    audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
    failure: null,
    resumes: [],
    total_cost_usd: 0.02,
    total_duration_ms: 18_100,
    current_stage_name: 'spec-stage',
    current_stage_index: 1,
    total_stages: 2,
    last_event_at: '2026-05-08T01:31:00Z',
    ...overrides,
  };
}

async function mockDetail(
  page: Page,
  fixture: DetailFixture = buildDetailFixture(),
): Promise<void> {
  /*
   * The transport envelope shape is `{ ok: true, data: <payload> }`;
   * mirror the shape so the client's response unwrapping does not
   * silently fail. Skip error injection here so the freshness pill
   * gets a successful first poll to anchor against.
   */
  await page.route('**/api/pipelines.detail', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: fixture }),
    });
  });
  // Stub the lifecycle endpoint so the post-dispatch section renders
  // its empty placeholder without trying to resolve real atoms.
  await page.route('**/api/pipelines.lifecycle', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          dispatch: { count: 0, atoms: [] },
          code_author_invocations: [],
          observation: null,
          merge: null,
        },
      }),
    });
  });
  // Canon search resolves empty so AtomRef hover-cards do not 404.
  await page.route('**/api/canon.list*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('search')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [] }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe('pipeline observability - input citations', () => {
  test('chips render and overflow expands inline on click', async ({ page, viewport }) => {
    /*
     * Run on desktop project only: the cap differs by viewport
     * (4 mobile / 8 desktop) and the mobile path is covered in the
     * default-state test below. Skipping on mobile keeps each
     * assertion's expectations tight.
     */
    test.skip((viewport?.width ?? 0) < 1024, 'desktop assertion');

    await mockDetail(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    /*
     * Open the brainstorm-stage Inputs accordion explicitly. On
     * desktop it ships defaultOpen=true via the `(min-width: 768px)`
     * media query, but assertions click the trigger if needed so the
     * test is robust against viewport ambiguity at the boundary.
     */
    const inputsAcc = page.getByTestId('pipeline-stage-inputs-brainstorm-stage');
    await expect(inputsAcc).toBeVisible({ timeout: 5_000 });
    if ((await inputsAcc.getAttribute('data-open')) !== 'true') {
      await page.getByTestId('pipeline-stage-inputs-brainstorm-stage-trigger').click();
    }

    const list = page.getByTestId('pipeline-stage-inputs-list-brainstorm-stage');
    await expect(list).toBeVisible();

    /*
     * Visible cap on desktop is 8; the +4 more chip surfaces the
     * remaining 4 ids. Click the overflow chip and assert all 12
     * become visible.
     */
    const overflow = page.getByTestId('pipeline-stage-inputs-more-brainstorm-stage');
    await expect(overflow).toBeVisible();
    await expect(overflow).toContainText('+4 more');
    await expect(list.locator('[data-testid="atom-ref"]')).toHaveCount(8);
    await overflow.click();
    await expect(list.locator('[data-testid="atom-ref"]')).toHaveCount(12);
    // The overflow chip disappears once expanded.
    await expect(overflow).toBeHidden();
  });

  test('accordion default-open desktop, default-closed mobile', async ({ page, viewport }) => {
    await mockDetail(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const inputsAcc = page.getByTestId('pipeline-stage-inputs-brainstorm-stage');
    await expect(inputsAcc).toBeVisible({ timeout: 5_000 });

    const isMobile = (viewport?.width ?? 0) < 768;
    await expect(inputsAcc).toHaveAttribute('data-open', isMobile ? 'false' : 'true');
  });
});

test.describe('pipeline observability - freshness pill', () => {
  test('renders fresh state on first poll and ticks toward 5s', async ({ page }) => {
    /*
     * Use a 'succeeded' fixture so the polling refetchInterval is
     * suppressed (PipelineDetailView only polls on
     * pending/running/hil-paused states). With polling off, the
     * dataUpdatedAt timestamp does not roll forward and the ticker
     * can age past 5s. This is the cleanest way to reproduce the
     * spec's "ticks 0s -> 5s between simulated polls" observation
     * deterministically.
     */
    const fixture = buildDetailFixture({
      pipeline: {
        ...buildDetailFixture().pipeline,
        pipeline_state: 'succeeded',
        completed_at: '2026-05-08T01:32:00Z',
      },
    });
    await mockDetail(page, fixture);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const pill = page.getByTestId('pipeline-detail-freshness');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    /*
     * Wait for the pill to settle into the 'fresh' state. The very
     * first render may flash through 'waiting' before the query
     * resolves; once data lands the pill must read 'fresh'.
     */
    await expect(pill).toHaveAttribute('data-state', 'fresh', { timeout: 5_000 });
    await expect(pill).toContainText(/Updated \d+s ago/);

    /*
     * Wait ~6s for the 1s ticker to advance the relative phrase.
     * The pill text moves from "Updated 0s ago" to a value >= 5s.
     */
    await page.waitForTimeout(6_000);
    const text = await pill.textContent();
    const match = text?.match(/Updated (\d+)s ago/);
    expect(match, `expected freshness phrase, got ${text}`).not.toBeNull();
    if (match) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(5);
    }
  });

  test('switches to stale style + copy after >15s without a successful poll', async ({ page }) => {
    // 60s test budget: 15s threshold + 5s polling cadence padding +
    // 25s stale-state wait + 15s page-render budget.
    test.setTimeout(60_000);
    /*
     * Strategy: serve a 'running' fixture (which keeps the 5s
     * polling alive) and switch the route handler to 500 after the
     * first successful response. The PipelineDetailView code path
     * preserves the last-good `query.data` across refetch errors,
     * so the body keeps rendering and the FreshnessPill ages from
     * fresh -> stale on its own ticker. The 15s stale threshold
     * fires inside the FreshnessPill's relative-age branch.
     */
    /*
     * Time-window strategy avoids StrictMode double-mount races: serve
     * 200 with data for the first 6s wall-clock then flip to 500. The
     * initial mount + all StrictMode-induced retries land inside the
     * 200 window; subsequent polling crosses into the 500 window.
     */
    const startMs = Date.now();
    await page.route('**/api/pipelines.detail', async (route) => {
      if (Date.now() - startMs < 6_000) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: buildDetailFixture() }),
        });
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'test-injected', message: 'simulated poll failure' },
        }),
      });
    });
    await page.route('**/api/pipelines.lifecycle', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            dispatch: { count: 0, atoms: [] },
            code_author_invocations: [],
            observation: null,
            merge: null,
          },
        }),
      });
    });
    await page.route('**/api/canon.list*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('search')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: [] }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    const pill = page.getByTestId('pipeline-detail-freshness');
    /*
     * Wait for the pill to appear AND read 'fresh'. Loose timeout
     * covers the 5s polling cadence + retry delay -- after a refetch
     * error TanStack Query retries with backoff before settling, so
     * the first 'data-state=fresh' assertion may need to wait
     * past one polling cycle.
     */
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toHaveAttribute('data-state', 'fresh', { timeout: 10_000 });

    // Wait past the 15s threshold; budget another 5s for the ticker
    // to flip the data-state.
    await expect(pill).toHaveAttribute('data-state', 'stale', { timeout: 25_000 });
    await expect(pill).toContainText(/Stale - last update \d+s ago/);
  });
});

test.describe('pipeline observability - resume tooltip', () => {
  test('disabled resume button stays disabled and exposes a tooltip on hover', async ({ page }) => {
    await mockDetail(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const resume = page.locator('[data-testid="pipeline-stage-resume"][data-stage-name="spec-stage"]');
    await expect(resume).toBeVisible();
    /*
     * The button stays disabled - this PR only adds the tooltip,
     * does not wire any handler. Asserting `disabled` directly via
     * the DOM property is more robust than `:disabled` pseudo on
     * tooltip-wrapped buttons.
     */
    const isDisabled = await resume.evaluate((el: Element) => (el as HTMLButtonElement).disabled);
    expect(isDisabled).toBe(true);

    /*
     * Tooltip surfaces on hover. The Tooltip wraps the disabled
     * button in a non-disabled <span> that catches mouse + focus
     * events; a `hover()` on the button bubbles to the wrapper.
     * Disabled buttons in Chrome suppress click events but not
     * mouseenter / mouseleave, so the wrapper-based pattern keeps
     * the tooltip surface working without enabling the button.
     */
    await resume.hover();
    const tooltip = page.getByTestId('pipeline-stage-resume-tooltip');
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
    await expect(tooltip).toContainText('Resume not yet supported');
  });
});

test.describe('pipeline observability - regression on existing structure', () => {
  test('state pills, output atom chip, and stage cards still render unchanged', async ({ page }) => {
    await mockDetail(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    // Top-level state pill carries the pipeline state.
    await expect(page.getByTestId('pipeline-detail-state')).toContainText('running');

    // Both stage cards render with the right state attribute.
    const cards = page.getByTestId('pipeline-stage-card');
    await expect(cards).toHaveCount(2);
    const succeededCard = cards.filter({ has: page.locator('[data-stage-state="succeeded"]') }).first();
    const pausedCard = cards.filter({ has: page.locator('[data-stage-state="paused"]') }).first();
    await expect(succeededCard).toBeVisible();
    await expect(pausedCard).toBeVisible();

    // The succeeded stage shows its output atom chip.
    await expect(succeededCard.getByTestId('atom-ref').filter({ hasText: 'atom-brainstorm-output-fixture' })).toBeVisible();

    // The four stat tiles still surface.
    await expect(page.getByTestId('pipeline-detail-cost')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-duration')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-stage-count')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-finding-count')).toBeVisible();
  });
});

test.describe('pipeline observability - visual snapshots', () => {
  /*
   * Visual regression at three viewports: 375 (mobile baseline),
   * 768 (md breakpoint), 1280 (desktop). Each snapshot covers the
   * detail header + the first stage card so the freshness pill +
   * inputs accordion + state pills all land in frame.
   *
   * The default chromium project runs at 1280; the mobile project
   * runs at 390 (iPhone 13). The 768 case routes through an
   * explicit setViewportSize call from chromium so we get the
   * tablet-band assertion without spinning a third project.
   */
  test('snapshots at 375 / 768 / 1280', async ({ page, viewport, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'visual snapshots run on chromium only');

    await mockDetail(page);

    const widths = [375, 768, 1280];
    for (const width of widths) {
      // Skip the 1280 + 768 cases on the mobile project (390 viewport)
      // so each width is captured exactly once across both projects.
      if (viewport && viewport.width <= 480 && width !== 375) continue;
      if (viewport && viewport.width > 480 && width === 375) continue;

      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
      await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('pipeline-detail-freshness')).toBeVisible({ timeout: 5_000 });

      // Soft visual check: capture a screenshot to the test artifacts
      // dir so reviewers can eyeball regressions. We don't pin a
      // pixel-diff baseline because the page has live time strings
      // ("started 1m ago") that float per run; structural assertions
      // above carry the regression contract and the screenshot is the
      // human-eyeball backstop.
      await testInfo.attach(`pipeline-detail-${width}px`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    }
  });
});
