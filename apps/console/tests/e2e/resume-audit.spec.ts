import { test, expect, type Page } from '@playwright/test';

/**
 * Resume audit dashboard e2e.
 *
 * Operator concern: the resume-by-default substrate (Phases 1-3 of
 * the resume-by-default extension) writes resume telemetry on every
 * `agent-session` atom but had no visual surface. The /resume route
 * is the cross-actor projection: per-principal ratio cards, recent
 * resumed sessions, and recent operator-reset signals.
 *
 * Atom-store on the test machine may or may not have agent-session
 * atoms with the new `extra.resume_attempt` field set (most actors
 * have not started writing it yet). Tests cover both states:
 *   - empty / no-telemetry  -> empty-state copy renders, no horizontal
 *                              scroll on either viewport
 *   - populated             -> ratio cards, recent rows, resets render
 *                              with the right structure
 *
 * The bottom sheet of "structural" assertions (no horizontal scroll,
 * tap targets, headers) runs in both cases; coverage scales with the
 * data the dev's machine happens to have.
 *
 * Discovery is dynamic against /api/resume.summary so the spec stays
 * meaningful regardless of fixture content.
 */

interface ResumePrincipalRow {
  readonly principal_id: string;
  readonly total_sessions: number;
}

interface ResumeSummary {
  readonly principals: ReadonlyArray<ResumePrincipalRow>;
  readonly total_sessions: number;
  readonly window_hours: number;
}

async function fetchSummary(page: Page): Promise<ResumeSummary> {
  const response = await page.request.post('/api/resume.summary');
  expect(response.ok(), 'resume.summary should return 200').toBe(true);
  const body = await response.json();
  return body?.data;
}

/**
 * Navigate to /resume and wait for the view to mount. Centralizes the
 * repeated goto + visibility-check pair that every test in this spec
 * starts with, per the repo duplication rule (extract at N=2). Returns
 * the view locator for chained assertions in the caller.
 */
async function gotoResumeView(page: Page) {
  await page.goto('/resume');
  const view = page.getByTestId('resume-audit-view');
  await expect(view).toBeVisible({ timeout: 10_000 });
  return view;
}

test.describe('resume-audit dashboard', () => {
  test('renders the page header and either an empty state or the principal grid', async ({ page }) => {
    const view = await gotoResumeView(page);

    // The hero title is always present.
    await expect(view).toContainText('Resume audit');

    // Window-selector chips render in either state because they're
    // part of the SummarySection scaffolding, not the data.
    const chips = page.getByTestId('resume-audit-window-chips');
    await expect(chips).toBeVisible();
    await expect(page.getByTestId('resume-audit-window-24h')).toBeVisible();

    const summary = await fetchSummary(page);

    if (summary.total_sessions === 0) {
      // Empty state must be polished, not a blank page.
      await expect(page.getByTestId('resume-audit-summary-empty')).toBeVisible();
      return;
    }

    // Populated: principal grid renders.
    const grid = page.getByTestId('resume-audit-principal-grid');
    await expect(grid).toBeVisible();
    await expect(page.getByTestId('resume-audit-principal-card')).toHaveCount(summary.principals.length);
  });

  test('window chips toggle with aria-pressed semantics', async ({ page }) => {
    await gotoResumeView(page);

    const w24 = page.getByTestId('resume-audit-window-24h');
    const w1h = page.getByTestId('resume-audit-window-1h');

    // Default selection is 24h.
    await expect(w24).toHaveAttribute('aria-pressed', 'true');
    await expect(w1h).toHaveAttribute('aria-pressed', 'false');

    await w1h.click();
    await expect(w1h).toHaveAttribute('aria-pressed', 'true');
    await expect(w24).toHaveAttribute('aria-pressed', 'false');
  });

  test('recent + resets sections render their loading or settled state', async ({ page }) => {
    await gotoResumeView(page);

    /*
     * Each of the three sections renders one of: loading / error /
     * empty / list. Wait for at least one to materialize so the
     * assertion isn't timing-sensitive against TanStack Query's
     * first-fetch delay.
     */
    const recentLoading = page.getByTestId('resume-audit-recent-loading');
    const recentEmpty = page.getByTestId('resume-audit-recent-empty');
    const recentList = page.getByTestId('resume-audit-recent-list');
    await expect(recentLoading.or(recentEmpty).or(recentList)).toBeVisible();

    const resetsLoading = page.getByTestId('resume-audit-resets-loading');
    const resetsEmpty = page.getByTestId('resume-audit-resets-empty');
    const resetsList = page.getByTestId('resume-audit-resets-list');
    await expect(resetsLoading.or(resetsEmpty).or(resetsList)).toBeVisible();
  });

  test('reset help popover toggles and shows the decide-script invocation', async ({ page }) => {
    await gotoResumeView(page);

    const helpButton = page.getByTestId('resume-audit-reset-help-button');
    await expect(helpButton).toBeVisible();
    await expect(helpButton).toHaveAttribute('aria-expanded', 'false');
    await helpButton.click();

    const popover = page.getByTestId('resume-audit-reset-help-popover');
    await expect(popover).toBeVisible();
    await expect(helpButton).toHaveAttribute('aria-expanded', 'true');
    await expect(popover).toContainText('decide.mjs');
    await expect(popover).toContainText('resume-reset');
  });

  test('mobile (390px) viewport renders without horizontal scroll', async ({ page, viewport }) => {
    /*
     * The mobile project pins viewport to 390x844 (iPhone 13). The
     * desktop project also runs this test at its own viewport; the
     * width assertion is the canonical "no horizontal scroll" check
     * the canon `dev-web-mobile-first-required` enforces. Read
     * window.innerWidth + scrollWidth at runtime so the test stays
     * meaningful regardless of which project is running.
     */
    await gotoResumeView(page);

    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));

    // Allow a 1px tolerance for sub-pixel layout rounding.
    expect(widths.scroll, `inner=${widths.inner} scroll=${widths.scroll}`).toBeLessThanOrEqual(widths.inner + 1);

    /*
     * On mobile, the window-chip touch targets meet the 44px floor
     * per `dev-web-mobile-first-required`. Pick the 24h chip and
     * check its bounding box.
     */
    if (viewport && viewport.width <= 480) {
      const w24 = page.getByTestId('resume-audit-window-24h');
      const box = await w24.boundingBox();
      expect(box, 'chip box').not.toBeNull();
      if (box) {
        expect(box.height, 'chip height >= 44').toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('click-through from a populated principal card routes to /principals', async ({ page }) => {
    const summary = await fetchSummary(page);
    test.skip(summary.principals.length === 0, 'no agent-session atoms in window; cannot verify click-through');

    await gotoResumeView(page);

    const firstCard = page.getByTestId('resume-audit-principal-card').first();
    await expect(firstCard).toBeVisible();

    const principalId = await firstCard.getAttribute('data-principal-id');
    expect(principalId).toBeTruthy();

    // Click the principal name link inside the card.
    await firstCard.getByTestId('resume-audit-principal-link').click();

    // Routes to /principals/<id>. encodeURIComponent + a full
    // regex-metacharacter escape on the encoded id keeps the URL
    // assertion robust against any principal-id charset (dots,
    // hyphens, parens, etc.) without relying on a partial escape.
    const encodedId = encodeURIComponent(principalId!);
    const escapedForRegex = encodedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/principals/${escapedForRegex}`));
  });
});

test.describe('sidebar nav', () => {
  test('exposes a Resume entry that routes to /resume', async ({ page, viewport }) => {
    await page.goto('/');
    /*
     * Below 48rem the desktop nav is hidden; the entry then lives in
     * the mobile overflow drawer. Skip on mobile since exercising the
     * drawer is its own spec; the desktop projects exercise the
     * primary nav here.
     */
    if (viewport && viewport.width < 768) {
      test.skip(true, 'mobile nav covered by mobile-nav-overflow.spec.ts');
      return;
    }
    const navLink = page.getByTestId('nav-resume');
    await expect(navLink).toBeVisible({ timeout: 10_000 });
    await navLink.click();
    await expect(page).toHaveURL(/\/resume/);
    await expect(page.getByTestId('resume-audit-view')).toBeVisible();
  });
});

test.describe('resume-audit last-refreshed indicator', () => {
  /*
   * Each test in this describe block freezes the page clock to a
   * deterministic origin, then calls `fastForward(...)` to drive the
   * 1-second tick without paying a real-time wait. Hoisted into a
   * `beforeEach` so the install line is single-source per CR feedback
   * (DRY at N=2 within this describe block).
   */
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-05-05T14:00:00Z') });
  });

  test('renders "0 seconds ago" on mount, ticks to 1 second after one second', async ({ page }) => {
    await gotoResumeView(page);

    const indicator = page.getByTestId('resume-audit-last-refreshed');
    await expect(indicator).toBeVisible();
    /*
     * On mount, lastRefreshedAt and now are both Date.now() so the
     * elapsed-seconds clamp evaluates to 0. `Intl.RelativeTimeFormat`
     * with `numeric: 'always'` emits "0 seconds ago" for 0.
     */
    await expect(indicator).toHaveText(/Last refreshed 0 seconds? ago/);

    await page.clock.fastForward(1100);
    await expect(indicator).toHaveText(/Last refreshed 1 second ago/);

    await page.clock.fastForward(2000);
    await expect(indicator).toHaveText(/Last refreshed 3 seconds ago/);
  });

  test('clicking Refresh resets the indicator back to 0 seconds', async ({ page }) => {
    await gotoResumeView(page);

    const indicator = page.getByTestId('resume-audit-last-refreshed');
    await page.clock.fastForward(5000);
    await expect(indicator).toHaveText(/Last refreshed 5 seconds ago/);

    /*
     * Click the Refresh button - onClick must call
     * setLastRefreshedAt(Date.now()) synchronously so the indicator
     * snaps back to "0 seconds ago" on the next render. The button
     * also kicks off the three refetches but those are not the
     * subject of this test.
     */
    await page.getByTestId('resume-audit-refresh').click();
    await expect(indicator).toHaveText(/Last refreshed 0 seconds? ago/);
  });

  test('changing the window chip also resets the indicator (data is fresh)', async ({ page }) => {
    /*
     * Window-chip clicks flip the summaryQuery key, so TanStack
     * Query auto-refetches and the data is fresh from that instant.
     * The indicator must reset alongside or it would falsely report
     * stale-data semantics against just-loaded data. Regression
     * guard for the CR-flagged window-chip-change path.
     */
    await gotoResumeView(page);

    const indicator = page.getByTestId('resume-audit-last-refreshed');
    await page.clock.fastForward(7000);
    await expect(indicator).toHaveText(/Last refreshed 7 seconds ago/);

    await page.getByTestId('resume-audit-window-1h').click();
    await expect(indicator).toHaveText(/Last refreshed 0 seconds? ago/);
  });
});

test.describe('resume-audit refresh button', () => {
  test('refetches all three sections without reloading the page', async ({ page }) => {
    interface Hold {
      readonly release: () => void;
      readonly promise: Promise<void>;
    }
    const makeHold = (): Hold => {
      let release!: () => void;
      const promise = new Promise<void>((r) => { release = r; });
      return { release, promise };
    };

    let summaryHits = 0;
    let recentHits = 0;
    let resetsHits = 0;
    const holds: Hold[] = [];
    let holdNext = false;

    const installRoute = async (
      glob: string,
      bump: () => void,
    ) => {
      await page.route(glob, async (route) => {
        bump();
        if (holdNext) {
          const h = makeHold();
          holds.push(h);
          await h.promise;
        }
        await route.continue();
      });
    };
    await installRoute('**/api/resume.summary', () => { summaryHits += 1; });
    await installRoute('**/api/resume.recent', () => { recentHits += 1; });
    await installRoute('**/api/resume.resets', () => { resetsHits += 1; });

    await gotoResumeView(page);
    await expect.poll(
      () => summaryHits >= 1 && recentHits >= 1 && resetsHits >= 1,
      { timeout: 10_000 },
    ).toBe(true);

    const baselineSummary = summaryHits;
    const baselineRecent = recentHits;
    const baselineResets = resetsHits;

    await page.evaluate(() => {
      const w = window as unknown as { __resumeAuditMounted?: number; __resumeAuditUnloaded?: boolean };
      w.__resumeAuditMounted = Date.now();
      window.addEventListener('beforeunload', () => { w.__resumeAuditUnloaded = true; });
    });

    holdNext = true;
    const refresh = page.getByTestId('resume-audit-refresh');
    await expect(refresh).toBeVisible();
    await refresh.click();

    const spinner = page.getByTestId('resume-audit-refresh-spinner');
    const spinnerActive = async (): Promise<boolean> => {
      const visible = await spinner.isVisible().catch(() => false);
      const ariaBusy = await refresh.getAttribute('aria-busy').catch(() => null);
      return visible || ariaBusy === 'true';
    };
    await expect.poll(spinnerActive, { timeout: 5_000 }).toBe(true);

    await expect.poll(() => holds.length, { timeout: 10_000 }).toBe(3);
    holds.forEach((h) => h.release());

    await expect.poll(() => summaryHits - baselineSummary).toBe(1);
    await expect.poll(() => recentHits - baselineRecent).toBe(1);
    await expect.poll(() => resetsHits - baselineResets).toBe(1);

    await expect(refresh).toHaveAttribute('aria-busy', 'false');

    const sentinel = await page.evaluate(() => {
      const w = window as unknown as { __resumeAuditMounted?: number; __resumeAuditUnloaded?: boolean };
      return { mounted: w.__resumeAuditMounted, unloaded: w.__resumeAuditUnloaded };
    });
    expect(sentinel.mounted, 'mount sentinel survives refresh (no reload)').toBeDefined();
    expect(sentinel.unloaded, 'beforeunload should not fire').toBeFalsy();
  });
});
