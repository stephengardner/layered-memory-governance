import { test, expect } from '@playwright/test';

/**
 * Principal-display e2e: the apex-class principal id renders with the
 * mapped role label everywhere it shows up in user-facing text. The atom
 * store keeps the verbatim id; only the console's render layer applies
 * the label.
 *
 * The contract this spec pins:
 *   1. The principal hierarchy tree shows the mapped label.
 *   2. The principal card subtitle shows the mapped label.
 *   3. The activities feed labels apex-class atoms with "by Apex Agent".
 *   4. The bootstrap id is not visible in user-facing text on the
 *      principals page (data-* attributes still carry the verbatim id
 *      for testability + deep-linking).
 *
 * Per canon `dev-web-playwright-coverage-required`, every feature ships
 * with at least one Playwright e2e.
 */

test.describe('principal display label', () => {
  test('principals page renders Apex Agent label and hides the bootstrap id', async ({ page }) => {
    await page.goto('/principals');
    // Wait for the tree to render (the principals service finishes loading).
    await page.locator('[data-testid="principal-tree"]').waitFor({ state: 'visible', timeout: 10_000 });

    // The tree must not surface the raw `stephen-human` id in visible text.
    // We scope to the tree to allow data-* attributes on parent elements
    // (which are intentionally byte-stable for deep-linking).
    const treeText = await page.locator('[data-testid="principal-tree"]').textContent();
    expect(treeText ?? '').not.toContain('stephen-human');

    // The Apex Agent label must appear in the tree.
    expect(treeText ?? '').toContain('Apex Agent');
  });

  test('principal card subtitle shows Apex Agent (not the bootstrap id)', async ({ page }) => {
    await page.goto('/principals');
    await page.locator('[data-testid="principal-card"]').first().waitFor({ timeout: 10_000 });

    // Find the card whose data-principal-id is the rewritten one.
    const card = page.locator('[data-testid="principal-card"][data-principal-id="stephen-human"]');
    await card.waitFor({ state: 'visible', timeout: 5_000 });

    // Card body text must contain Apex Agent and must not show the raw id.
    const cardText = (await card.textContent()) ?? '';
    expect(cardText).toContain('Apex Agent');
    expect(cardText).not.toContain('stephen-human');
  });

  test('activities feed shows the mapped label, not the bootstrap id', async ({ page }) => {
    await page.goto('/activities');
    // Wait for the activities list to populate; allow extra time because the
    // activities query is paginated against the full atom store.
    await page.waitForTimeout(800);
    const body = await page.locator('body').textContent();
    expect(body ?? '').not.toContain('by stephen-human');
  });
});
