/**
 * Plan state machine unit tests.
 *
 * Proves the transition table is enforced: allowed moves succeed and
 * write an audit event; disallowed moves throw
 * InvalidPlanTransitionError without mutating state.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  canTransition,
  InvalidPlanTransitionError,
  transitionPlanState,
} from '../../src/plans/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principalId = 'plan-state-test' as PrincipalId;

describe('canTransition (pure state-machine predicate)', () => {
  it('allows proposed -> approved | abandoned', () => {
    expect(canTransition('proposed', 'approved')).toBe(true);
    expect(canTransition('proposed', 'abandoned')).toBe(true);
    expect(canTransition('proposed', 'executing')).toBe(false);
    expect(canTransition('proposed', 'succeeded')).toBe(false);
    expect(canTransition('proposed', 'failed')).toBe(false);
  });

  it('allows approved -> executing | abandoned', () => {
    expect(canTransition('approved', 'executing')).toBe(true);
    expect(canTransition('approved', 'abandoned')).toBe(true);
    expect(canTransition('approved', 'proposed')).toBe(false);
    expect(canTransition('approved', 'succeeded')).toBe(false);
  });

  it('allows executing -> succeeded | failed | abandoned', () => {
    expect(canTransition('executing', 'succeeded')).toBe(true);
    expect(canTransition('executing', 'failed')).toBe(true);
    expect(canTransition('executing', 'abandoned')).toBe(true);
    expect(canTransition('executing', 'approved')).toBe(false);
    expect(canTransition('executing', 'proposed')).toBe(false);
  });

  it('terminal states have no transitions out', () => {
    for (const terminal of ['succeeded', 'failed', 'abandoned'] as const) {
      for (const target of ['proposed', 'approved', 'executing', 'succeeded', 'failed', 'abandoned'] as const) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('undefined from-state (non-plan atom) returns false for all', () => {
    expect(canTransition(undefined, 'proposed')).toBe(false);
    expect(canTransition(undefined, 'approved')).toBe(false);
  });
});

describe('transitionPlanState (persistent with audit)', () => {
  async function seedPlan(
    host: ReturnType<typeof createMemoryHost>,
    id: string,
    initial: 'proposed' | 'approved' | 'executing' = 'proposed',
  ): Promise<AtomId> {
    const atomId = id as AtomId;
    await host.atoms.put(sampleAtom({
      id: atomId,
      type: 'plan',
      layer: 'L1',
      content: 'Plan: do the thing.',
      plan_state: initial,
      created_at: '2026-04-19T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-19T00:00:00.000Z' as Time,
    }));
    return atomId;
  }

  it('happy path: proposed -> approved -> executing -> succeeded', async () => {
    const host = createMemoryHost();
    const id = await seedPlan(host, 'plan-happy');

    const a1 = await transitionPlanState(id, 'approved', host, principalId, 'HIL approved');
    expect(a1.plan_state).toBe('approved');

    const a2 = await transitionPlanState(id, 'executing', host, principalId);
    expect(a2.plan_state).toBe('executing');

    const a3 = await transitionPlanState(id, 'succeeded', host, principalId, 'all steps green');
    expect(a3.plan_state).toBe('succeeded');

    // Three audit events recorded.
    const audits = await host.auditor.query({ kind: ['plan.state_transition'] }, 100);
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it('throws on invalid transition and does not mutate', async () => {
    const host = createMemoryHost();
    const id = await seedPlan(host, 'plan-invalid');
    await expect(
      transitionPlanState(id, 'succeeded', host, principalId),
    ).rejects.toBeInstanceOf(InvalidPlanTransitionError);

    const atom = await host.atoms.get(id);
    expect(atom?.plan_state).toBe('proposed');
  });

  it('throws when the atom is not a plan', async () => {
    const host = createMemoryHost();
    const observationId = 'not-a-plan' as AtomId;
    await host.atoms.put(sampleAtom({
      id: observationId,
      type: 'observation',
      // No plan_state.
    }));
    await expect(
      transitionPlanState(observationId, 'approved', host, principalId),
    ).rejects.toBeInstanceOf(InvalidPlanTransitionError);
  });

  it('throws when the atom does not exist', async () => {
    const host = createMemoryHost();
    await expect(
      transitionPlanState('ghost' as AtomId, 'approved', host, principalId),
    ).rejects.toThrow(/not found/);
  });

  it('terminal state is sticky: approved-then-abandoned, no further moves', async () => {
    const host = createMemoryHost();
    const id = await seedPlan(host, 'plan-terminal', 'approved');
    await transitionPlanState(id, 'abandoned', host, principalId, 'deprioritized');

    await expect(
      transitionPlanState(id, 'executing', host, principalId),
    ).rejects.toBeInstanceOf(InvalidPlanTransitionError);
  });
});
