import { test, expect, type Page } from '@playwright/test';
import { PLAN_STATE_TONE, type PlanStateName } from '../../src/features/plan-state/tones';

/**
 * State-pill-tones e2e: every plan_state value the runtime can emit
 * must paint the pill in a deliberate semantic color, not the muted
 * gray that an unmapped fallback produces.
 *
 * Regression context: STATE_TONE in PlansView.tsx (and the mirror in
 * PlanLifecycleView.tsx) covered only proposed / draft / pending /
 * approved / rejected. The autonomous-loop reconciler emits four more
 * terminal-or-in-flight values - succeeded, failed, executing,
 * abandoned - and those rendered through the `?? 'var(--text-tertiary)'`
 * fallback as muted gray. Operators looking at the Plans view could
 * not visually distinguish a green-light terminal-positive (succeeded)
 * from a red-light terminal-negative (failed). This was a foundational
 * UX bug, not a nit.
 *
 * Coverage:
 *   - Discover the actual states present in the atom store via
 *     /api/plans.list (avoids brittle pinning of specific atom ids).
 *   - For each state class with a deliberate color, assert the pill's
 *     computed `color` is the resolved value of the expected token
 *     and is NOT the muted-gray fallback for non-muted states.
 *   - Run the same assertions on the Plans view and the Plan Lifecycle
 *     row view, since both surfaces share the same tones map.
 *
 * Why computed-style readback (not snapshot images): tones are tokenized
 * and theme-dependent. A pixel snapshot would lock the test to one
 * theme and fail any palette tweak. Reading getComputedStyle().color
 * from the live element compares the token resolution end-to-end while
 * staying theme-agnostic.
 *
 * Why import PLAN_STATE_TONE: the spec used to maintain a third copy
 * of the same vocabulary, which CR rightly flagged as a drift surface
 * the DRY hoist was supposed to eliminate. Now we derive the test
 * fixture from the source of truth so a substrate state added without
 * a tones.ts entry would fail at compile time, not in production.
 */

interface PlanShape {
  readonly id: string;
  readonly plan_state?: string;
}

/*
 * `abandoned` and `draft` deliberately resolve to --text-tertiary;
 * their pill IS gray on purpose, so we exclude them from the
 * "must not be gray" assertion but still verify they paint the
 * explicit token (not a typo or fallback).
 */
const MUTED_BY_DESIGN: ReadonlySet<PlanStateName> = new Set(['draft', 'abandoned']);

/*
 * Extract the bare token name from a `var(--token)` or
 * `var(--token, fallback)` CSS expression. Lets the spec ask the
 * browser to resolve the same token tones.ts declared, without
 * re-spelling the var() syntax in two places.
 */
function tokenNameFor(state: PlanStateName): string {
  const expr = PLAN_STATE_TONE[state];
  const match = expr.match(/var\((--[a-z0-9-]+)/i);
  if (!match || !match[1]) {
    throw new Error(`tones.ts entry for '${state}' is not a var() expression: ${expr}`);
  }
  return match[1];
}

const STATE_NAMES = Object.keys(PLAN_STATE_TONE) as PlanStateName[];

/**
 * Read the resolved RGB(A) string for a CSS custom property on the
 * page's root element. Uses an offscreen probe so we get the same
 * color-channel format the browser uses for `color:` (rgb / rgba),
 * which getComputedStyle() returns regardless of how the source CSS
 * spelled it (hex, hsl, var()).
 */
async function resolveToken(page: Page, token: string): Promise<string> {
  return await page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    document.body.appendChild(probe);
    const resolved = window.getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);
}

async function readPillColor(page: Page, selector: string): Promise<string> {
  return await page.locator(selector).first().evaluate((el) => {
    return window.getComputedStyle(el).color;
  });
}

test.describe('plan_state pill tones', () => {
  test('every state present in the store renders with its semantic token, not muted gray', async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/plans.list');
    expect(response.ok(), 'plans.list endpoint should return 200').toBe(true);
    const body = await response.json();
    const plans: ReadonlyArray<PlanShape> = body?.data ?? body ?? [];
    expect(plans.length, 'atom store must contain at least one plan').toBeGreaterThan(0);

    // Group present states by name so we can pick one representative
    // pill per state class.
    const presentStates = new Set<PlanStateName>();
    for (const p of plans) {
      const s = p.plan_state ?? 'unknown';
      if (STATE_NAMES.includes(s as PlanStateName)) presentStates.add(s as PlanStateName);
    }

    test.skip(
      presentStates.size === 0,
      'no plan_state values present in store match a known semantic mapping; cannot exercise tone correctness',
    );

    await page.goto('/plans');
    await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 10_000 });

    // Resolve the muted-gray reference once so we can assert "NOT this"
    // on the non-muted states.
    const mutedGray = await resolveToken(page, '--text-tertiary');
    expect(mutedGray, 'muted-gray token should resolve').toMatch(/rgb/);

    for (const state of presentStates) {
      const tokenName = tokenNameFor(state);
      const expectedColor = await resolveToken(page, tokenName);

      const pillSelector = `[data-testid="plan-card-state"][data-plan-state="${state}"]`;
      const pillCount = await page.locator(pillSelector).count();
      expect(pillCount, `plans view should render at least one pill for state '${state}'`)
        .toBeGreaterThan(0);

      const pillColor = await readPillColor(page, pillSelector);
      expect(
        pillColor,
        `state '${state}' pill should resolve to ${tokenName}`,
      ).toBe(expectedColor);

      if (!MUTED_BY_DESIGN.has(state)) {
        expect(
          pillColor,
          `state '${state}' pill must not render as muted gray (regression: tones map missing entry)`,
        ).not.toBe(mutedGray);
      }
    }
  });

  test('lifecycle row view paints the same semantic tones for the same states', async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/plans.list');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    const plans: ReadonlyArray<PlanShape> = body?.data ?? body ?? [];
    expect(plans.length).toBeGreaterThan(0);

    const presentStates = new Set<PlanStateName>();
    for (const p of plans) {
      const s = p.plan_state ?? 'unknown';
      if (STATE_NAMES.includes(s as PlanStateName)) presentStates.add(s as PlanStateName);
    }
    test.skip(presentStates.size === 0, 'no semantic states present');

    await page.goto('/plan-lifecycle');
    await expect(page.locator('[data-testid="plan-lifecycle-row"]').first()).toBeVisible({
      timeout: 10_000,
    });

    const mutedGray = await resolveToken(page, '--text-tertiary');

    for (const state of presentStates) {
      const tokenName = tokenNameFor(state);
      const expectedColor = await resolveToken(page, tokenName);

      const pillSelector = `[data-testid="plan-lifecycle-row-state"][data-plan-state="${state}"]`;
      const pillCount = await page.locator(pillSelector).count();
      if (pillCount === 0) {
        // The state exists in the store but no row may have rendered
        // yet (e.g. truncated list). Skip this iteration rather than
        // fail; the plans-view test already covered tone correctness.
        continue;
      }

      const pillColor = await readPillColor(page, pillSelector);
      expect(
        pillColor,
        `lifecycle row for state '${state}' should resolve to ${tokenName}`,
      ).toBe(expectedColor);

      if (!MUTED_BY_DESIGN.has(state)) {
        expect(pillColor, `lifecycle row '${state}' must not be muted gray`).not.toBe(mutedGray);
      }
    }
  });

  test('failed and succeeded states are visually distinct (the operator-flagged regression)', async ({
    page,
    request,
  }) => {
    /*
     * The exact regression the operator flagged: 'succeeded' and
     * 'failed' pills both rendered as muted gray because STATE_TONE
     * had no entry for either. After the fix they must resolve to
     * --status-success (green) and --status-danger (red) respectively,
     * and they must not collide with each other.
     *
     * Skip if neither state is present in the store; the test asserts
     * a property that requires an example to compare against.
     */
    const response = await request.post('/api/plans.list');
    const body = await response.json();
    const plans: ReadonlyArray<PlanShape> = body?.data ?? body ?? [];
    const hasSucceeded = plans.some((p) => p.plan_state === 'succeeded');
    const hasFailed = plans.some((p) => p.plan_state === 'failed');
    test.skip(
      !hasSucceeded && !hasFailed,
      'neither succeeded nor failed plans in store; cannot exercise the regression',
    );

    await page.goto('/plans');
    await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 10_000 });

    const successColor = await resolveToken(page, '--status-success');
    const dangerColor = await resolveToken(page, '--status-danger');
    expect(successColor, 'success token should resolve').not.toBe(dangerColor);

    if (hasSucceeded) {
      const pill = page
        .locator('[data-testid="plan-card-state"][data-plan-state="succeeded"]')
        .first();
      await expect(pill).toBeVisible();
      const c = await pill.evaluate((el) => window.getComputedStyle(el).color);
      expect(c, 'succeeded pill must paint --status-success').toBe(successColor);
    }
    if (hasFailed) {
      const pill = page
        .locator('[data-testid="plan-card-state"][data-plan-state="failed"]')
        .first();
      await expect(pill).toBeVisible();
      const c = await pill.evaluate((el) => window.getComputedStyle(el).color);
      expect(c, 'failed pill must paint --status-danger').toBe(dangerColor);
    }
  });
});
