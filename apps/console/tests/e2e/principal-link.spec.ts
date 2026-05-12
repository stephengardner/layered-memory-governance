import { test, expect } from '@playwright/test';

/*
 * Cross-surface principal-link e2e.
 *
 * The PrincipalLink primitive (`apps/console/src/components/principal-link/`)
 * is the canonical way every Console surface renders a principal id
 * (atom-detail, pipeline-detail, plan card, plan-lifecycle, deliberation,
 * activity feed, canon card). The link routes to /principals/<id> and
 * lands the operator on the principal-detail surface (cards + skill
 * prose + recent-activity feed) via the SPA pushState router.
 *
 * Each test asserts a relationship-gap closure that the operator named
 * in task #147: clicking the principal id from any surface that
 * mentions it MUST get the operator to the principal's detail page.
 */

interface AtomRow {
  readonly id: string;
  readonly type: string;
  readonly principal_id: string;
}

interface PlanRow {
  readonly id: string;
  readonly principal_id: string;
}

interface PipelineRow {
  readonly id: string;
  readonly principal_id: string;
}

/*
 * Activity-feed loader: stricter than the generic loadAnyAtom below
 * because the activity-feed test asserts that THIS atom's principal
 * appears in /activities. Falling back to canon (which has a different
 * principal mix on most installs) would produce a non-product flake
 * instead of a clean skip when activities is empty.
 */
async function loadAnyActivityAtom(
  request: import('@playwright/test').APIRequestContext,
): Promise<AtomRow | null> {
  const activities = await request.post('/api/activities.list', { data: { limit: 5 } });
  if (!activities.ok()) return null;
  const body = await activities.json();
  const first = (body?.data?.[0] ?? body?.[0] ?? null) as AtomRow | null;
  if (first?.id && first.principal_id) return first;
  return null;
}

async function loadAnyAtom(request: import('@playwright/test').APIRequestContext): Promise<AtomRow | null> {
  // Walk activities first, then fall back to canon so generic
  // atom-detail / cmd-click tests stay meaningful regardless of the
  // install's mix of atom types. The activity-feed test uses
  // loadAnyActivityAtom instead so a canon fallback never masquerades
  // as an activity entry the feed cannot find.
  const activity = await loadAnyActivityAtom(request);
  if (activity) return activity;
  const canon = await request.post('/api/canon.list');
  if (canon.ok()) {
    const body = await canon.json();
    const first = (body?.data?.[0] ?? body?.[0] ?? null) as AtomRow | null;
    if (first?.id && first.principal_id) return first;
  }
  return null;
}

test.describe('principal-link cross-surface relationships', () => {
  test('atom-detail by-line opens the principal detail page', async ({ page, request }) => {
    const atom = await loadAnyAtom(request);
    test.skip(atom === null, 'no atoms in store');

    await page.goto(`/atom/${encodeURIComponent(atom!.id)}`);
    const link = page.getByTestId('atom-detail-principal-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveText(atom!.principal_id);

    await link.click();
    const escaped = encodeURIComponent(atom!.principal_id).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    await expect(page).toHaveURL(new RegExp(`/principals/${escaped}$`));
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });
  });

  test('plan card by-line opens the principal detail page', async ({ page, request }) => {
    const res = await request.post('/api/plans.list');
    expect(res.ok(), 'plans.list endpoint should return 200').toBe(true);
    const body = await res.json();
    const plans: ReadonlyArray<PlanRow> = body?.data ?? body ?? [];
    const target = plans.find((p) => Boolean(p.principal_id));
    test.skip(target === undefined, 'no plans with a principal_id');

    await page.goto('/plans');
    // Expand the plan card so the footer (with the principal link) renders.
    const card = page
      .getByTestId('plan-card')
      .filter({ has: page.locator(`[data-plan-atom-id="${target!.id}"]`) })
      .first();
    /*
     * Plan cards may already be expanded; click the expand toggle only
     * when the footer link is not yet visible. Avoids a double-toggle
     * that collapses the card mid-test.
     */
    const link = card.getByTestId('plan-card-principal-link').first();
    if (!(await link.isVisible().catch(() => false))) {
      const toggle = card.getByRole('button').first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
      }
    }
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();
    const escaped = encodeURIComponent(target!.principal_id).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    await expect(page).toHaveURL(new RegExp(`/principals/${escaped}$`));
  });

  test('pipeline detail by-line opens the principal detail page', async ({ page, request }) => {
    const res = await request.post('/api/pipelines.list', { data: { limit: 5 } });
    expect(res.ok(), 'pipelines.list endpoint should return 200').toBe(true);
    const body = await res.json();
    const pipelines: ReadonlyArray<PipelineRow> =
      body?.data?.pipelines ?? body?.pipelines ?? body?.data ?? body ?? [];
    const target = pipelines.find((p) => Boolean(p.principal_id));
    test.skip(target === undefined, 'no pipelines with a principal_id');

    await page.goto(`/pipelines/${encodeURIComponent(target!.id)}`);
    const link = page.getByTestId('pipeline-detail-principal-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveText(target!.principal_id);

    await link.click();
    const escaped = encodeURIComponent(target!.principal_id).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    await expect(page).toHaveURL(new RegExp(`/principals/${escaped}$`));
  });

  test('activity feed by-line opens the principal detail page', async ({ page, request }) => {
    const atom = await loadAnyActivityAtom(request);
    test.skip(atom === null, 'no activity atoms in store');

    await page.goto('/activities');
    const link = page
      .getByTestId('activity-item-principal-link')
      .filter({ hasText: atom!.principal_id })
      .first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();
    const escaped = encodeURIComponent(atom!.principal_id).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    await expect(page).toHaveURL(new RegExp(`/principals/${escaped}$`));
  });

  test('cmd-click on the by-line opens in a new tab (browser default link semantics)', async ({
    page,
    request,
    context,
  }) => {
    const atom = await loadAnyAtom(request);
    test.skip(atom === null, 'no atoms in store');

    await page.goto(`/atom/${encodeURIComponent(atom!.id)}`);
    const link = page.getByTestId('atom-detail-principal-link');
    await expect(link).toBeVisible({ timeout: 10_000 });

    const pagePromise = context.waitForEvent('page');
    /*
     * Use the platform-specific meta key so the test reads as
     * "operator's standard new-tab gesture". The link's onClick guard
     * bails on meta/ctrl/shift/alt so the browser falls through to the
     * native <a target> open-in-new-tab behaviour.
     */
    const isMac = process.platform === 'darwin';
    await link.click({ modifiers: [isMac ? 'Meta' : 'Control'] });
    const newPage = await pagePromise;
    const escaped = encodeURIComponent(atom!.principal_id).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    await expect(newPage).toHaveURL(new RegExp(`/principals/${escaped}$`));
    await newPage.close();
    // Original page stays on /atom/<id>.
    await expect(page).toHaveURL(/\/atom\//);
  });
});
