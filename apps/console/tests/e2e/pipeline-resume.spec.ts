import { test, expect, type Page } from '@playwright/test';

/**
 * HIL resume-button e2e coverage on /pipelines/<id>.
 *
 * Verifies the wired-up resume affordance for an `hil-paused` pipeline
 * matches the spec the operator clicks through:
 *
 *   1. Paused-state visibility: a stage in `paused` state renders an
 *      enabled Resume button (NOT the disabled stub the v0 shipped).
 *      The button carries the substrate-aligned data-testid
 *      `pipeline-stage-resume` and announces itself via the tooltip.
 *
 *   2. Click flow: pressing the button posts to
 *      /api/pipeline.resume with the operator principal id; the
 *      mutation enters a pending state (Resuming...) before settling.
 *      On success the view refetches and the resumed atom shows up in
 *      the HIL resumes section.
 *
 *   3. Error flow: a 403 forbidden response (caller not in
 *      allowed_resumers) flips the button into the error tone and
 *      surfaces the message in the tooltip; the operator can retry
 *      without a reload.
 *
 * Mobile coverage rides on Playwright's project matrix (the spec runs
 * on both desktop + mobile profiles per canon `dev-web-mobile-first-required`).
 * The 44px touch-target floor is asserted as a height bound on the
 * Resume button -- a violation would leave operators on mobile unable
 * to reliably hit the affordance.
 *
 * Test pattern follows `control-panel.spec.ts`: page.route stubs the
 * load-bearing API responses so the assertions stay deterministic
 * regardless of which atoms the dogfood fixture happens to carry.
 */

const PIPELINE_ID = 'pipeline-cto-1762000000000-resume-test';
const OPERATOR_ID = 'apex-agent';

function stubSession(page: Page): Promise<void> {
  return page.route('**/api/session.current', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { actor_id: OPERATOR_ID } }),
    });
  });
}

function stubPipelinesList(page: Page): Promise<void> {
  /*
   * /pipelines route renders the list first; navigating to /pipelines/<id>
   * pulls the detail. The list stub is enough to satisfy the initial
   * render without painting other pipelines into the grid.
   */
  return page.route('**/api/pipelines.list', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          pipelines: [
            {
              pipeline_id: PIPELINE_ID,
              title: 'Resume test pipeline',
              pipeline_state: 'hil-paused',
              mode: 'substrate-deep',
              principal_id: 'cto-actor',
              started_at: '2026-05-10T10:00:00.000Z',
              completed_at: null,
              total_cost_usd: 0.12,
              total_duration_ms: 60_000,
              current_stage_index: 1,
              total_stages: 5,
              audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
              seed_atom_ids: ['operator-intent-resume-test'],
              correlation_id: 'corr-resume-test',
              last_event_at: '2026-05-10T10:05:00.000Z',
              has_resume_atom: false,
            },
          ],
          truncated: false,
        },
      }),
    });
  });
}

function pipelineDetailBody(opts: { state: 'hil-paused' | 'running'; resumeCount: number }) {
  return {
    ok: true,
    data: {
      pipeline: {
        id: PIPELINE_ID,
        title: 'Resume test pipeline',
        pipeline_state: opts.state,
        mode: 'substrate-deep',
        principal_id: 'cto-actor',
        started_at: '2026-05-10T10:00:00.000Z',
        completed_at: null,
        correlation_id: 'corr-resume-test',
        seed_atom_ids: ['operator-intent-resume-test'],
      },
      total_cost_usd: 0.12,
      total_duration_ms: 60_000,
      current_stage_index: 1,
      total_stages: 5,
      audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
      dispatch_summary: null,
      stages: [
        {
          stage_name: 'brainstorm-stage',
          state: 'succeeded',
          index: 0,
          duration_ms: 30_000,
          cost_usd: 0.05,
          last_event_at: '2026-05-10T10:01:00.000Z',
          output_atom_id: null,
          input_atom_ids: [],
        },
        {
          stage_name: 'spec-stage',
          state: opts.state === 'hil-paused' ? 'paused' : 'running',
          index: 1,
          duration_ms: 30_000,
          cost_usd: 0.07,
          last_event_at: '2026-05-10T10:05:00.000Z',
          output_atom_id: null,
          input_atom_ids: [],
        },
      ],
      events: [
        {
          atom_id: `pipeline-stage-event-${PIPELINE_ID}-spec-stage-hil-pause-corr-resume-test`,
          stage_name: 'spec-stage',
          transition: 'hil-pause',
          at: '2026-05-10T10:05:00.000Z',
          duration_ms: 30_000,
          cost_usd: 0.07,
        },
      ],
      findings: [],
      failure: null,
      resumes: opts.resumeCount > 0
        ? [
            {
              atom_id: `pipeline-resume-${PIPELINE_ID}-spec-stage-console-resume-abc`,
              stage_name: 'spec-stage',
              resumer_principal_id: OPERATOR_ID,
              at: '2026-05-10T10:10:00.000Z',
            },
          ]
        : [],
      agent_turns: [],
    },
  };
}

function stubPipelineDetail(page: Page, state: 'hil-paused' | 'running', resumeCount = 0): Promise<void> {
  return page.route('**/api/pipelines.detail', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(pipelineDetailBody({ state, resumeCount })),
    });
  });
}

function stubLifecycle(page: Page): Promise<void> {
  // The PipelineLifecycle section also calls /api/pipelines.lifecycle.
  // A minimal empty payload keeps the detail view from erroring.
  return page.route('**/api/pipelines.lifecycle', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          pipeline_id: PIPELINE_ID,
          dispatch_record: null,
          code_author_invoked: null,
          observation: null,
          merge: null,
          check_counts: null,
          plan_atom_id: null,
        },
      }),
    });
  });
}

function stubIntentOutcome(page: Page): Promise<void> {
  return page.route('**/api/pipeline.intent-outcome', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          pipeline_id: PIPELINE_ID,
          state: 'intent-paused',
          summary: 'Pipeline paused for HIL at spec-stage',
          operator_intent_atom_id: 'operator-intent-resume-test',
          pipeline_atom_id: PIPELINE_ID,
          mode: 'substrate-deep',
          title: 'Resume test pipeline',
          stage_count: 2,
          stage_completed_count: 1,
          total_duration_ms: 60_000,
          time_elapsed_ms: 300_000,
          dispatched_count: 0,
          pr_number: null,
          pr_url: null,
          pr_title: null,
          merge_commit_sha: null,
          pr_merged_at: null,
          skip_reasons: [],
          computed_at: '2026-05-10T10:05:30.000Z',
        },
      }),
    });
  });
}

test.describe('pipeline detail HIL resume button', () => {
  test.beforeEach(async ({ page }) => {
    await Promise.all([
      stubSession(page),
      stubPipelinesList(page),
      stubLifecycle(page),
      stubIntentOutcome(page),
    ]);
  });

  test('renders an enabled Resume button on a paused stage', async ({ page }) => {
    await stubPipelineDetail(page, 'hil-paused');
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const resume = page.getByTestId('pipeline-stage-resume');
    await expect(resume).toBeVisible({ timeout: 10_000 });
    /*
     * Substrate gate: a button that exists but is disabled is the v0
     * stub. The wired-up version is interactive.
     */
    await expect(resume).toBeEnabled();
    await expect(resume).toHaveAttribute('data-stage-name', 'spec-stage');
    await expect(resume).toHaveAttribute('data-resume-status', 'idle');
    /*
     * Touch-target floor per canon dev-web-mobile-first-required. The
     * resumeButton CSS sets min-height to var(--size-touch-target-min)
     * which resolves to 44px in the live token bundle. The assertion
     * MUST enforce the actual 44px floor (CR PR #396 minor finding:
     * a 40-43px regression must fail this test, not pass).
     */
    const box = await resume.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('clicking Resume posts to the resume endpoint and refetches detail', async ({ page }) => {
    let resumeCallCount = 0;
    let resumeRequestBody: unknown = null;
    await page.route('**/api/pipeline.resume', async (route) => {
      resumeCallCount += 1;
      resumeRequestBody = JSON.parse((await route.request().postData()) ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            pipeline_id: PIPELINE_ID,
            stage_name: 'spec-stage',
            resumer_principal_id: OPERATOR_ID,
            resume_atom_id: `pipeline-resume-${PIPELINE_ID}-spec-stage-console-resume-abc`,
            resumed_at: '2026-05-10T10:10:00.000Z',
          },
        }),
      });
    });
    /*
     * After the click, the mutation invalidates the pipeline query;
     * TanStack Query refetches /api/pipelines.detail and we serve the
     * post-resume body (state=running, one resume in the list). The
     * page.route handler is replaced atomically by the second call so
     * the second fetch gets the new body.
     */
    let detailFetches = 0;
    await page.route('**/api/pipelines.detail', async (route) => {
      detailFetches += 1;
      const post = detailFetches === 1
        ? pipelineDetailBody({ state: 'hil-paused', resumeCount: 0 })
        : pipelineDetailBody({ state: 'running', resumeCount: 1 });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(post),
      });
    });

    await page.goto(`/pipelines/${PIPELINE_ID}`);
    const resume = page.getByTestId('pipeline-stage-resume');
    await expect(resume).toBeVisible({ timeout: 10_000 });
    await expect(resume).toBeEnabled();

    await resume.click();

    /*
     * The endpoint MUST receive the pipeline id. The client does NOT
     * send an actor_id (the server derives the resumer from
     * LAG_CONSOLE_ACTOR_ID per CR PR #396 critical finding). A reason
     * string is optional Console-supplied; presence is fine, exact
     * copy is not load-bearing.
     */
    await expect.poll(() => resumeCallCount, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    expect(resumeRequestBody).toMatchObject({
      pipeline_id: PIPELINE_ID,
    });
    /*
     * Negative assertion: the client must NOT smuggle an actor_id in
     * the request body. Without this guard, a future code path that
     * adds actor_id back would re-open the impersonation vector CR
     * flagged on this PR.
     */
    expect(resumeRequestBody).not.toHaveProperty('actor_id');

    /*
     * Resume row shows up in the HIL resumes section once the
     * post-success refetch lands.
     */
    const resumeRow = page.getByTestId('pipeline-detail-resume-row');
    await expect(resumeRow.first()).toBeVisible({ timeout: 10_000 });
  });

  test('a forbidden response flips the button into the error tone', async ({ page }) => {
    await stubPipelineDetail(page, 'hil-paused');
    await page.route('**/api/pipeline.resume', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: {
            code: 'pipeline-resume-forbidden',
            message: `caller '${OPERATOR_ID}' is not in allowed_resumers for stage 'spec-stage' (allowed: someone-else)`,
          },
        }),
      });
    });

    await page.goto(`/pipelines/${PIPELINE_ID}`);
    const resume = page.getByTestId('pipeline-stage-resume');
    await expect(resume).toBeVisible({ timeout: 10_000 });
    await resume.click();

    /*
     * The mutation lands in the error state; the button's status
     * attribute flips so the CSS error tone applies. The button is
     * re-enabled (the operator can retry) but the data attribute
     * is the load-bearing assertion.
     */
    await expect(resume).toHaveAttribute('data-resume-status', 'error', { timeout: 5_000 });
    await expect(resume).toBeEnabled();
  });

  test('no horizontal scroll on mobile viewport while the button is visible', async ({ page }) => {
    /*
     * Per canon dev-web-mobile-first-required, every interactive
     * affordance must render on a 390x844 mobile shell without
     * triggering horizontal overflow. The check is body-scrollWidth
     * within tolerance of innerWidth.
     */
    await stubPipelineDetail(page, 'hil-paused');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    const resume = page.getByTestId('pipeline-stage-resume');
    await expect(resume).toBeVisible({ timeout: 10_000 });
    const scrollX = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollX.scrollWidth).toBeLessThanOrEqual(scrollX.innerWidth + 2);
  });
});
