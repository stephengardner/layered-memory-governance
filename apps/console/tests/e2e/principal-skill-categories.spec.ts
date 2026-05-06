import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

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
 * Discovery, not hardcoding: a previous draft of this spec pinned
 * specific principal ids (apex-agent, claude-agent, cto-actor,
 * code-author). That coupled the test to one org's concrete shape
 * and would false-fail on a fresh install or a divergent fixture.
 * Per the same substrate discipline that keeps role names out of
 * src/, the spec discovers principals at runtime via
 * /api/principals.list + /api/principals.skill and selects ONE
 * representative per category from whatever the store contains. If
 * no principal in the live store classifies into a given category,
 * that test skips rather than false-fails.
 *
 * Coverage shape:
 *   - One representative principal per category found by querying
 *     the same skill endpoint the UI consumes.
 *   - Each test asserts the data-category landmark + the visible
 *     copy phrase that distinguishes the branch from its peers.
 *   - Mobile viewport assertions (no horizontal scroll, 44px touch
 *     targets) live in principal-mobile.spec.ts and are not redone
 *     here.
 */

/**
 * Default timeout for visibility assertions on the principal-detail
 * surface. Centralised so future tuning (CI flake, slow-machine
 * envelope) is one edit. 10 seconds is the same envelope used by
 * principal-mobile.spec.ts and principal-drilldown.spec.ts; staying
 * aligned avoids drift across the principal-detail spec family.
 */
const VISIBLE_TIMEOUT_MS = 10_000;

type Category =
  | 'authority-root'
  | 'authority-anchor'
  | 'actor-with-skill'
  | 'actor-skill-debt';

interface PrincipalListEntry {
  readonly id: string;
}

interface PrincipalSkillResponse {
  readonly category: Category;
  readonly content: string | null;
}

/**
 * Validate the API envelope and extract the array of principals. The
 * console server returns either `{ ok: true, data: [...] }` or a bare
 * array (legacy shape); anything else is an envelope error. Returns
 * the array or null on shape mismatch so callers can decide whether
 * to skip vs fail.
 */
function extractPrincipalArray(body: unknown): ReadonlyArray<PrincipalListEntry> | null {
  if (Array.isArray(body)) return body as ReadonlyArray<PrincipalListEntry>;
  if (body && typeof body === 'object' && 'data' in body) {
    const data = (body as { data: unknown }).data;
    if (Array.isArray(data)) return data as ReadonlyArray<PrincipalListEntry>;
  }
  return null;
}

/**
 * Same envelope-aware extraction for the per-principal skill response.
 * Returns null when the wire shape does not match what the test
 * expects so the discovery loop can skip the principal cleanly.
 */
function extractSkillResponse(body: unknown): PrincipalSkillResponse | null {
  if (body && typeof body === 'object' && 'category' in body) {
    return body as PrincipalSkillResponse;
  }
  if (body && typeof body === 'object' && 'data' in body) {
    const data = (body as { data: unknown }).data;
    if (data && typeof data === 'object' && 'category' in data) {
      return data as PrincipalSkillResponse;
    }
  }
  return null;
}

/**
 * Walk every principal id in the store and return the first id whose
 * skill response classifies into the requested category. Returns null
 * when the live store contains no principal of that category so the
 * caller can skip rather than false-fail. Cap the walk at the first
 * match because one representative is enough to exercise the empty-
 * state branch; the classifier itself is unit-tested exhaustively.
 */
async function findPrincipalByCategory(
  request: APIRequestContext,
  category: Category,
): Promise<string | null> {
  const listRes = await request.post('/api/principals.list');
  expect(listRes.ok(), 'principals.list endpoint should return 200').toBe(true);
  const principals = extractPrincipalArray(await listRes.json());
  if (principals === null) {
    throw new Error('principals.list returned an unexpected payload shape');
  }
  for (const p of principals) {
    const skillRes = await request.post('/api/principals.skill', {
      data: { principal_id: p.id },
    });
    if (!skillRes.ok()) continue;
    const skill = extractSkillResponse(await skillRes.json());
    if (skill !== null && skill.category === category) return p.id;
  }
  return null;
}

/**
 * Common navigation: drive the page to /principals/<id>, wait for
 * the principal-card to mount, and return. Each test then asserts
 * its category-specific landmark and copy. Pulling the navigation
 * into a helper keeps the tests focused on the assertion they own.
 */
async function gotoPrincipal(page: Page, id: string): Promise<void> {
  await page.goto(`/principals/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: VISIBLE_TIMEOUT_MS });
}

test.describe('principal-skill empty-state categories', () => {
  test('renders the authority-root empty state for an apex principal', async ({ page, request }) => {
    const id = await findPrincipalByCategory(request, 'authority-root');
    test.skip(id === null, 'no authority-root principal in fixture');
    await gotoPrincipal(page, id!);

    const empty = page.locator('[data-testid="principal-skill-empty"][data-category="authority-root"]');
    await expect(empty).toBeVisible({ timeout: VISIBLE_TIMEOUT_MS });
    /*
     * Phrase-level assertion (not whole sentence) keeps the test
     * resilient to copy edits while still catching the regression
     * where the renderer fell back to actor-skill-debt copy for an
     * authority-root principal.
     */
    await expect(empty).toContainText('authority root');
    await expect(empty).toContainText('by design');
  });

  test('renders the authority-anchor empty state for a trust-relay principal', async ({ page, request }) => {
    const id = await findPrincipalByCategory(request, 'authority-anchor');
    test.skip(id === null, 'no authority-anchor principal in fixture');
    await gotoPrincipal(page, id!);

    const empty = page.locator('[data-testid="principal-skill-empty"][data-category="authority-anchor"]');
    await expect(empty).toBeVisible({ timeout: VISIBLE_TIMEOUT_MS });
    /*
     * "trust-relay" + "signs other" together pin the substantive
     * distinction the empty-state copy carries: an anchor is the
     * parent that signs leaf actors, not a leaf itself. If a
     * regression collapses anchor copy back to leaf-debt copy, this
     * assertion fails.
     */
    await expect(empty).toContainText('trust-relay');
    await expect(empty).toContainText('signs other');
  });

  test('renders the actor-with-skill content panel when a SKILL.md exists', async ({ page, request }) => {
    /*
     * actor-with-skill is the only category that takes the content
     * branch instead of an empty state. The data-category attribute
     * lives on the content panel so Playwright can assert the
     * empty-vs-content selection without scraping the markdown body.
     */
    const id = await findPrincipalByCategory(request, 'actor-with-skill');
    test.skip(id === null, 'no actor-with-skill principal in fixture');
    await gotoPrincipal(page, id!);

    const content = page.locator('[data-testid="principal-skill-content"][data-category="actor-with-skill"]');
    await expect(content).toBeVisible({ timeout: VISIBLE_TIMEOUT_MS });
  });

  test('renders the actor-skill-debt empty state for a leaf actor with no SKILL.md', async ({ page, request }) => {
    const id = await findPrincipalByCategory(request, 'actor-skill-debt');
    test.skip(id === null, 'no actor-skill-debt principal in fixture');
    await gotoPrincipal(page, id!);

    const empty = page.locator('[data-testid="principal-skill-empty"][data-category="actor-skill-debt"]');
    await expect(empty).toBeVisible({ timeout: VISIBLE_TIMEOUT_MS });
    /*
     * Skill-debt copy must reference the missing SKILL.md path AND
     * frame the absence as authoring debt; both signals together
     * separate this branch from the by-design branches. The path
     * assertion uses the discovered id so it stays accurate
     * regardless of which leaf actor we picked.
     */
    await expect(empty).toContainText(`.claude/skills/${id}/SKILL.md`);
    await expect(empty).toContainText('authoring debt');
  });
});
