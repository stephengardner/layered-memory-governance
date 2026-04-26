import { test, expect } from '@playwright/test';

/**
 * Actor Activity Stream e2e.
 *
 * The route renders a "control tower" feed of recent atom writes
 * grouped by principal. Auto-refresh fires every 5 seconds via
 * TanStack `refetchInterval`; the test asserts the feed renders, that
 * each entry carries the four required structural pieces (principal
 * pill, atom link, time, content excerpt), and that the auto-refresh
 * actually retriggers the network call.
 *
 * Property-based: discovers content from the live atom store rather
 * than baking fixtures, mirroring the pattern used by
 * plan-failure-detail.spec.ts.
 */

test.describe('actor activity stream', () => {
  test('renders a feed grouped by principal with required pieces', async ({ page, request }) => {
    // Sanity-check the backend health (envelope shape) so a wiring
    // bug fails loudly here rather than as a dangling Playwright
    // timeout. We do NOT use the API sample to decide whether to
    // assert on rendered data — the store is mutating live (that's
    // the whole point of this view), so the entry_count we sample
    // here is not necessarily the entry_count the page renders. Skip
    // gating happens later, against the rendered DOM.
    const apiResponse = await request.post('/api/actor-activity.stream', {
      data: { limit: 100 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(apiResponse.ok(), 'actor-activity.stream endpoint should return 200').toBe(true);
    const payload = await apiResponse.json();
    expect(payload?.ok, 'envelope.ok should be true').toBe(true);
    const data = payload?.data ?? {};
    expect(Array.isArray(data.groups), 'data.groups must be an array').toBe(true);
    expect(typeof data.entry_count, 'data.entry_count must be a number').toBe('number');
    expect(typeof data.principal_count, 'data.principal_count must be a number').toBe('number');
    expect(typeof data.generated_at, 'data.generated_at must be an ISO string').toBe('string');

    await page.goto('/actor-activity');

    // Sidebar reflects the current route.
    const navLink = page.getByTestId('nav-actor-activity');
    await expect(navLink).toHaveAttribute('aria-current', 'page');

    // Wait for either the rendered feed or the empty-state shell so
    // we know the first fetch resolved before we make a skip
    // decision. Skipping based on a pre-flight API sample is racy:
    // the store can mutate between the probe and the render.
    await Promise.race([
      page.getByTestId('actor-activity-feed').waitFor({ state: 'visible', timeout: 10_000 }),
      page.getByTestId('actor-activity-empty').waitFor({ state: 'visible', timeout: 10_000 }),
    ]);

    // If the rendered state is the empty-state, there is no feed
    // shape to assert; skip with a clear reason.
    const emptyVisible = await page.getByTestId('actor-activity-empty').isVisible();
    if (emptyVisible) {
      test.skip(true, 'rendered empty state; cannot assert timeline shape');
    }

    // Live indicator is visible.
    await expect(page.getByTestId('actor-activity-live')).toBeVisible({ timeout: 10_000 });

    // At least one chunk and one entry render.
    const firstChunk = page.getByTestId('actor-activity-chunk').first();
    await expect(firstChunk).toBeVisible({ timeout: 10_000 });

    const firstEntry = page.getByTestId('actor-activity-entry').first();
    await expect(firstEntry).toBeVisible();

    // Each entry has the four structural pieces: principal pill on the
    // chunk header, an atom link, a timestamp, and the entry data
    // attributes (atom-id + atom-type) populated.
    const principalPill = firstChunk.getByTestId('actor-activity-principal-pill').first();
    await expect(principalPill).toBeVisible();
    const principalId = await principalPill.getAttribute('data-principal-id');
    expect(principalId, 'principal pill must carry data-principal-id').toBeTruthy();
    expect(principalId!.length, 'principal id must be non-empty').toBeGreaterThan(0);

    const atomLink = firstEntry.getByTestId('actor-activity-atom-link');
    await expect(atomLink).toBeVisible();
    const atomId = await atomLink.getAttribute('data-atom-ref-id');
    expect(atomId, 'atom link must carry data-atom-ref-id').toBeTruthy();

    const time = firstEntry.getByTestId('actor-activity-time');
    await expect(time).toBeVisible();
    const dateTime = await time.getAttribute('datetime');
    expect(dateTime, 'time must carry an ISO datetime attribute').toBeTruthy();

    const entryAtomId = await firstEntry.getAttribute('data-atom-id');
    const entryAtomType = await firstEntry.getAttribute('data-atom-type');
    expect(entryAtomId).toBeTruthy();
    expect(entryAtomType).toBeTruthy();
  });

  test('auto-refresh fires (network call repeats)', async ({ page }) => {
    /*
     * Auto-refresh assertion. We count the number of POST requests to
     * /api/actor-activity.stream over a short window; the
     * refetchInterval is 5s in the component, and at least one extra
     * fire should land within 7s. We avoid asserting an exact count
     * because Playwright's wallclock can lag; we only assert
     * monotonic growth past the initial mount.
     */
    let callCount = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/actor-activity.stream') && req.method() === 'POST') {
        callCount++;
      }
    });

    await page.goto('/actor-activity');

    // Wait for either feed or empty state so the first call has resolved.
    await Promise.race([
      page.getByTestId('actor-activity-feed').waitFor({ state: 'visible', timeout: 10_000 }),
      page.getByTestId('actor-activity-empty').waitFor({ state: 'visible', timeout: 10_000 }),
    ]);

    // TanStack Query v5 pauses refetchInterval when the page loses
    // focus (default refetchIntervalInBackground=false). Headless CI
    // runners with virtual displays sometimes drop focus and stall
    // the poll, which would flake this test. bringToFront is a cheap
    // guard that keeps the page focused for the assertion window.
    await page.bringToFront();

    const baseline = callCount;
    expect(baseline, 'mount must trigger at least one fetch').toBeGreaterThanOrEqual(1);

    // Poll for an additional call. With refetchInterval=5s, we expect
    // a second fire within 7-8s; allow 12s as a generous CI ceiling.
    await expect.poll(() => callCount, { timeout: 12_000, intervals: [500, 750, 1000] }).toBeGreaterThan(baseline);
  });

  test('clicking an atom link navigates to the atom view', async ({ page, request }) => {
    const apiResponse = await request.post('/api/actor-activity.stream', {
      data: { limit: 100 },
      headers: { 'Content-Type': 'application/json' },
    });
    const payload = await apiResponse.json();
    if ((payload?.data?.entry_count ?? 0) === 0) {
      test.skip(true, 'no atoms in store');
    }

    await page.goto('/actor-activity');
    const firstAtomLink = page.getByTestId('actor-activity-atom-link').first();
    await firstAtomLink.waitFor({ state: 'visible', timeout: 10_000 });
    const atomId = await firstAtomLink.getAttribute('data-atom-ref-id');
    const targetRoute = await firstAtomLink.getAttribute('data-atom-ref-target');
    expect(atomId).toBeTruthy();
    expect(targetRoute).toBeTruthy();

    await firstAtomLink.click();
    const escaped = encodeURIComponent(atomId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/${targetRoute}/${escaped}$`));
  });
});
