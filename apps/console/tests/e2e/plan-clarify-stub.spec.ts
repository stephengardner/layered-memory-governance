import { test, expect } from '@playwright/test';

/**
 * Clarify-stub plan-title rendering e2e.
 *
 * When the LLM-backed planning judgment fails (budget cap, turn cap,
 * etc.) the planner mints a stub plan whose title prefix is `Clarify:
 * cannot draft a grounded plan (...)`. The Plans-view PlanCard must
 * detect this and render a short canonical label in the heading
 * (`Clarify: LLM draft failed [(suffix)]`) while preserving the raw
 * original via:
 *   - native `title` attribute on the heading (browser tooltip);
 *   - a `<details>` disclosure beneath the heading containing the
 *     full raw text in a `<pre>`.
 *
 * Discovery is dynamic against /api/plans.list — same pattern as
 * plan-failure-detail.spec.ts. If no clarify-stub plan exists in the
 * atom store the test skips with a clear reason; this is a property
 * test against existing data, not a synthetic fixture.
 */

const CLARIFY_PREFIX = 'Clarify: cannot draft a grounded plan';

test.describe('plan clarify-stub title rendering', () => {
  test('clarify-stub title renders short label + preserves raw via tooltip and details', async ({
    page,
    request,
  }) => {
    const plansResponse = await request.post('/api/plans.list');
    expect(plansResponse.ok(), 'plans.list endpoint should return 200').toBe(true);
    const plansBody = await plansResponse.json();
    const plans: ReadonlyArray<{
      id: string;
      content?: string;
    }> = plansBody?.data ?? plansBody ?? [];

    /*
     * Match on the plan body, not metadata.title — the helper reads
     * the markdown heading from `splitTitleAndBody(plan.content)`,
     * which is what actually drives the rendered title.
     */
    const clarifyStub = plans.find((p) => {
      const content = typeof p.content === 'string' ? p.content : '';
      const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
      const heading = firstLine.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim() ?? '';
      return heading.startsWith(CLARIFY_PREFIX);
    });
    test.skip(
      !clarifyStub,
      'no clarify-stub plan in atom store; this test asserts a property of existing data',
    );

    await page.goto(`/plans/${clarifyStub!.id}`);

    const heading = page.getByTestId('plan-card-title').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    /*
     * The heading is normalized: starts with "Clarify: LLM draft
     * failed" and is far shorter than the raw original (the raw
     * embeds a multi-hundred-char Claude CLI envelope; the label
     * is a single short phrase).
     */
    const headingText = (await heading.textContent())?.trim() ?? '';
    expect(
      headingText.startsWith('Clarify: LLM draft failed'),
      `heading should start with "Clarify: LLM draft failed" (got: "${headingText}")`,
    ).toBe(true);
    expect(
      headingText.length,
      'normalized clarify heading should be short (< 80 chars), not the raw envelope',
    ).toBeLessThan(80);

    // data-clarify-stub marker present so downstream styling /
    // analytics can target normalized headings.
    await expect(heading).toHaveAttribute('data-clarify-stub', 'true');

    // Native title-attr tooltip preserves the raw original.
    const tooltip = await heading.getAttribute('title');
    expect(tooltip, 'heading title attr should carry raw original').not.toBeNull();
    expect(tooltip!.startsWith(CLARIFY_PREFIX), 'tooltip should be the raw clarify-stub title').toBe(
      true,
    );
    expect(
      tooltip!.length,
      'tooltip should be substantially longer than the rendered label',
    ).toBeGreaterThan(headingText.length);

    // <details> disclosure exists; opening it surfaces the raw text.
    const details = page.getByTestId('plan-card-clarify-details').first();
    await expect(details).toBeVisible();

    const summary = details.locator('summary');
    await summary.click();

    const raw = details.locator('pre');
    await expect(raw).toBeVisible();
    const rawText = (await raw.textContent()) ?? '';
    expect(rawText.startsWith(CLARIFY_PREFIX), 'raw block should contain raw clarify-stub title').toBe(
      true,
    );
  });
});
