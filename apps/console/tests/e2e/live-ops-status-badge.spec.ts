import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the Live Ops freshness badge. Uses request
 * interception to seed deterministic snapshot payloads so the test
 * does not need a running atom store. Timestamps in fixtures are
 * computed against real Date.now() at test time -- the badge's clock
 * is never mocked in-browser (per plan-atom guidance), so the
 * relative freshness math holds against the true wall clock.
 */

const SNAPSHOT_URL = '**/api/live-ops.snapshot*';
const PIPELINES_URL = '**/api/pipelines.live-ops*';

interface SnapshotOpts {
  lastTurnAt: string | null;
}

function buildSnapshot({ lastTurnAt }: SnapshotOpts) {
  return {
    computed_at: new Date().toISOString(),
    heartbeat: { last_60s: 0, last_5m: 0, last_1h: 0, delta: 0 },
    active_sessions: lastTurnAt
      ? [
          {
            session_id: 'sess-test',
            principal_id: 'test-principal',
            started_at: new Date(Date.now() - 30_000).toISOString(),
            last_turn_at: lastTurnAt,
          },
        ]
      : [],
    live_deliberations: [],
    in_flight_executions: [],
    recent_transitions: [],
    pr_activity: [],
    daemon_posture: {
      kill_switch_engaged: false,
      kill_switch_tier: 'off',
      autonomy_dial: 0.5,
      active_elevations: [],
    },
  };
}

async function stubPipelines(page: Page) {
  await page.route(PIPELINES_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipelines: [] }),
    }),
  );
}

async function stubSnapshot(page: Page, opts: SnapshotOpts) {
  await page.route(SNAPSHOT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildSnapshot(opts)),
    }),
  );
}

/**
 * Shared arrange: stub both endpoints, navigate to root, return the
 * located badge. Extracted at N=2 (canon: dev-dry-extract-at-second-
 * duplication) so the test bodies focus on the assertion that
 * differs between cases (state attribute + visible text).
 */
async function openLiveOpsAndGetBadge(page: Page, lastTurnAt: string | null) {
  await stubPipelines(page);
  await stubSnapshot(page, { lastTurnAt });
  await page.goto('/');
  const badge = page.getByTestId('live-ops-status-badge');
  await expect(badge).toBeVisible();
  return badge;
}

test.describe('Live Ops freshness badge', () => {
  test('shows Running when the most recent agent turn is fresh', async ({ page }) => {
    const fresh = new Date(Date.now() - 5_000).toISOString();
    const badge = await openLiveOpsAndGetBadge(page, fresh);
    await expect(badge).toHaveAttribute('data-state', 'running');
    await expect(badge).toContainText('Running');
  });

  test('shows Idle when the most recent agent turn is stale', async ({ page }) => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    const badge = await openLiveOpsAndGetBadge(page, stale);
    await expect(badge).toHaveAttribute('data-state', 'idle');
    await expect(badge).toContainText('Idle');
  });

  test('shows Idle when there are no active sessions', async ({ page }) => {
    const badge = await openLiveOpsAndGetBadge(page, null);
    await expect(badge).toHaveAttribute('data-state', 'idle');
  });
});
