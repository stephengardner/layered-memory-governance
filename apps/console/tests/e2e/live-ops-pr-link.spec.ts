import { test, expect } from '@playwright/test';

/**
 * Pulse "PR activity" tile -- clickable GitHub link e2e.
 *
 * Operator concern (2026-05-03): "PR activity also always says no
 * title whereas it should show both the proper title and a link to
 * the PR." The title was fixed in PR #279 via the title-resolution
 * ladder; this PR adds the link.
 *
 * Coverage:
 *   - When the live atom store contains pr-observation atoms with
 *     metadata.pr.{owner, repo, number}, the first PR row renders as
 *     an external anchor whose href is the canonical
 *     https://github.com/<owner>/<repo>/pull/<n> URL.
 *   - The anchor opens in a new tab (target="_blank") and carries
 *     rel="noopener noreferrer" to neutralize tabnabbing.
 *   - The anchor renders the row's primary text (#<n> + title).
 *
 * Discovery is dynamic against the running snapshot endpoint: if the
 * live store has zero pr-observation atoms with the rich shape, the
 * test skips with a clear reason rather than flaking. The snapshot
 * payload itself drives the assertion -- whatever the substrate
 * surfaces, the UI must render correctly.
 */

interface PrActivityRow {
  readonly pr_number: number;
  readonly title: string | null;
  readonly state: string;
  readonly at: string;
  readonly pr_url: string | null;
}

interface LiveOpsSnapshotShape {
  readonly pr_activity: ReadonlyArray<PrActivityRow>;
}

test.describe('live ops pr-row link', () => {
  test('renders the first pr_url-bearing row as an external GitHub anchor', async ({
    page,
    request,
  }) => {
    /*
     * Read the live snapshot off the API directly so the test knows
     * which PR number to expect on the first link-bearing row. The
     * server-side derivation is what populates pr_url; mirroring
     * the client logic here would defeat the purpose.
     */
    const snapshotResponse = await request.post('/api/live-ops.snapshot');
    expect(snapshotResponse.ok(), 'live-ops.snapshot endpoint should return 200').toBe(true);
    const body = await snapshotResponse.json();
    const data: LiveOpsSnapshotShape = body?.data ?? body ?? { pr_activity: [] };
    const firstWithUrl = data.pr_activity.find((row) => typeof row.pr_url === 'string');

    test.skip(
      !firstWithUrl,
      'no pr_activity rows with derived pr_url in the live atom store; cannot exercise the link',
    );

    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-ops-pr-activity')).toBeVisible();

    /*
     * Find the row whose data-pr-number matches the row we found in
     * the snapshot. Most-recent-first ordering means the first
     * pr_url-bearing row in the API response corresponds to the
     * first link-bearing row in the rendered list.
     */
    const targetRow = page.locator(
      `[data-testid="live-ops-pr-row"][data-pr-number="${firstWithUrl!.pr_number}"]`,
    );
    await expect(targetRow).toBeVisible({ timeout: 10_000 });

    const link = targetRow.getByTestId('live-ops-pr-row-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveRole('link');
    await expect(link).toHaveAttribute('href', firstWithUrl!.pr_url!);
    /*
     * URL shape sanity: the projection only ever derives canonical
     * GitHub HTTPS URLs. If the substrate ever ships a different
     * scheme, this assertion catches the regression.
     */
    expect(firstWithUrl!.pr_url!).toMatch(/^https:\/\/github\.com\//);
    await expect(link).toHaveAttribute('target', '_blank');
    /*
     * rel must include both noopener and noreferrer -- the substrate
     * canon (security-correctness-at-write-time) treats external
     * anchors that open new tabs without these as a tabnabbing
     * vector. Use a regex match so future additions (noopener
     * noreferrer external) don't break the test.
     */
    const rel = await link.getAttribute('rel');
    expect(rel, 'rel attribute should be present').not.toBeNull();
    expect(rel).toMatch(/noopener/);
    expect(rel).toMatch(/noreferrer/);

    /*
     * The anchor must render the row's primary text so the operator
     * sees the PR number AND title (or fallback) inside the
     * clickable area, not just the timestamp on the secondary line.
     */
    await expect(link).toContainText(`#${firstWithUrl!.pr_number}`);
  });

  test('rows without pr_url render as plain text (graceful degradation)', async ({
    page,
    request,
  }) => {
    /*
     * Symmetric coverage: when the projection emits pr_url=null
     * (older atoms, shape variants), the row must NOT render an
     * anchor pointing at a confidently-broken URL. Skip if the
     * store has zero such rows.
     */
    const snapshotResponse = await request.post('/api/live-ops.snapshot');
    expect(snapshotResponse.ok(), 'live-ops.snapshot endpoint should return 200').toBe(true);
    const body = await snapshotResponse.json();
    const data: LiveOpsSnapshotShape = body?.data ?? body ?? { pr_activity: [] };
    const firstWithoutUrl = data.pr_activity.find((row) => row.pr_url === null);

    test.skip(
      !firstWithoutUrl,
      'all pr_activity rows in the live store have a pr_url; cannot exercise graceful-degradation',
    );

    await page.goto('/live-ops');
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });

    const targetRow = page.locator(
      `[data-testid="live-ops-pr-row"][data-pr-number="${firstWithoutUrl!.pr_number}"]`,
    );
    await expect(targetRow).toBeVisible({ timeout: 10_000 });

    /*
     * The link testid MUST NOT appear on this row -- the component
     * branches on pr_url and renders raw spans when it is null.
     */
    await expect(targetRow.getByTestId('live-ops-pr-row-link')).toHaveCount(0);
    await expect(targetRow).toContainText(`#${firstWithoutUrl!.pr_number}`);
  });
});
