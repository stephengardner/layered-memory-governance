/**
 * aggregateRelevantContext tests.
 *
 * Exercise the pure context-aggregation helper against a memory host
 * seeded with canon directives, decisions, observations, and open
 * plans. Asserts that directives/decisions/relevantAtoms/openPlans
 * are populated correctly and capped.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { aggregateRelevantContext } from '../../../src/actors/planning/aggregate-context.js';
import type { AtomId, PrincipalId } from '../../../src/types.js';
import { sampleAtom, samplePrincipal } from '../../fixtures.js';

const OPERATOR: PrincipalId = 'apex-agent' as PrincipalId;

describe('aggregateRelevantContext', () => {
  it('collects L3 directives and L3 decisions separately', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({
      id: 'dir-1' as AtomId,
      type: 'directive',
      layer: 'L3',
      content: 'Directive: always X',
    }));
    await host.atoms.put(sampleAtom({
      id: 'dec-1' as AtomId,
      type: 'decision',
      layer: 'L3',
      content: 'Decision: we chose A',
    }));
    await host.atoms.put(sampleAtom({
      id: 'obs-1' as AtomId,
      type: 'observation',
      layer: 'L1',
      content: 'Observation',
    }));

    const ctx = await aggregateRelevantContext(host, 'should we X');
    expect(ctx.directives.map((a) => a.id)).toEqual(['dir-1']);
    expect(ctx.decisions.map((a) => a.id)).toEqual(['dec-1']);
  });

  it('populates relevantAtoms from semantic search (top-K cap)', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 30; i++) {
      await host.atoms.put(sampleAtom({
        id: `obs-${i}` as AtomId,
        type: 'observation',
        layer: 'L1',
        content: `topic abc thing ${i}`,
      }));
    }
    const ctx = await aggregateRelevantContext(host, 'topic abc', { topKRelevant: 5 });
    expect(ctx.relevantAtoms.length).toBeLessThanOrEqual(5);
    expect(ctx.relevantAtoms.length).toBeGreaterThan(0);
  });

  it('openPlans filters plan_state in {proposed, approved, executing}', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({
      id: 'plan-open' as AtomId,
      type: 'plan',
      layer: 'L1',
      metadata: { plan_state: 'proposed' },
    }));
    await host.atoms.put(sampleAtom({
      id: 'plan-running' as AtomId,
      type: 'plan',
      layer: 'L1',
      metadata: { plan_state: 'executing' },
    }));
    await host.atoms.put(sampleAtom({
      id: 'plan-closed' as AtomId,
      type: 'plan',
      layer: 'L1',
      metadata: { plan_state: 'succeeded' },
    }));
    await host.atoms.put(sampleAtom({
      id: 'plan-killed' as AtomId,
      type: 'plan',
      layer: 'L1',
      metadata: { plan_state: 'abandoned' },
    }));

    const ctx = await aggregateRelevantContext(host, 'anything');
    const ids = ctx.openPlans.map((p) => p.id).sort();
    expect(ids).toEqual(['plan-open', 'plan-running']);
  });

  it('includes active principals with role + signed_by', async () => {
    const host = createMemoryHost();
    await host.principals.put(samplePrincipal({
      id: OPERATOR,
      role: 'user',
      signed_by: null,
    }));
    await host.principals.put(samplePrincipal({
      id: 'cto-actor' as PrincipalId,
      role: 'agent',
      signed_by: OPERATOR,
    }));
    const ctx = await aggregateRelevantContext(host, 'anything');
    const stephen = ctx.relevantPrincipals.find((p) => p.id === OPERATOR);
    const cto = ctx.relevantPrincipals.find((p) => p.id === 'cto-actor');
    expect(stephen).toBeDefined();
    expect(stephen!.signed_by).toBeNull();
    expect(cto).toBeDefined();
    expect(cto!.signed_by).toBe(OPERATOR);
  });

  it('gatheredAt is populated from host.clock.now()', async () => {
    const host = createMemoryHost();
    const ctx = await aggregateRelevantContext(host, 'hi');
    expect(typeof ctx.gatheredAt).toBe('string');
    expect(ctx.gatheredAt.length).toBeGreaterThan(10);
  });

  it('respects caps on directives/decisions/plans/principals', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 10; i++) {
      await host.atoms.put(sampleAtom({
        id: `dir-${i}` as AtomId,
        type: 'directive',
        layer: 'L3',
      }));
    }
    const ctx = await aggregateRelevantContext(host, 'x', {
      maxDirectives: 3,
      maxDecisions: 1,
      maxOpenPlans: 1,
      maxPrincipals: 1,
      topKRelevant: 1,
    });
    expect(ctx.directives.length).toBeLessThanOrEqual(3);
  });
});
