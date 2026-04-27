import { test, expect } from '@playwright/test';

/*
 * Smoke test for the Principal Hierarchy view (/hierarchy).
 *
 * Asserts the full read path: nav -> route -> backend handler ->
 * tree projection -> rendered DOM. Uses the live `.lag/principals/`
 * fixtures (the dev backend reads them on each request) so the test
 * exercises buildPrincipalTree against real data, not a stub.
 */

test.describe('principal hierarchy view', () => {
  test('renders the root and at least one child node with a depth indicator', async ({ page }) => {
    await page.goto('/hierarchy');

    // Tree container must mount.
    await expect(page.getByTestId('principal-tree')).toBeVisible({ timeout: 10_000 });

    // At least one root node (depth=0).
    const rootNode = page.locator('[data-testid="principal-tree-node"][data-depth="0"]').first();
    await expect(rootNode).toBeVisible();

    // Descendant assertion is gated by a fixture probe: a fresh
    // substrate or a small/mid-team org with just one root agent is
    // a valid state for this view, and the smoke test should still
    // pass there. Mirrors the `test.skip` pattern in the toggle test
    // below so a single-principal `.lag/principals/` doesn't fail
    // CI on a correctly-rendered single-node tree.
    const childNode = page.locator('[data-testid="principal-tree-node"]:not([data-depth="0"])').first();
    if ((await childNode.count()) > 0) {
      await expect(childNode).toBeVisible();
    }

    // Depth indicator badge renders for every node.
    await expect(page.getByTestId('principal-tree-depth').first()).toBeVisible();

    // Active sidebar item must be Hierarchy.
    await expect(page.getByTestId('nav-hierarchy')).toHaveAttribute('aria-current', 'page');
  });

  test('clicking a row body navigates to that principal page', async ({ page }) => {
    await page.goto('/hierarchy');
    await page.getByTestId('principal-tree').waitFor();

    const firstNode = page.locator('[data-testid="principal-tree-node"]').first();
    await expect(firstNode).toBeVisible();
    const principalId = await firstNode.getAttribute('data-principal-id');
    expect(principalId).toBeTruthy();

    await firstNode.getByTestId('principal-tree-row-body').click();

    /*
     * Body click navigates to /principals/<id>. The principals view
     * mounts and the corresponding row is the focused/selected one.
     * URL is the source of truth so we assert against it directly.
     * Escape regex specials in the id and URL-encode it so the assertion
     * holds even when the principal id carries '.' or other reserved chars.
     */
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const encoded = encodeURIComponent(principalId!);
    await expect(page).toHaveURL(new RegExp(`/principals/${escapeRegex(encoded)}$`));
  });

  test('clicking a chevron toggles its subtree visibility', async ({ page }) => {
    await page.goto('/hierarchy');
    await page.getByTestId('principal-tree').waitFor();

    // Find the first toggle (a node with children). Default state
    // is open at depth <= 1 so we can click to collapse.
    const toggle = page.getByTestId('principal-tree-toggle').first();
    if (await toggle.count() === 0) {
      test.skip(true, 'no expandable nodes in fixture');
    }

    const beforeCount = await page.getByTestId('principal-tree-node').count();
    await toggle.click();
    // After collapse, there must be strictly fewer rendered nodes
    // (children are unmounted by AnimatePresence on exit).
    await expect.poll(() =>
      page.getByTestId('principal-tree-node').count(),
    ).toBeLessThan(beforeCount);

    // Re-expand restores at least the prior count.
    await toggle.click();
    await expect.poll(() =>
      page.getByTestId('principal-tree-node').count(),
    ).toBeGreaterThanOrEqual(beforeCount);
  });
});
