import { test, expect, type Page } from '@playwright/test';

/**
 * PipelineErrorBlock e2e coverage on /pipelines/<id>.
 *
 * Verifies the inline categorized error surface that lands above the
 * stage timeline when a pipeline reaches a terminal-negative state.
 * Covers (per the task spec at task #300):
 *
 *   1. Hidden on the happy path (running / completed / hil-paused /
 *      `state: 'ok'` from the projection).
 *   2. Auto-expanded on first paint for failed / halted / abandoned
 *      states; the chevron toggles the body and the preference
 *      persists across reload.
 *   3. Category-specific recovery suggestion + the right action set
 *      per category (budget-exceeded surfaces a policy link; plan-
 *      author-confabulation surfaces the canon link; kill-switch-
 *      halted surfaces the abandon escape hatch).
 *   4. 44px touch-target floor on every action button per canon
 *      dev-web-mobile-first-required.
 *   5. Mobile coverage rides on Playwright's project matrix.
 *
 * Stubbed routes mirror the abandon spec pattern so the test suite
 * stays consistent with the rest of the pipelines-viewer surface.
 */

const PIPELINE_ID = 'pipeline-cto-1762000000000-error-state';
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
              title: 'Error state test pipeline',
              pipeline_state: 'failed',
              mode: 'substrate-deep',
              principal_id: 'cto-actor',
              started_at: '2026-05-10T10:00:00.000Z',
              completed_at: '2026-05-10T10:30:00.000Z',
              total_cost_usd: 0.5,
              total_duration_ms: 1_800_000,
              current_stage_index: 2,
              total_stages: 5,
              audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
              seed_atom_ids: ['operator-intent-error-test'],
              correlation_id: 'corr-error-test',
              last_event_at: '2026-05-10T10:30:00.000Z',
              has_resume_atom: false,
            },
          ],
          truncated: false,
        },
      }),
    });
  });
}

function pipelineDetailBody(state: 'failed' | 'running' | 'abandoned' | 'completed') {
  return {
    ok: true,
    data: {
      pipeline: {
        id: PIPELINE_ID,
        title: 'Error state test pipeline',
        pipeline_state: state,
        mode: 'substrate-deep',
        principal_id: 'cto-actor',
        started_at: '2026-05-10T10:00:00.000Z',
        completed_at: state === 'failed' || state === 'abandoned' ? '2026-05-10T10:30:00.000Z' : null,
        correlation_id: 'corr-error-test',
        seed_atom_ids: ['operator-intent-error-test'],
      },
      total_cost_usd: 0.5,
      total_duration_ms: 1_800_000,
      current_stage_index: 2,
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
          stage_name: 'plan-stage',
          state: state === 'failed' ? 'failed' : 'succeeded',
          index: 1,
          duration_ms: 60_000,
          cost_usd: 0.45,
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
  state: 'failed' | 'running' | 'abandoned' | 'completed',
): Promise<void> {
  return page.route('**/api/pipelines.detail', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(pipelineDetailBody(state)),
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
          state: 'intent-dispatch-failed',
          summary: 'Pipeline halted at plan-stage',
          operator_intent_atom_id: 'operator-intent-error-test',
          pipeline_atom_id: PIPELINE_ID,
          mode: 'substrate-deep',
          title: 'Error state test pipeline',
          stage_count: 2,
          stage_completed_count: 2,
          total_duration_ms: 1_800_000,
          time_elapsed_ms: 1_800_000,
          dispatched_count: 0,
          pr_number: null,
          pr_url: null,
          pr_title: null,
          merge_commit_sha: null,
          pr_merged_at: null,
          skip_reasons: [],
          computed_at: '2026-05-10T10:30:00.000Z',
        },
      }),
    });
  });
}

interface ErrorStateBody {
  pipeline_id?: string;
  state?: 'ok' | 'failed' | 'halted' | 'abandoned';
  severity?: 'critical' | 'warning' | 'info' | null;
  category?: string | null;
  category_label?: string | null;
  suggested_action?: string | null;
  raw_cause?: string | null;
  failed_stage_name?: string | null;
  failed_stage_index?: number | null;
  cited_atom_ids?: ReadonlyArray<string>;
  actions?: ReadonlyArray<{
    kind: string;
    label: string;
    atom_id: string | null;
    canon_id: string | null;
  }>;
  computed_at?: string;
}

function stubErrorState(page: Page, body: ErrorStateBody): Promise<void> {
  return page.route('**/api/pipeline.error-state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          pipeline_id: body.pipeline_id ?? PIPELINE_ID,
          state: body.state ?? 'ok',
          severity: body.severity ?? null,
          category: body.category ?? null,
          category_label: body.category_label ?? null,
          suggested_action: body.suggested_action ?? null,
          raw_cause: body.raw_cause ?? null,
          failed_stage_name: body.failed_stage_name ?? null,
          failed_stage_index: body.failed_stage_index ?? null,
          cited_atom_ids: body.cited_atom_ids ?? [],
          actions: body.actions ?? [],
          computed_at: body.computed_at ?? '2026-05-10T10:30:00.000Z',
        },
      }),
    });
  });
}

function stubAtomsLatest(page: Page): Promise<void> {
  return page.route('**/api/atoms.latest', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { atoms: [], computed_at: '2026-05-10T10:30:00.000Z' } }),
    });
  });
}

test.describe('pipeline error-state block', () => {
  test.beforeEach(async ({ page }) => {
    await Promise.all([
      stubSession(page),
      stubPipelinesList(page),
      stubLifecycle(page),
      stubIntentOutcome(page),
      stubAtomsLatest(page),
    ]);
  });

  test('hides the error block when the projection reports state=ok', async ({ page }) => {
    await stubPipelineDetail(page, 'running');
    await stubErrorState(page, { state: 'ok' });
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-state')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pipeline-error-block')).toHaveCount(0);
  });

  test('renders the error block auto-expanded for state=failed', async ({ page }) => {
    await stubPipelineDetail(page, 'failed');
    await stubErrorState(page, {
      state: 'failed',
      severity: 'critical',
      category: 'budget-exceeded',
      category_label: 'Budget exceeded',
      suggested_action: 'Raise the per-stage cost cap via pol-pipeline-stage-cost-cap and re-run from plan-stage.',
      raw_cause: 'budget-overflow: cost 0.5 > cap 0.25',
      failed_stage_name: 'plan-stage',
      failed_stage_index: 1,
      cited_atom_ids: ['operator-intent-error-test', 'spec-out-1', 'plan-out-1'],
      actions: [
        {
          kind: 'view-atom',
          label: 'View failure atom',
          atom_id: 'pipeline-failed-error-test',
          canon_id: null,
        },
        {
          kind: 'view-policy',
          label: 'View pol-pipeline-stage-cost-cap',
          atom_id: 'pol-pipeline-stage-cost-cap',
          canon_id: null,
        },
        {
          kind: 'view-canon',
          label: 'Open cited canon',
          atom_id: null,
          canon_id: 'dev-indie-floor-org-ceiling',
        },
      ],
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const block = page.getByTestId('pipeline-error-block');
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(block).toHaveAttribute('data-pipeline-state', 'failed');
    await expect(block).toHaveAttribute('data-severity', 'critical');
    await expect(block).toHaveAttribute('data-category', 'budget-exceeded');
    await expect(page.getByTestId('pipeline-error-severity-badge')).toContainText('Budget exceeded');
    await expect(page.getByTestId('pipeline-error-stage')).toContainText('plan-stage');
    await expect(page.getByTestId('pipeline-error-suggested')).toContainText('per-stage cost cap');
  });

  test('renders the abandon escape hatch for state=halted', async ({ page }) => {
    await stubPipelineDetail(page, 'running');
    await stubErrorState(page, {
      state: 'halted',
      severity: 'warning',
      category: 'kill-switch-halted',
      category_label: 'Halted by kill switch',
      suggested_action: 'Pipeline was halted by the .lag/STOP kill switch mid-execution. Clear the sentinel and re-dispatch.',
      raw_cause: 'halted by .lag/STOP kill switch',
      failed_stage_name: 'plan-stage',
      actions: [
        {
          kind: 'view-canon',
          label: 'Open cited canon',
          atom_id: null,
          canon_id: 'inv-kill-switch-first',
        },
        {
          kind: 'abandon',
          label: 'Abandon pipeline',
          atom_id: null,
          canon_id: null,
        },
      ],
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const block = page.getByTestId('pipeline-error-block');
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(block).toHaveAttribute('data-severity', 'warning');
    await expect(page.getByTestId('pipeline-error-action-abandon')).toBeVisible();
  });

  test('renders the operator-abandoned envelope for state=abandoned', async ({ page }) => {
    await stubPipelineDetail(page, 'abandoned');
    await stubErrorState(page, {
      state: 'abandoned',
      severity: 'warning',
      category: 'operator-abandoned',
      category_label: 'Abandoned by operator',
      suggested_action: 'Operator abandoned the pipeline with reason: wrong direction, redoing.',
      raw_cause: 'wrong direction, redoing',
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const block = page.getByTestId('pipeline-error-block');
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(block).toHaveAttribute('data-category', 'operator-abandoned');
    // Abandoned state must NOT surface the abandon action (substrate
    // rejects abandon on terminal states; surfacing the button would
    // dead-end the operator into a 409).
    await expect(page.getByTestId('pipeline-error-action-abandon')).toHaveCount(0);
  });

  test('toggle collapses + persists the preference across reload', async ({ page }) => {
    await stubPipelineDetail(page, 'failed');
    await stubErrorState(page, {
      state: 'failed',
      severity: 'critical',
      category: 'critical-audit-finding',
      category_label: 'Critical audit finding',
      suggested_action: 'Address the finding and re-run.',
      raw_cause: 'critical-audit-finding',
      failed_stage_name: 'review-stage',
      actions: [],
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const block = page.getByTestId('pipeline-error-block');
    await expect(block).toBeVisible({ timeout: 10_000 });
    // Auto-expanded -- the suggested action is visible.
    await expect(page.getByTestId('pipeline-error-suggested')).toBeVisible();

    await page.getByTestId('pipeline-error-toggle').click();
    await expect(page.getByTestId('pipeline-error-suggested')).toHaveCount(0);

    // Reload should restore the collapsed state from storage.
    await page.reload();
    await expect(page.getByTestId('pipeline-error-block')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pipeline-error-suggested')).toHaveCount(0);
  });

  test('action buttons meet the 44px touch-target floor on mobile', async ({ page }) => {
    await stubPipelineDetail(page, 'failed');
    await stubErrorState(page, {
      state: 'failed',
      severity: 'critical',
      category: 'plan-author-confabulation',
      category_label: 'Plan-author confabulation',
      suggested_action: 'Plan-author drafted target_paths that did not match repo state.',
      raw_cause: 'critical-audit-finding',
      failed_stage_name: 'plan-stage',
      actions: [
        {
          kind: 'view-atom',
          label: 'View finding atom',
          atom_id: 'finding-1',
          canon_id: null,
        },
        {
          kind: 'view-canon',
          label: 'Open cited canon',
          atom_id: null,
          canon_id: 'dev-drafter-citation-verification-required',
        },
      ],
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const block = page.getByTestId('pipeline-error-block');
    await expect(block).toBeVisible({ timeout: 10_000 });

    const buttons = page.locator('[data-testid^="pipeline-error-action-"]');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      if (box) expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('clicking view-canon navigates to /canon/<id>', async ({ page }) => {
    await stubPipelineDetail(page, 'failed');
    await stubErrorState(page, {
      state: 'failed',
      severity: 'critical',
      category: 'plan-author-confabulation',
      category_label: 'Plan-author confabulation',
      suggested_action: 'Re-run after correcting target_paths.',
      raw_cause: 'critical-audit-finding',
      failed_stage_name: 'plan-stage',
      actions: [
        {
          kind: 'view-canon',
          label: 'Open cited canon',
          atom_id: null,
          canon_id: 'dev-drafter-citation-verification-required',
        },
      ],
    });
    // Stub the canon endpoint so the navigation lands somewhere stable.
    await page.route('**/api/canon.list', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { atoms: [] } }),
      });
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-error-block')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('pipeline-error-action-view-canon').click();
    await expect(page).toHaveURL(/\/canon\/dev-drafter-citation-verification-required/);
  });

  test('raw cause disclosure reveals the substrate cause string when expanded', async ({ page }) => {
    await stubPipelineDetail(page, 'failed');
    await stubErrorState(page, {
      state: 'failed',
      severity: 'critical',
      category: 'schema-mismatch',
      category_label: 'Schema mismatch',
      suggested_action: 'Stage produced an output that did not match its declared schema.',
      raw_cause: 'schema-validation-failed: Required at "target_paths"',
      failed_stage_name: 'plan-stage',
      actions: [],
    });
    await page.goto(`/pipelines/${PIPELINE_ID}`);

    const block = page.getByTestId('pipeline-error-block');
    await expect(block).toBeVisible({ timeout: 10_000 });
    const details = page.getByTestId('pipeline-error-raw-cause');
    await expect(details).toBeVisible();
    // Pre-click: the disclosure is closed (no open attribute).
    await expect(details).not.toHaveAttribute('open', /.*/);
    // Click the summary directly so the toggle actually fires
    // (clicking the <details> wrapper itself doesn't always trigger
    // the native disclosure on every browser).
    await details.locator('summary').click();
    // Post-click: the disclosure is open AND the raw cause is visible.
    await expect(details).toHaveAttribute('open', /.*/);
    await expect(details).toContainText('schema-validation-failed');
  });
});
