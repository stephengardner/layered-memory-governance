import { test, expect, type Page } from '@playwright/test';

/**
 * Pipeline-abandon control e2e coverage on /pipelines/<id>.
 *
 * Verifies the wired-up abandon affordance for a running or hil-paused
 * pipeline matches the spec the operator clicks through:
 *
 *   1. Visibility: a pipeline in state running or hil-paused renders
 *      an enabled Abandon button in the header (NOT shown on terminal
 *      pipelines). The button carries the data-testid
 *      `pipeline-detail-abandon`.
 *
 *   2. Confirmation modal: clicking the button opens a modal with a
 *      required free-text reason field. Submit is disabled until the
 *      reason hits the 10-character floor.
 *
 *   3. Submit flow: posting a valid reason calls
 *      /api/pipeline.abandon (no client-supplied actor_id), shows the
 *      pending state, then closes the modal on success and refetches
 *      the pipeline-detail query.
 *
 *   4. Error flow: a 403 forbidden response surfaces the message
 *      inline; the operator can fix the reason or cancel without a
 *      page reload.
 *
 * Mobile coverage rides on Playwright's project matrix (the spec runs
 * on chromium + mobile profiles per canon
 * `dev-web-mobile-first-required`). The 44px touch-target floor is
 * asserted as a height bound on every interactive button.
 */

const PIPELINE_ID = 'pipeline-cto-1762000000000-abandon-test';
const OPERATOR_ID = 'apex-agent';
const VALID_REASON = 'Plan direction is wrong; abandon before next stage burns more budget on a bad path.';

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
              title: 'Abandon test pipeline',
              pipeline_state: 'running',
              mode: 'substrate-deep',
              principal_id: 'cto-actor',
              started_at: '2026-05-10T10:00:00.000Z',
              completed_at: null,
              total_cost_usd: 0.18,
              total_duration_ms: 90_000,
              current_stage_index: 1,
              total_stages: 5,
              audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
              seed_atom_ids: ['operator-intent-abandon-test'],
              correlation_id: 'corr-abandon-test',
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

function pipelineDetailBody(opts: {
  state: 'running' | 'hil-paused' | 'abandoned' | 'completed';
}) {
  return {
    ok: true,
    data: {
      pipeline: {
        id: PIPELINE_ID,
        title: 'Abandon test pipeline',
        pipeline_state: opts.state,
        mode: 'substrate-deep',
        principal_id: 'cto-actor',
        started_at: '2026-05-10T10:00:00.000Z',
        completed_at: null,
        correlation_id: 'corr-abandon-test',
        seed_atom_ids: ['operator-intent-abandon-test'],
      },
      total_cost_usd: 0.18,
      total_duration_ms: 90_000,
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
          state: opts.state === 'running' ? 'running' : 'succeeded',
          index: 1,
          duration_ms: 30_000,
          cost_usd: 0.07,
          last_event_at: '2026-05-10T10:05:00.000Z',
          output_atom_id: null,
          input_atom_ids: [],
        },
      ],
      events: [],
      findings: [],
      failure: null,
      resumes: [],
      agent_turns: [],
    },
  };
}

function stubPipelineDetail(
  page: Page,
  state: 'running' | 'hil-paused' | 'abandoned' | 'completed',
): Promise<void> {
  return page.route('**/api/pipelines.detail', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(pipelineDetailBody({ state })),
    });
  });
}

function stubLifecycle(page: Page): Promise<void> {
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
          state: 'intent-pending',
          summary: 'Pipeline running spec-stage',
          operator_intent_atom_id: 'operator-intent-abandon-test',
          pipeline_atom_id: PIPELINE_ID,
          mode: 'substrate-deep',
          title: 'Abandon test pipeline',
          stage_count: 2,
          stage_completed_count: 1,
          total_duration_ms: 90_000,
          time_elapsed_ms: 600_000,
          dispatched_count: 0,
          pr_number: null,
          pr_url: null,
          pr_title: null,
          merge_commit_sha: null,
          pr_merged_at: null,
          skip_reasons: [],
          computed_at: '2026-05-10T10:10:00.000Z',
        },
      }),
    });
  });
}

test.describe('pipeline detail abandon control', () => {
  test.beforeEach(async ({ page }) => {
    await Promise.all([
      stubSession(page),
      stubPipelinesList(page),
      stubLifecycle(page),
      stubIntentOutcome(page),
    ]);
  });

  test('renders the Abandon button on a running pipeline with the 44px touch-target floor', async ({ page }) => {
    await stubPipelineDetail(page, 'running');
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const abandonBtn = page.getByTestId('pipeline-detail-abandon');
    await expect(abandonBtn).toBeVisible({ timeout: 10_000 });
    await expect(abandonBtn).toBeEnabled();
    await expect(abandonBtn).toHaveAttribute('data-pipeline-id', PIPELINE_ID);

    /*
     * Touch-target floor per canon dev-web-mobile-first-required. The
     * abandonButton CSS sets min-height to var(--size-touch-target-min)
     * which resolves to 44px in the live token bundle. Any regression
     * below 44px MUST fail this test, not pass.
     */
    const box = await abandonBtn.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('renders the Abandon button on a hil-paused pipeline', async ({ page }) => {
    await stubPipelineDetail(page, 'hil-paused');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    const abandonBtn = page.getByTestId('pipeline-detail-abandon');
    await expect(abandonBtn).toBeVisible({ timeout: 10_000 });
    await expect(abandonBtn).toBeEnabled();
  });

  test('hides the Abandon button when pipeline is already abandoned', async ({ page }) => {
    await stubPipelineDetail(page, 'abandoned');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    // Make sure the detail view rendered before asserting hidden -- the
    // freshness pill is a stable signal.
    await expect(page.getByTestId('pipeline-detail-state')).toBeVisible({ timeout: 10_000 });
    const abandonBtn = page.getByTestId('pipeline-detail-abandon');
    await expect(abandonBtn).toHaveCount(0);
  });

  test('hides the Abandon button when pipeline is completed', async ({ page }) => {
    await stubPipelineDetail(page, 'completed');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-state')).toBeVisible({ timeout: 10_000 });
    const abandonBtn = page.getByTestId('pipeline-detail-abandon');
    await expect(abandonBtn).toHaveCount(0);
  });

  test('clicking Abandon opens the confirmation modal with required reason', async ({ page }) => {
    await stubPipelineDetail(page, 'running');
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    await page.getByTestId('pipeline-detail-abandon').click();

    const modal = page.getByTestId('pipeline-detail-abandon-modal');
    await expect(modal).toBeVisible();

    // Pipeline id is visible inside the modal so the operator confirms
    // they are killing the intended pipeline.
    await expect(page.getByTestId('pipeline-detail-abandon-id')).toContainText(PIPELINE_ID);

    // Submit disabled until reason meets the floor.
    const submit = page.getByTestId('pipeline-detail-abandon-submit');
    await expect(submit).toBeDisabled();

    // 44px touch-target floor on submit + cancel.
    const submitBox = await submit.boundingBox();
    expect(submitBox).not.toBeNull();
    if (submitBox) expect(submitBox.height).toBeGreaterThanOrEqual(44);

    const cancel = page.getByTestId('pipeline-detail-abandon-cancel');
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox).not.toBeNull();
    if (cancelBox) expect(cancelBox.height).toBeGreaterThanOrEqual(44);
  });

  test('typing a too-short reason surfaces the inline validation error', async ({ page }) => {
    await stubPipelineDetail(page, 'running');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await page.getByTestId('pipeline-detail-abandon').click();
    const reasonField = page.getByTestId('pipeline-detail-abandon-reason');
    await reasonField.fill('too short');
    await reasonField.blur();

    /*
     * The component shows the "Minimum 10 characters" error inline
     * once the textarea is touched + the value is below the floor.
     * The submit button stays disabled.
     */
    await expect(page.getByTestId('pipeline-detail-abandon-reason-error')).toBeVisible();
    await expect(page.getByTestId('pipeline-detail-abandon-submit')).toBeDisabled();
  });

  test('cancel closes the modal without writing the abandon atom', async ({ page }) => {
    let abandonCalls = 0;
    await page.route('**/api/pipeline.abandon', async (route) => {
      abandonCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            pipeline_id: PIPELINE_ID,
            abandoner_principal_id: OPERATOR_ID,
            abandon_atom_id: 'pipeline-abandoned-x',
            abandoned_at: '2026-05-11T12:00:00.000Z',
          },
        }),
      });
    });
    await stubPipelineDetail(page, 'running');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await page.getByTestId('pipeline-detail-abandon').click();
    await page.getByTestId('pipeline-detail-abandon-reason').fill(VALID_REASON);
    await page.getByTestId('pipeline-detail-abandon-cancel').click();

    // Modal closed, no request fired.
    await expect(page.getByTestId('pipeline-detail-abandon-modal')).toHaveCount(0);
    expect(abandonCalls).toBe(0);
  });

  test('submitting a valid reason posts to the abandon endpoint and closes the modal', async ({ page }) => {
    let abandonCallCount = 0;
    let abandonRequestBody: unknown = null;
    await page.route('**/api/pipeline.abandon', async (route) => {
      abandonCallCount += 1;
      abandonRequestBody = JSON.parse((await route.request().postData()) ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            pipeline_id: PIPELINE_ID,
            abandoner_principal_id: OPERATOR_ID,
            abandon_atom_id: 'pipeline-abandoned-x',
            abandoned_at: '2026-05-11T12:00:00.000Z',
          },
        }),
      });
    });
    /*
     * After the click, the mutation invalidates the pipeline query;
     * TanStack Query refetches /api/pipelines.detail and the second
     * response serves the post-abandon state.
     */
    let detailFetches = 0;
    await page.route('**/api/pipelines.detail', async (route) => {
      detailFetches += 1;
      const post = detailFetches === 1
        ? pipelineDetailBody({ state: 'running' })
        : pipelineDetailBody({ state: 'abandoned' });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(post),
      });
    });

    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await page.getByTestId('pipeline-detail-abandon').click();
    await page.getByTestId('pipeline-detail-abandon-reason').fill(VALID_REASON);
    const submit = page.getByTestId('pipeline-detail-abandon-submit');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect.poll(() => abandonCallCount, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    expect(abandonRequestBody).toMatchObject({
      pipeline_id: PIPELINE_ID,
      reason: VALID_REASON,
    });
    /*
     * Negative assertion: the client must NOT smuggle an actor_id in
     * the request body. Mirrors the resume-button identity-binding
     * guard (CR PR #396 critical finding). A future code path that
     * adds actor_id back would re-open the impersonation vector.
     */
    expect(abandonRequestBody).not.toHaveProperty('actor_id');

    /*
     * Modal closes on success; pipeline state transitions to abandoned
     * after the refetch.
     */
    await expect(page.getByTestId('pipeline-detail-abandon-modal')).toHaveCount(0, { timeout: 10_000 });
  });

  test('a forbidden response surfaces inline error without closing the modal', async ({ page }) => {
    await stubPipelineDetail(page, 'running');
    await page.route('**/api/pipeline.abandon', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: {
            code: 'pipeline-abandon-forbidden',
            message: `caller '${OPERATOR_ID}' is not in allowed_principals (allowed: someone-else)`,
          },
        }),
      });
    });

    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await page.getByTestId('pipeline-detail-abandon').click();
    await page.getByTestId('pipeline-detail-abandon-reason').fill(VALID_REASON);
    await page.getByTestId('pipeline-detail-abandon-submit').click();

    /*
     * Server error renders inline; modal stays open so the operator
     * can adjust input and retry without re-typing.
     */
    const err = page.getByTestId('pipeline-detail-abandon-server-error');
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText('not in allowed_principals');
    await expect(page.getByTestId('pipeline-detail-abandon-modal')).toBeVisible();
  });

  test('no horizontal scroll on mobile viewport while the modal is visible', async ({ page }) => {
    /*
     * Per canon dev-web-mobile-first-required, the abandon modal
     * must render on a 390x844 mobile shell without triggering
     * horizontal overflow. The check is body-scrollWidth within
     * tolerance of innerWidth.
     */
    await stubPipelineDetail(page, 'running');
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await page.getByTestId('pipeline-detail-abandon').click();
    await expect(page.getByTestId('pipeline-detail-abandon-modal')).toBeVisible({ timeout: 10_000 });
    const scrollX = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollX.scrollWidth).toBeLessThanOrEqual(scrollX.innerWidth + 2);
  });
});
