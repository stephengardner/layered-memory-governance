import { test, expect, type Page } from '@playwright/test';

/**
 * Audit-chain visualization e2e.
 *
 * Covers the AuditChainView panel mounted on /atom/<id>. The chain
 * walks provenance.derived_from upward from the seed; the panel is
 * collapsed by default (mobile-friendly) and expands on click.
 *
 * Coverage matrix:
 *  1. Toggle: clicking the panel header expands the body (aria-expanded
 *     flip) and the timeline renders for an atom that has at least one
 *     derived_from edge.
 *  2. Seed badge: the current atom in the chain is marked with a
 *     "this atom" badge so the operator can locate themselves in a
 *     long chain.
 *  3. Empty state: an atom with NO derived_from references shows the
 *     "no upstream provenance" empty inside the body, not a generic
 *     error or skeleton.
 *  4. Mocked transport: a canned 3-deep chain renders 3 nodes + 2
 *     edges-worth of connectors via interception, so the spec is
 *     deterministic regardless of the live fixture's chain depth.
 *
 * Both desktop (chromium) and mobile (iPhone 13) project run every
 * test per playwright.config.ts -- per canon `dev-mobile-first` every
 * feature must screenshot cleanly on 390x844.
 */

interface ListAtom {
  readonly id: string;
  readonly type: string;
  readonly provenance?: { readonly derived_from?: ReadonlyArray<string> };
}

async function fetchCanon(page: Page): Promise<ReadonlyArray<ListAtom>> {
  const response = await page.request.post('/api/canon.list');
  expect(response.ok(), 'canon.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data ?? [];
}

/**
 * Probe the audit-chain endpoint for an atom and tell us how many
 * ancestors it has. Used to PICK a fixture atom that has a non-trivial
 * chain so the toggle test is meaningful, falling back to skip when
 * the substrate has no chains (a rare fresh-install state).
 */
async function fetchAuditChainSize(page: Page, atomId: string): Promise<number | null> {
  const response = await page.request.post('/api/atoms.audit-chain', {
    data: { atom_id: atomId },
  });
  if (!response.ok()) return null;
  const body = await response.json();
  const atoms: ReadonlyArray<unknown> = body?.data?.atoms ?? [];
  return atoms.length;
}

/**
 * Shared preamble: discover the first canon atom in the fixture, skip
 * cleanly when empty, and navigate to its detail page. Extracted at
 * N=4 callers per canon `dev-extract-at-n-equals-two` so a future
 * fixture-loading change happens in one place.
 *
 * Returns the chosen atom for tests that need its id (e.g. for
 * follow-up assertions), or simply navigates when the caller does
 * not need the id.
 */
async function gotoFirstCanonAtomDetail(page: Page): Promise<ListAtom> {
  const canon = await fetchCanon(page);
  test.skip(canon.length === 0, 'no canon atoms in fixture');
  const target = canon[0]!;
  await page.goto(`/atom/${encodeURIComponent(target.id)}`);
  return target;
}

test.describe('audit-chain visualization', () => {
  test('panel renders collapsed and toggles open on click', async ({ page }) => {
    await gotoFirstCanonAtomDetail(page);

    const panel = page.getByTestId('audit-chain-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toHaveAttribute('data-open', 'false');

    const toggle = page.getByTestId('audit-chain-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('audit-chain-body')).toBeVisible();
  });

  test('renders a 3-deep chain with seed badge when transport is mocked', async ({ page }) => {
    /*
     * Mock the audit-chain endpoint with a canned 3-deep linear chain.
     * The spec then drives the toggle and asserts the rendered timeline
     * shape: 3 nodes, the seed carries the "this atom" badge, ancestors
     * do not, every node id appears in a clickable card.
     */
    await page.route('**/api/atoms.audit-chain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            atoms: [
              { id: 'seed-test', type: 'plan', layer: 'L0', content: '', principal_id: 'cto-actor', confidence: 0.9, created_at: '2026-04-29T00:00:00Z' },
              { id: 'parent-1', type: 'spec-output', layer: 'L0', content: '', principal_id: 'spec-author', confidence: 0.9, created_at: '2026-04-29T00:00:00Z' },
              { id: 'parent-2', type: 'operator-intent', layer: 'L0', content: '', principal_id: 'operator-principal', confidence: 1, created_at: '2026-04-29T00:00:00Z' },
            ],
            edges: [
              { from: 'seed-test', to: 'parent-1' },
              { from: 'parent-1', to: 'parent-2' },
            ],
            truncated: { depth_reached: false, missing_ancestors: 0 },
          },
        }),
      });
    });

    /*
     * Pick any real canon atom for the route navigation; the mock
     * intercepts the audit-chain call regardless of which atom-id we
     * are viewing, so the seed-test fixture above renders. The route
     * itself uses /atom/<real-id> so the rest of the page (atom-detail,
     * attributes) loads normally and the audit-chain panel is the only
     * piece exercising mocked data.
     */
    await gotoFirstCanonAtomDetail(page);

    await page.getByTestId('audit-chain-toggle').click();

    const timeline = page.getByTestId('audit-chain-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });
    await expect(timeline).toHaveAttribute('data-node-count', '3');

    // Three nodes, in seed-then-ancestor order.
    await expect(page.getByTestId('audit-chain-node-seed-test')).toBeVisible();
    await expect(page.getByTestId('audit-chain-node-parent-1')).toBeVisible();
    await expect(page.getByTestId('audit-chain-node-parent-2')).toBeVisible();

    // Seed badge marks the current atom only.
    await expect(page.getByTestId('audit-chain-seed-badge')).toBeVisible();
    await expect(page.getByTestId('audit-chain-seed-badge')).toHaveCount(1);

    // The seed card carries data-is-seed="true".
    await expect(page.getByTestId('audit-chain-card-seed-test')).toHaveAttribute(
      'data-is-seed',
      'true',
    );
    await expect(page.getByTestId('audit-chain-card-parent-1')).toHaveAttribute(
      'data-is-seed',
      'false',
    );
  });

  test('renders the empty state when the seed has no upstream provenance', async ({ page }) => {
    /*
     * Mock the endpoint to return ONLY the seed (no ancestors). The
     * panel should show the "no upstream provenance" empty state inside
     * the body rather than render an empty timeline ul.
     */
    await page.route('**/api/atoms.audit-chain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            atoms: [
              { id: 'lonely-seed', type: 'observation', layer: 'L0', content: '', principal_id: 'cto-actor', confidence: 0.5, created_at: '2026-04-29T00:00:00Z' },
            ],
            edges: [],
            truncated: { depth_reached: false, missing_ancestors: 0 },
          },
        }),
      });
    });

    await gotoFirstCanonAtomDetail(page);

    await page.getByTestId('audit-chain-toggle').click();

    const empty = page.getByTestId('audit-chain-empty');
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await expect(empty).toContainText('no upstream provenance');
    // No timeline rendered for the seed-only case.
    await expect(page.getByTestId('audit-chain-timeline')).toHaveCount(0);
  });

  test('renders the truncation note when the depth limit is hit', async ({ page }) => {
    await page.route('**/api/atoms.audit-chain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            atoms: [
              { id: 'seed-trunc', type: 'plan', layer: 'L0', content: '', principal_id: 'cto-actor', confidence: 0.9, created_at: '2026-04-29T00:00:00Z' },
              { id: 'mid', type: 'spec-output', layer: 'L0', content: '', principal_id: 'spec-author', confidence: 0.9, created_at: '2026-04-29T00:00:00Z' },
            ],
            edges: [{ from: 'seed-trunc', to: 'mid' }],
            truncated: { depth_reached: true, missing_ancestors: 2 },
          },
        }),
      });
    });

    await gotoFirstCanonAtomDetail(page);

    await page.getByTestId('audit-chain-toggle').click();

    const note = page.getByTestId('audit-chain-truncation-note');
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expect(note).toContainText('truncated');
    await expect(note).toContainText('2');
  });

  test('renders against a real chain when the fixture has one', async ({ page }) => {
    /*
     * Live-data smoke test: probe the audit-chain endpoint for canon
     * atoms and use the FIRST one whose chain has at least 2 atoms (the
     * seed plus at least one ancestor). When no canon atom has a
     * non-trivial chain, the test skips cleanly so a fresh-install
     * fixture does not false-fail.
     */
    const canon = await fetchCanon(page);
    test.skip(canon.length === 0, 'no canon atoms in fixture');

    let target: ListAtom | null = null;
    for (const atom of canon.slice(0, 20)) {
      const size = await fetchAuditChainSize(page, atom.id);
      if (size !== null && size >= 2) {
        target = atom;
        break;
      }
    }
    test.skip(target === null, 'no canon atom with a multi-atom chain in fixture');

    await page.goto(`/atom/${encodeURIComponent(target!.id)}`);
    await page.getByTestId('audit-chain-toggle').click();
    await expect(page.getByTestId('audit-chain-body')).toBeVisible({ timeout: 10_000 });
    // Either timeline OR empty renders -- assert one of them appears
    // so an unhealthy panel state would surface.
    const timeline = page.getByTestId('audit-chain-timeline');
    const empty = page.getByTestId('audit-chain-empty');
    await expect(timeline.or(empty)).toBeVisible({ timeout: 10_000 });

    // For the chosen target, we KNOW the chain has 2+ atoms; assert
    // the timeline is the one we got.
    await expect(timeline).toBeVisible();
    const nodeCount = await timeline.getAttribute('data-node-count');
    expect(Number(nodeCount)).toBeGreaterThanOrEqual(2);
  });
});
