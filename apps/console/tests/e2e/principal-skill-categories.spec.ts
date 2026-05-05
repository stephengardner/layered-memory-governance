import { test, expect } from '@playwright/test';

/**
 * Empty-state differentiation for the PrincipalSkill panel.
 *
 * Before this feature, a missing SKILL.md surfaced as one ambiguous
 * "no skill yet" line for three semantically different cases (apex
 * authority, anchor authority that signs others, leaf actor with
 * actual debt). The feature splits the empty surface into four
 * categories returned by the server-side classifier and exposes the
 * category on a `data-category` attribute so the four shapes are
 * independently testable.
 *
 * Each test pins a real principal that lives in the .lag/principals/
 * fixture so the spec runs against ground truth, not a synthetic
 * stub. Mapping principal id to expected category:
 *
 *   apex-agent     -> authority-root (role==='apex')
 *   claude-agent   -> authority-anchor (role==='agent', signs >=1 child)
 *   cto-actor      -> actor-with-skill (.claude/skills/cto-actor/SKILL.md)
 *   code-author    -> actor-skill-debt (leaf agent, no SKILL.md)
 *
 * The spec is project-agnostic; the principal-mobile spec carries the
 * mobile-viewport assertions for the panel chrome (no horizontal
 * scroll, 44px touch targets), so we do not redo those here.
 */

test.describe('principal-skill empty-state categories', () => {
  test('apex-agent renders authority-root empty state', async ({ page }) => {
    await page.goto('/principals/apex-agent');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });

    /*
     * Wait for the fetch to settle and assert the empty branch with
     * the exact data-category we expect. The locator combines the
     * legacy testId (so existing parity tests stay valid) with the
     * new attribute discriminator.
     */
    const empty = page.locator('[data-testid="principal-skill-empty"][data-category="authority-root"]');
    await expect(empty).toBeVisible({ timeout: 10_000 });

    /*
     * The visible copy must carry the by-design framing. Asserting
     * the phrase rather than the whole sentence keeps the test
     * resilient to minor copy edits while still catching the
     * "fell back to skill-debt copy" regression.
     */
    await expect(empty).toContainText('authority root');
    await expect(empty).toContainText('by design');
  });

  test('claude-agent renders authority-anchor empty state', async ({ page }) => {
    await page.goto('/principals/claude-agent');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });

    const empty = page.locator('[data-testid="principal-skill-empty"][data-category="authority-anchor"]');
    await expect(empty).toBeVisible({ timeout: 10_000 });

    /*
     * "trust-relay" is the substantive distinction the empty-state
     * copy carries: claude-agent is the parent that signs the leaf
     * actors. If a regression collapses anchor copy back to leaf-debt
     * copy, this assertion fails.
     */
    await expect(empty).toContainText('trust-relay');
    await expect(empty).toContainText('signs other');
  });

  test('cto-actor renders actor-with-skill content (markdown)', async ({ page }) => {
    /*
     * cto-actor ships a SKILL.md in this repo, so the response should
     * carry content and the renderer should take the content branch.
     * The content panel exposes data-category="actor-with-skill" so
     * the empty-vs-content selection is visible to Playwright without
     * scraping the markdown body.
     */
    await page.goto('/principals/cto-actor');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });

    const content = page.locator('[data-testid="principal-skill-content"][data-category="actor-with-skill"]');
    await expect(content).toBeVisible({ timeout: 10_000 });
  });

  test('code-author renders actor-skill-debt empty state', async ({ page }) => {
    /*
     * code-author is a leaf principal (signed by claude-agent, signs
     * no children, no SKILL.md). It must classify as actor-skill-debt
     * so the empty surface flags real authoring debt rather than
     * reading as by-design absence.
     */
    await page.goto('/principals/code-author');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });

    const empty = page.locator('[data-testid="principal-skill-empty"][data-category="actor-skill-debt"]');
    await expect(empty).toBeVisible({ timeout: 10_000 });

    /*
     * Skill-debt copy must reference the missing SKILL.md path AND
     * frame the absence as authoring debt; both signals together
     * separate this branch from the by-design branches.
     */
    await expect(empty).toContainText('.claude/skills/code-author/SKILL.md');
    await expect(empty).toContainText('authoring debt');
  });
});
