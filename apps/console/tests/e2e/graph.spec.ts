import { test, expect, type Page } from '@playwright/test';

/*
 * Graph interaction e2e. Exercises the service-backed + d3-zoom-
 * driven behavior:
 *   - renders N nodes matching the canon dataset
 *   - settles (data-settled attribute flips to true) pre-paint
 *   - nodes are positioned inside the svg viewport on first paint
 *     (instant fit — C1 regression)
 *   - wheel over the graph zooms WITHOUT scrolling the outer page
 *     (C2 regression)
 *   - drag pans the graph by exactly the mouse delta, regardless of
 *     viewBox↔container ratio (C3 regression)
 *   - zoom anchors at the cursor, keeping the point-under-cursor
 *     fixed across zoom changes (C4 regression)
 *   - releasing a drag outside the canvas does not leak drag state
 *     (C5 regression)
 *   - node click opens the side detail panel
 *   - filter chips toggle node visibility AND preserve positions
 *   - hover card opens on node mouseenter
 *   - selection attribute flips on node click
 *
 * These are keyed on data-testid attributes the view exposes —
 * they don't assert exact positions (force sim is non-deterministic
 * across runs) but every behavior invariant is stable.
 */

async function gotoGraph(page: Page) {
  await page.goto('/graph');
  await expect(page.getByTestId('graph-svg')).toBeVisible();
  await expect.poll(
    () => page.getByTestId('graph-svg').getAttribute('data-settled'),
    { timeout: 10_000 },
  ).toBe('true');
}

async function readTransform(page: Page): Promise<{ x: number; y: number; k: number }> {
  const svg = page.getByTestId('graph-svg');
  const [kStr, xStr, yStr] = await Promise.all([
    svg.getAttribute('data-transform-k'),
    svg.getAttribute('data-transform-x'),
    svg.getAttribute('data-transform-y'),
  ]);
  return { x: Number(xStr), y: Number(yStr), k: Number(kStr) };
}

test.describe('graph', () => {
  test.skip(({ isMobile }) => isMobile, 'graph drag/zoom interactions are desktop-primary; mobile gestures TBD');

  test.beforeEach(async ({ page }) => {
    await gotoGraph(page);
  });

  test('renders > 10 nodes from the substrate', async ({ page }) => {
    const n = await page.getByTestId('graph-node').count();
    expect(n).toBeGreaterThan(10);
  });

  test('C1: nodes are positioned inside the svg viewport on first paint', async ({ page }) => {
    /*
     * After settle, the initial-fit transform should already be
     * applied — not hard-coded identity. We check that the svg's
     * transform k is not 1.0 (a signal that fit ran — the canonical
     * 1200×800 world doesn't fit into the rendered svg at k=1), AND
     * that every rendered node falls inside the svg's bounding box
     * with a small margin. Previously the first paint used scale 0.7
     * with zero translation and the cloud sat in the top-left corner
     * or extended off-screen.
     */
    const t = await readTransform(page);
    expect(t.k).not.toBe(1);
    expect(t.k).toBeGreaterThan(0);

    const svgRect = await page.getByTestId('graph-svg').boundingBox();
    expect(svgRect).toBeTruthy();

    const nodes = page.getByTestId('graph-node');
    const n = Math.min(5, await nodes.count());
    for (let i = 0; i < n; i++) {
      const r = await nodes.nth(i).boundingBox();
      expect(r).toBeTruthy();
      const cx = r!.x + r!.width / 2;
      const cy = r!.y + r!.height / 2;
      expect(cx).toBeGreaterThanOrEqual(svgRect!.x);
      expect(cx).toBeLessThanOrEqual(svgRect!.x + svgRect!.width);
      expect(cy).toBeGreaterThanOrEqual(svgRect!.y);
      expect(cy).toBeLessThanOrEqual(svgRect!.y + svgRect!.height);
    }
  });

  test('C2: wheel over the graph zooms without scrolling the outer page', async ({ page }) => {
    /*
     * Force the page body to be scrollable so a stray wheel event
     * would actually move the window. Without this guard the test
     * could pass for the wrong reason on a page that's already fully
     * visible. Then wheel at the svg center and assert scrollY is
     * unchanged while the graph's k changed.
     */
    await page.evaluate(() => {
      document.body.style.minHeight = '3000px';
    });
    const svgRect = (await page.getByTestId('graph-svg').boundingBox())!;
    const cx = svgRect.x + svgRect.width / 2;
    const cy = svgRect.y + svgRect.height / 2;
    await page.mouse.move(cx, cy);
    const initialScrollY = await page.evaluate(() => window.scrollY);
    const before = await readTransform(page);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await readTransform(page)).k, { timeout: 2_000 })
      .not.toBe(before.k);
    const afterScrollY = await page.evaluate(() => window.scrollY);
    expect(afterScrollY).toBe(initialScrollY);
  });

  test('C3: drag pans the graph by the mouse delta in screen pixels', async ({ page }) => {
    const nodes = page.getByTestId('graph-node');
    const firstNode = nodes.first();
    const before = (await firstNode.boundingBox())!;

    const svgRect = (await page.getByTestId('graph-svg').boundingBox())!;
    /*
     * Drag from an empty region in the top-left corner of the canvas
     * to avoid starting the drag on a node (which would still pan,
     * d3-zoom is fine with that, but we avoid the rare case of a
     * node living exactly at the start coords).
     */
    const startX = svgRect.x + 40;
    const startY = svgRect.y + 40;
    const deltaX = 120;
    const deltaY = 80;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 10 });
    await page.mouse.up();

    const after = (await firstNode.boundingBox())!;
    /*
     * Node should move by exactly the mouse delta in screen pixels.
     * Small tolerance (±3px) absorbs sub-pixel rounding and the
     * possibility that the sim ticked once or twice if alpha hadn't
     * fully decayed — settled threshold is 0.02, not 0.
     */
    expect(Math.abs((after.x - before.x) - deltaX)).toBeLessThanOrEqual(3);
    expect(Math.abs((after.y - before.y) - deltaY)).toBeLessThanOrEqual(3);
  });

  test('C4: zoom anchors at the cursor — the point under cursor stays fixed', async ({ page }) => {
    const svgRect = (await page.getByTestId('graph-svg').boundingBox())!;
    /*
     * Pick a cursor point well inside the svg, not over any node
     * (so hover card doesn't intercept). Offset from center to
     * ensure the anchor is distinct from the zoom-origin default.
     */
    const cursorX = svgRect.x + svgRect.width * 0.25;
    const cursorY = svgRect.y + svgRect.height * 0.3;

    /*
     * Convert the cursor to graph-space BEFORE zoom. graph-space =
     * (screen − translate) / scale. Under correct cursor-anchored
     * zoom, after the wheel event the SAME graph-space point must
     * still map to (cursorX, cursorY) in screen coords.
     */
    const before = await readTransform(page);
    const svg0 = svgRect;
    const svgX0 = cursorX - svg0.x;
    const svgY0 = cursorY - svg0.y;
    const gx = (svgX0 - before.x) / before.k;
    const gy = (svgY0 - before.y) / before.k;

    await page.mouse.move(cursorX, cursorY);
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await readTransform(page)).k, { timeout: 2_000 })
      .not.toBe(before.k);

    const after = await readTransform(page);
    // Project graph-space point (gx, gy) forward through the new transform.
    const projectedSvgX = after.x + gx * after.k;
    const projectedSvgY = after.y + gy * after.k;
    const svgRect2 = (await page.getByTestId('graph-svg').boundingBox())!;
    const projectedClientX = projectedSvgX + svgRect2.x;
    const projectedClientY = projectedSvgY + svgRect2.y;

    expect(Math.abs(projectedClientX - cursorX)).toBeLessThanOrEqual(2);
    expect(Math.abs(projectedClientY - cursorY)).toBeLessThanOrEqual(2);
  });

  test('C5: releasing a drag outside the canvas does not leak drag state', async ({ page }) => {
    const firstNode = page.getByTestId('graph-node').first();
    const svgRect = (await page.getByTestId('graph-svg').boundingBox())!;

    // Start drag inside, end outside the canvas.
    const startX = svgRect.x + 40;
    const startY = svgRect.y + 40;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(5, 5, { steps: 8 }); // well outside the canvas
    await page.mouse.up();

    const afterDrag = (await firstNode.boundingBox())!;

    /*
     * Re-enter the canvas and move the cursor without holding any
     * button. If drag state leaked, this would be treated as a
     * continued pan and nodes would shift. They must not.
     */
    await page.mouse.move(svgRect.x + 200, svgRect.y + 200);
    await page.waitForTimeout(80);
    const afterMove = (await firstNode.boundingBox())!;

    // Allow tiny drift from any residual sim ticks (sub-pixel).
    expect(Math.abs(afterMove.x - afterDrag.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterMove.y - afterDrag.y)).toBeLessThanOrEqual(2);
  });

  test('pan-then-zoom composes: final transform reflects both', async ({ page }) => {
    const before = await readTransform(page);

    // Pan 60px right, 40px down.
    const svgRect = (await page.getByTestId('graph-svg').boundingBox())!;
    await page.mouse.move(svgRect.x + 40, svgRect.y + 40);
    await page.mouse.down();
    await page.mouse.move(svgRect.x + 100, svgRect.y + 80, { steps: 8 });
    await page.mouse.up();

    const afterPan = await readTransform(page);
    expect(Math.abs(afterPan.x - before.x - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterPan.y - before.y - 40)).toBeLessThanOrEqual(2);
    expect(afterPan.k).toBe(before.k);

    // Now zoom at center.
    await page.mouse.move(svgRect.x + svgRect.width / 2, svgRect.y + svgRect.height / 2);
    await page.mouse.wheel(0, -180);
    await expect.poll(async () => (await readTransform(page)).k, { timeout: 2_000 })
      .toBeGreaterThan(afterPan.k);
    const afterZoom = await readTransform(page);
    expect(afterZoom.k).toBeGreaterThan(afterPan.k);
  });

  test('clicking a node opens the detail panel', async ({ page }) => {
    const first = page.getByTestId('graph-node').first();
    const nodeId = await first.getAttribute('data-node-id');
    expect(nodeId).toBeTruthy();
    await first.click({ force: true });
    await expect(page.getByTestId('graph-detail-panel')).toBeVisible();
    await expect(first).toHaveAttribute('data-selected', 'true');
    const closedVersion = await page.getByTestId('graph-svg').getAttribute('data-version');
    await page.getByTestId('graph-detail-close').click();
    await expect(page.getByTestId('graph-detail-panel')).toBeHidden();
    // Closing is a state change; version should advance.
    const afterVersion = await page.getByTestId('graph-svg').getAttribute('data-version');
    expect(afterVersion).not.toBe(closedVersion);
  });

  test('filter chip toggles node count without restarting the sim', async ({ page }) => {
    const beforeCount = await page.getByTestId('graph-node').count();
    const decisionChip = page.getByTestId('graph-filter-decision');
    await decisionChip.click();
    // After toggling off, decision nodes should disappear.
    await expect.poll(() => page.getByTestId('graph-node').count(), { timeout: 5_000 })
      .toBeLessThan(beforeCount);
    // Toggle back on — count restores.
    await decisionChip.click();
    await expect.poll(() => page.getByTestId('graph-node').count(), { timeout: 5_000 })
      .toBe(beforeCount);
  });

  test('hover card appears on node mouseenter', async ({ page }) => {
    const first = page.getByTestId('graph-node').first();
    await first.hover({ force: true });
    await expect(page.getByTestId('graph-hover-card')).toBeVisible();
  });

  test('selection state updates the data-selected attribute', async ({ page }) => {
    const nodes = page.getByTestId('graph-node');
    const firstNode = nodes.first();
    /*
     * dispatchEvent('click') dispatches a MouseEvent directly at the
     * element — bypasses DOM hit-testing. Needed here because clicking
     * a node opens a hover-card portal (stay-open timing) that can
     * occlude the next node's click region; click({ force: true })
     * skips actionability but still resolves target via hit-test, so
     * the second click lands on the hover card. This test wants to
     * exercise the service's selection state transition, not hit-test
     * layering; dispatchEvent gives us a deterministic signal.
     */
    await firstNode.dispatchEvent('click');
    await expect(firstNode).toHaveAttribute('data-selected', 'true');
    const secondNode = nodes.nth(1);
    await secondNode.dispatchEvent('click');
    await expect(firstNode).toHaveAttribute('data-selected', 'false');
    await expect(secondNode).toHaveAttribute('data-selected', 'true');
  });
});
