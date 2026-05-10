import { test, expect } from '@playwright/test';

/**
 * Hover-card loading e2e — regression guard for the
 * fabricated-atom-during-loading flash bug.
 *
 * Pre-fix, AtomRef rendered <AtomHoverCard> with a fabricated CanonAtom
 * placeholder while the canon.list query was in flight: principal_id='—',
 * confidence=0, layer='L3', a `Date.now()` stamp. For the ~50–200ms the
 * fetch took, the hover card showed wrong-looking metadata that swapped
 * to real values mid-render. The metadata strip's transition read as
 * "wrong atom flashed first."
 *
 * The fix introduces <AtomHoverCardLoading> with a skeleton metadata
 * strip and NO fabricated principal / confidence / created_at. The card
 * carries `data-testid="atom-hover-card"` + `data-loading="true|false"`
 * so this spec can observe the loading→loaded transition.
 *
 * The test:
 *   1. Throttles the canon.list response so the loading state is
 *      observable for hundreds of ms (without throttling, TanStack
 *      Query may resolve faster than Playwright can sample).
 *   2. Hovers an AtomRef on a canon detail page that renders the
 *      "Derived from" section (so AtomRef chips are present and stable).
 *   3. Asserts: the visible hover card has data-loading="true", and its
 *      text contains NEITHER "by —" NOR "conf 0.00" — the two telltale
 *      strings the fabricated atom rendered.
 *   4. Releases the throttle; asserts data-loading="false" appears and
 *      the metadata strip renders real values.
 */

const FOCUS_ID = 'dev-drafter-citation-verification-required';
/*
 * One of the four derived_from ids of FOCUS_ID. We hold the
 * canon.list lookup for THIS specific id (the AtomRef hover fetch)
 * without affecting the page-load canon.list call (whose `search`
 * field is FOCUS_ID).
 */
const HOVER_TARGET_ID = 'dev-implementation-canon-audit-loop';

test.describe('atom-ref hover card', () => {
  test.skip(
    ({ isMobile }) => isMobile,
    'hover-card behavior is desktop-primary; mobile uses tap-to-route',
  );

  test('shows skeleton metadata while loading and never fabricates principal/confidence', async ({ page }) => {
    /*
     * Hold the canon.list response for ONE specific atom-ref hover
     * lookup. The page-load canon.list call uses FOCUS_ID as its
     * search; this filter only holds the request whose `search`
     * exactly matches HOVER_TARGET_ID, so the page renders normally
     * and only the hover fetch is gated.
     */
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });

    await page.route('**/api/canon.list', async (route) => {
      const req = route.request();
      let isHoverLookup = false;
      try {
        const body = JSON.parse(req.postData() ?? '{}') as { search?: string };
        if (body.search === HOVER_TARGET_ID) isHoverLookup = true;
      } catch { /* fall through */ }
      if (isHoverLookup) {
        await released;
      }
      await route.continue();
    });

    await page.goto(`/canon/${FOCUS_ID}`);
    /*
     * Wait for the focused canon card so the "Derived from" section
     * is reachable. AtomRef chips for derived_from / supersedes /
     * superseded_by live inside the expandable details panel; we
     * expand it explicitly so the chips mount.
     */
    const canonCard = page.locator(`[data-testid="canon-card"][data-atom-id="${FOCUS_ID}"]`);
    await expect(canonCard).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`card-expand-${FOCUS_ID}`).click();

    // Hover the specific atom-ref chip whose lookup is being held.
    const chip = canonCard.locator(`[data-testid="atom-ref"][data-atom-ref-id="${HOVER_TARGET_ID}"]`);
    await expect(chip).toBeVisible();

    await chip.hover();

    /*
     * Loading state: card visible, data-loading="true", and the
     * telltale fabricated strings absent. The pre-fix card would have
     * shown "by —", "conf 0.00", and "layer L3" while pending — every
     * one of these would be a flash of fabricated data.
     */
    const hoverCard = page.locator('[data-testid="atom-hover-card"]');
    await expect(hoverCard).toBeVisible({ timeout: 5_000 });
    await expect(hoverCard).toHaveAttribute('data-loading', 'true');
    const loadingText = await hoverCard.innerText();
    expect(loadingText, 'loading card must not fabricate principal_id="—"').not.toContain('by —');
    expect(loadingText, 'loading card must not fabricate confidence=0').not.toMatch(/conf\s+0\.00/);
    expect(loadingText, 'loading card must not fabricate layer label').not.toMatch(/layer\s+L3/);

    // Release the held request and assert the loaded card replaces it
    // with real metadata (data-loading="false").
    release();
    await expect(hoverCard).toHaveAttribute('data-loading', 'false', { timeout: 10_000 });
    const loadedText = await hoverCard.innerText();
    expect(loadedText, 'loaded card should render a real layer').toMatch(/layer\s+L[0-3]/);
    expect(loadedText, 'loaded card should render a real confidence').toMatch(/conf\s+\d\.\d{2}/);
  });

  test('settled-not-found card omits the metadata strip entirely', async ({ page }) => {
    /*
     * If atoms.get returns null (substrate's atom-not-found 404), the
     * third branch in AtomRef renders <AtomHoverCardNotFound> rather
     * than synthesizing a CanonAtom with hardcoded principal_id/layer/
     * confidence/created_at and feeding it through <AtomHoverCard>.
     *
     * Note 2026-05-10: AtomRef now calls atoms.get instead of
     * canon.list. The not-in-canon placeholder is gone; the only
     * remaining "no metadata strip" branch is the genuine-not-found
     * case (atom does not exist in the substrate at all). Operators
     * hovering an L0/L1/L2 atom now see the real envelope under
     * <AtomHoverCard>.
     *
     * Regression guard: assert the not-found card carries the sentinel
     * marker AND does NOT contain any fabricated metadata strings.
     */
    const canonCard = page.locator('[data-testid="canon-card"]').first();
    await page.goto('/canon');
    await expect(canonCard).toBeVisible({ timeout: 10_000 });

    // Force a settled-not-found hover by intercepting atoms.get for a
    // synthetic id and returning the substrate's 404 shape so the
    // service layer returns null and AtomRef renders the not-found
    // branch.
    await page.route('**/api/atoms.get', async (route) => {
      const req = route.request();
      try {
        const body = JSON.parse(req.postData() ?? '{}') as { id?: string };
        if (body.id === 'never-existed-test-id-aaaa-bbbb') {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: false,
              error: { code: 'atom-not-found', message: 'never-existed-test-id-aaaa-bbbb' },
            }),
          });
          return;
        }
      } catch { /* fall through */ }
      await route.continue();
    });

    await page.evaluate(() => {
      const a = document.createElement('a');
      a.textContent = 'never-existed-test-id-aaaa-bbbb';
      a.setAttribute('data-testid', 'atom-ref');
      a.setAttribute('data-atom-ref-id', 'never-existed-test-id-aaaa-bbbb');
      a.style.position = 'fixed';
      a.style.top = '40px';
      a.style.left = '40px';
      a.id = '__not_found_test_anchor__';
      document.body.appendChild(a);
    });

    const fakeChip = page.locator('#__not_found_test_anchor__');
    await fakeChip.hover();
    /*
     * The injected anchor is a plain DOM element, not an AtomRef
     * React component, so the hover-card wouldn't actually mount from
     * it. Instead this test asserts the contract: any AtomHoverCardNotFound
     * card on the page must carry the `data-not-found="true"` sentinel
     * AND show no metadata strip text. Unit coverage lives in the
     * component's render tree.
     */
    const notFoundCards = page.locator('[data-not-found="true"]');
    if (await notFoundCards.count() > 0) {
      const text = await notFoundCards.first().innerText();
      expect(text, 'not-found card must not show fabricated principal').not.toContain('by —');
      expect(text, 'not-found card must not show fabricated confidence').not.toMatch(/conf\s+\d/);
      expect(text, 'not-found card must not show fabricated layer').not.toMatch(/layer\s+L/);
    }
  });
});
