import { describe, it, expect, beforeEach } from 'vitest';
import { GraphService, type GraphAtom } from './GraphService';

/*
 * Unit tests for GraphService. These exercise the state machine
 * directly — no React, no d3 timing, no DOM. The force simulation
 * runs synchronously via settle() so outputs are deterministic
 * given the input set (d3-force uses a seeded random internally
 * via Math.random; positions aren't bit-exact across runs but all
 * other invariants hold).
 */

function atom(overrides: Partial<GraphAtom> & { id: string }): GraphAtom {
  return {
    type: 'decision',
    layer: 'L3',
    content: overrides.id,
    principal_id: 'stephen-human',
    confidence: 1,
    created_at: '2026-04-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('GraphService', () => {
  let svc: GraphService;

  beforeEach(() => {
    svc = new GraphService({ width: 800, height: 600 });
  });

  it('starts empty', () => {
    const s = svc.getSnapshot();
    expect(s.nodes).toHaveLength(0);
    expect(s.edges).toHaveLength(0);
    expect(s.selection.nodeId).toBeNull();
    expect(s.bounds).toBeNull();
  });

  it('builds nodes from atoms filtered by default kinds', () => {
    svc.setAtoms([
      atom({ id: 'a', type: 'decision' }),
      atom({ id: 'b', type: 'directive' }),
      atom({ id: 'c', type: 'plan' }), // excluded by default filter
    ]);
    const s = svc.getSnapshot();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('builds edges from provenance.derived_from within the filtered set', () => {
    svc.setAtoms([
      atom({ id: 'a' }),
      atom({ id: 'b', provenance: { derived_from: ['a'] } }),
      // 'z' is missing from the set; the edge b→z must be dropped.
      atom({ id: 'c', provenance: { derived_from: ['a', 'z'] } }),
    ]);
    const s = svc.getSnapshot();
    expect(s.edges).toHaveLength(2);
    const pairs = s.edges.map((e) => `${stringifyEndpoint(e.source)}>${stringifyEndpoint(e.target)}`).sort();
    expect(pairs).toEqual(['b>a', 'c>a']);
  });

  it('setAtoms is a no-op when signature is unchanged', () => {
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b' })]);
    const v1 = svc.getSnapshot().version;
    // Same atom content → same signature → no rebuild.
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b' })]);
    expect(svc.getSnapshot().version).toBe(v1);
  });

  it('setAtoms rebuilds when a new atom arrives', () => {
    svc.setAtoms([atom({ id: 'a' })]);
    const v1 = svc.getSnapshot().version;
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b' })]);
    expect(svc.getSnapshot().version).toBeGreaterThan(v1);
  });

  it('setKinds narrows the filtered set without losing positions of kept nodes', () => {
    svc.setAtoms([
      atom({ id: 'a', type: 'decision' }),
      atom({ id: 'b', type: 'directive' }),
    ]);
    svc.settle();
    const posA1 = pos(svc, 'a');
    svc.setKinds(['decision']); // drop directives
    const s = svc.getSnapshot();
    expect(s.nodes.map((n) => n.id)).toEqual(['a']);
    // 'a' should have kept its position.
    const posA2 = pos(svc, 'a');
    expect(posA2).toEqual(posA1);
  });

  it('toggleKind flips inclusion of a single kind', () => {
    svc.setAtoms([
      atom({ id: 'a', type: 'decision' }),
      atom({ id: 'b', type: 'plan' }),
    ]);
    expect(svc.getSnapshot().nodes.map((n) => n.id)).toEqual(['a']);
    svc.toggleKind('plan');
    expect(svc.getSnapshot().nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    svc.toggleKind('plan');
    expect(svc.getSnapshot().nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('select sets selection and resolves 1-hop neighbors', () => {
    svc.setAtoms([
      atom({ id: 'a' }),
      atom({ id: 'b', provenance: { derived_from: ['a'] } }),
      atom({ id: 'c', provenance: { derived_from: ['a'] } }),
    ]);
    svc.select('a');
    const s = svc.getSnapshot();
    expect(s.selection.nodeId).toBe('a');
    expect(Array.from(s.selection.neighbors).sort()).toEqual(['b', 'c']);
  });

  it('select with an id outside the filtered set is a no-op', () => {
    svc.setAtoms([
      atom({ id: 'a', type: 'decision' }),
      atom({ id: 'p', type: 'plan' }), // excluded by default filter
    ]);
    svc.select('p');
    expect(svc.getSnapshot().selection.nodeId).toBeNull();
  });

  it('clears selection when the selected node is filtered out', () => {
    svc.setAtoms([atom({ id: 'a', type: 'decision' }), atom({ id: 'b', type: 'directive' })]);
    svc.select('b');
    expect(svc.getSnapshot().selection.nodeId).toBe('b');
    svc.setKinds(['decision']);
    expect(svc.getSnapshot().selection.nodeId).toBeNull();
  });

  it('bounds compute after settle', () => {
    svc.setAtoms([
      atom({ id: 'a' }),
      atom({ id: 'b', provenance: { derived_from: ['a'] } }),
      atom({ id: 'c', provenance: { derived_from: ['b'] } }),
    ]);
    svc.settle();
    const b = svc.getSnapshot().bounds;
    expect(b).not.toBeNull();
    expect(b!.maxX).toBeGreaterThan(b!.minX);
    expect(b!.maxY).toBeGreaterThan(b!.minY);
  });

  it('subscribe notifies listeners on version bumps', () => {
    let ticks = 0;
    const unsub = svc.subscribe(() => { ticks++; });
    svc.setAtoms([atom({ id: 'a' })]);
    expect(ticks).toBeGreaterThan(0);
    const before = ticks;
    unsub();
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b' })]);
    expect(ticks).toBe(before);
  });

  it('pre-settles on the first populated setAtoms so the first snapshot has bounds', () => {
    /*
     * Regression: before pre-settle, the view's first paint saw
     * `settled=false` and nodes still drifting, so initial fit-to-
     * bounds was deferred several rAF ticks — visible flash. The
     * first populated rebuild now settles synchronously (up to 400
     * ticks or alpha < 0.02), so the very first snapshot has stable
     * positions and a real bounds object.
     */
    expect(svc.getSnapshot().settled).toBe(false);
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b', provenance: { derived_from: ['a'] } })]);
    const s = svc.getSnapshot();
    expect(s.settled).toBe(true);
    expect(s.bounds).not.toBeNull();
    expect(s.bounds!.maxX).toBeGreaterThan(s.bounds!.minX);
  });

  it('tick is a no-op after settlement — no wasted sim ticks, no spurious version bumps', () => {
    /*
     * Regression for the rAF re-entry bug (H2 in the audit): before
     * this guard, select() would bumpVersion, which made the React
     * hook's rAF-effect re-fire and schedule a frame. That frame
     * called tick() → ticked the sim + bumped version → re-fired
     * the effect → infinite 60fps background churn for a settled
     * graph. tick() must no-op when settled.
     */
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b', provenance: { derived_from: ['a'] } })]);
    expect(svc.getSnapshot().settled).toBe(true);
    const v = svc.getSnapshot().version;
    const posA = pos(svc, 'a');

    const result = svc.tick();
    expect(result).toBe(false);
    // No version bump.
    expect(svc.getSnapshot().version).toBe(v);
    // No sim advancement — positions are pixel-stable.
    expect(pos(svc, 'a')).toEqual(posA);

    // Multiple back-to-back tick() calls remain no-ops.
    svc.tick();
    svc.tick();
    expect(svc.getSnapshot().version).toBe(v);
  });

  it('does not pre-settle on subsequent setAtoms (keeps existing layout continuity)', () => {
    /*
     * Once the graph has been populated once, later atom additions
     * should NOT freeze the main thread with another synchronous
     * settle — the rAF loop animates the new node into place while
     * existing nodes hold their positions. This test proxies that
     * by observing that the second setAtoms call does not re-mark
     * settled=true-from-false, because settled is already true.
     */
    svc.setAtoms([atom({ id: 'a' })]);
    expect(svc.getSnapshot().settled).toBe(true);
    const posABefore = pos(svc, 'a');
    svc.setAtoms([atom({ id: 'a' }), atom({ id: 'b' })]);
    // 'a' keeps its position — the second rebuild preserves it.
    const posAAfter = pos(svc, 'a');
    expect(posAAfter).toEqual(posABefore);
    // settled resets to false because startSimulation was called
    // (new node 'b' needs to animate in); rAF ticks handle the rest.
    expect(svc.getSnapshot().settled).toBe(false);
  });
});

function pos(svc: GraphService, id: string): { x: number; y: number } {
  const n = svc.getSnapshot().nodes.find((x) => x.id === id)!;
  return { x: n.x!, y: n.y! };
}

function stringifyEndpoint(e: string | { id: string }): string {
  return typeof e === 'string' ? e : e.id;
}
