import { test, expect, type Page } from '@playwright/test';

/**
 * Operator-action audit-trail dashboard e2e.
 *
 * The /operator-actions route projects every `operator-action` atom
 * (id prefix `op-action-`) written by the substrate's bot-identity
 * wrappers (`gh-as.mjs`, `cr-trigger.mjs`,
 * `resolve-outdated-threads.mjs`) into a reverse-chronological audit
 * trail. Actor + action-type chips narrow the view; rows route to the
 * atom-detail viewer.
 *
 * Atom-store on the test machine may or may not have op-action atoms
 * yet (the wrappers ship before the projection consumes them). Tests
 * cover both states:
 *   - empty / no-data        -> empty-state copy renders, no horizontal
 *                               scroll on either viewport
 *   - populated              -> stats header, row list, filter chips
 *                               render with the right structure
 *
 * Discovery is dynamic against /api/operator-actions.list so the spec
 * stays meaningful regardless of fixture content.
 */

interface OperatorActionsListBody {
  readonly total: number;
  readonly filtered: number;
  readonly rows: ReadonlyArray<{ readonly atom_id: string; readonly actor: string; readonly action_type: string }>;
  readonly actor_facets: ReadonlyArray<{ readonly actor: string; readonly count: number }>;
  readonly action_type_facets: ReadonlyArray<{ readonly action_type: string; readonly count: number }>;
}

async function fetchList(page: Page): Promise<OperatorActionsListBody> {
  const response = await page.request.post('/api/operator-actions.list', {
    data: { limit: 100 },
  });
  expect(response.ok(), 'operator-actions.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data;
}

/**
 * Navigate to /operator-actions and wait for the view to mount.
 * Centralizes the repeated goto + visibility-check pair every test
 * starts with, per the repo duplication rule (extract at N=2).
 */
async function gotoOperatorActionsView(page: Page) {
  await page.goto('/operator-actions');
  const view = page.getByTestId('operator-actions-view');
  await expect(view).toBeVisible({ timeout: 10_000 });
  return view;
}

test.describe('operator-actions audit trail', () => {
  test('renders the page header and either an empty state or a row list', async ({ page }) => {
    const view = await gotoOperatorActionsView(page);

    // Hero title always present.
    await expect(view).toContainText('Operator actions');

    const data = await fetchList(page);

    if (data.total === 0) {
      // Empty state must be polished, not a blank page.
      await expect(page.getByTestId('operator-actions-empty-total')).toBeVisible();
      return;
    }

    // Populated: stats header + row list render.
    await expect(page.getByTestId('operator-actions-stats-total')).toBeVisible();
    const list = page.getByTestId('operator-actions-list');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('operator-actions-row').first()).toBeVisible();
  });

  test('refresh button refetches without reloading the page', async ({ page }) => {
    await gotoOperatorActionsView(page);

    const refresh = page.getByTestId('operator-actions-refresh');
    await expect(refresh).toBeVisible();

    // Mark the page so we can detect a full reload (which would clear the sentinel).
    await page.evaluate(() => {
      const w = window as unknown as { __operatorActionsMounted?: number };
      w.__operatorActionsMounted = Date.now();
    });

    await refresh.click();

    // Allow the refetch to settle; aria-busy returns to 'false' when query is idle.
    await expect(refresh).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });

    const sentinel = await page.evaluate(() => {
      const w = window as unknown as { __operatorActionsMounted?: number };
      return w.__operatorActionsMounted;
    });
    expect(sentinel, 'mount sentinel survives refresh (no reload)').toBeDefined();
  });

  test('clicking an actor filter chip narrows the list and toggles aria-pressed', async ({ page }) => {
    const data = await fetchList(page);
    test.skip(data.total === 0 || data.actor_facets.length === 0, 'no operator-action atoms; cannot verify filter');

    await gotoOperatorActionsView(page);

    const firstActor = data.actor_facets[0].actor;
    const chip = page.getByTestId(`operator-actions-actor-chip-${firstActor}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');

    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // URL reflects the filter (canon dev-web-routing-state-not-component-state-for-filters).
    await expect(page).toHaveURL(/[?&]actor=/);

    // Every visible row now matches the actor.
    const rows = page.getByTestId('operator-actions-row');
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i += 1) {
      const rowActor = await rows.nth(i).getAttribute('data-actor');
      expect(rowActor).toBe(firstActor);
    }
  });

  test('clicking a row routes to the atom-detail viewer', async ({ page }) => {
    const data = await fetchList(page);
    test.skip(data.total === 0, 'no operator-action atoms; cannot verify row click');

    await gotoOperatorActionsView(page);

    const firstRow = page.getByTestId('operator-actions-row').first();
    await expect(firstRow).toBeVisible();
    const atomId = await firstRow.getAttribute('data-atom-id');
    expect(atomId).toBeTruthy();

    await firstRow.click();

    const encodedId = encodeURIComponent(atomId!);
    const escapedForRegex = encodedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/atom/${escapedForRegex}`));
  });

  test('mobile (390px) viewport renders without horizontal scroll', async ({ page, viewport }) => {
    /*
     * The mobile project pins viewport to 390x844 (iPhone 13). The
     * desktop project also runs this test at its own viewport; the
     * width assertion is the canonical "no horizontal scroll" check
     * the canon `dev-web-mobile-first-required` enforces.
     */
    await gotoOperatorActionsView(page);

    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));

    expect(widths.scroll, `inner=${widths.inner} scroll=${widths.scroll}`).toBeLessThanOrEqual(widths.inner + 1);

    /*
     * On mobile, the Refresh button touch target meets the 44px floor
     * per `dev-web-mobile-first-required`.
     */
    if (viewport && viewport.width <= 480) {
      const refresh = page.getByTestId('operator-actions-refresh');
      const box = await refresh.boundingBox();
      expect(box, 'refresh button box').not.toBeNull();
      if (box) {
        expect(box.height, 'refresh height >= 44').toBeGreaterThanOrEqual(44);
      }
    }
  });
});

test.describe('sidebar nav', () => {
  test('exposes an Audit entry that routes to /operator-actions', async ({ page, viewport }) => {
    await page.goto('/');
    /*
     * Below 48rem the desktop nav collapses; the operator-actions entry
     * lives in the mobile overflow drawer. Skip on mobile; the desktop
     * projects exercise the primary nav here. The mobile drawer surface
     * is covered by mobile-nav-overflow.spec.ts.
     */
    if (viewport && viewport.width < 768) {
      test.skip(true, 'mobile nav covered by mobile-nav-overflow.spec.ts');
      return;
    }
    const navLink = page.getByTestId('nav-operator-actions');
    await expect(navLink).toBeVisible({ timeout: 10_000 });
    await navLink.click();
    await expect(page).toHaveURL(/\/operator-actions/);
    await expect(page.getByTestId('operator-actions-view')).toBeVisible();
  });
});
