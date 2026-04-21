/**
 * executePlan tests (Phase 46).
 *
 * Proves the governance wrapper behaves correctly across the
 * happy path, failure path, thrown-in-run path, and guard path:
 *   - Only approved plans may execute.
 *   - State transitions approved -> executing -> (succeeded | failed).
 *   - Outcome atoms tagged derived_from: [plan.id] regardless of success.
 *   - Thrown errors do not leave the plan stuck in 'executing'.
 *   - Audit event 'plan.executed' logged once per call.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { executePlan, transitionPlanState } from '../../src/plans/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'exec-test' as PrincipalId;
const FIXED = '2026-04-19T00:00:00.000Z' as Time;

async function seedApprovedPlan(
  host: ReturnType<typeof createMemoryHost>,
  id: string,
  content = 'Plan content',
): Promise<Atom> {
  const planId = id as AtomId;
  await host.atoms.put(sampleAtom({
    id: planId,
    type: 'plan',
    layer: 'L1',
    content,
    plan_state: 'proposed',
    principal_id: principal,
    created_at: FIXED,
    last_reinforced_at: FIXED,
  }));
  await transitionPlanState(planId, 'approved', host, principal, 'test');
  return (await host.atoms.get(planId))!;
}

describe('executePlan', () => {
  it('happy path: approved -> executing -> succeeded, outcomes written', async () => {
    const host = createMemoryHost();
    const plan = await seedApprovedPlan(host, 'plan-happy');

    const report = await executePlan(plan, host, {
      principalId: principal,
      run: async () => ({
        ok: true,
        outcomes: [
          { content: 'Deployed service X to staging.', confidence: 0.95 },
          { content: 'Smoke tests green.' },
        ],
      }),
    });

    expect(report.terminalState).toBe('succeeded');
    expect(report.outcomesWritten).toHaveLength(2);
    expect(report.errors).toEqual([]);

    const updated = await host.atoms.get(plan.id);
    expect(updated?.plan_state).toBe('succeeded');

    // Outcomes have derived_from pointing back to the plan.
    for (const id of report.outcomesWritten) {
      const atom = await host.atoms.get(id);
      expect(atom?.provenance.derived_from).toContain(plan.id);
    }

    const audits = await host.auditor.query({ kind: ['plan.executed'] }, 10);
    expect(audits).toHaveLength(1);
  });

  it('failure path: run returns ok=false; plan lands in failed, outcomes still written', async () => {
    const host = createMemoryHost();
    const plan = await seedApprovedPlan(host, 'plan-fail');

    const report = await executePlan(plan, host, {
      principalId: principal,
      run: async () => ({
        ok: false,
        reason: 'external API returned 500',
        outcomes: [
          { content: 'API call to /deploy returned 500.', type: 'observation', confidence: 0.9 },
        ],
      }),
    });

    expect(report.terminalState).toBe('failed');
    expect(report.reason).toContain('500');
    expect(report.outcomesWritten).toHaveLength(1);

    const updated = await host.atoms.get(plan.id);
    expect(updated?.plan_state).toBe('failed');
  });

  it('run() that throws lands plan in failed, does not stick in executing', async () => {
    const host = createMemoryHost();
    const plan = await seedApprovedPlan(host, 'plan-throw');

    const report = await executePlan(plan, host, {
      principalId: principal,
      run: async () => {
        throw new Error('unexpected boom');
      },
    });

    expect(report.terminalState).toBe('failed');
    expect(report.reason).toContain('unexpected boom');

    const updated = await host.atoms.get(plan.id);
    expect(updated?.plan_state).toBe('failed');
  });

  it('refuses to execute a non-approved plan', async () => {
    const host = createMemoryHost();
    const plan = sampleAtom({
      id: 'plan-wrong-state' as AtomId,
      type: 'plan',
      layer: 'L1',
      plan_state: 'proposed',
      principal_id: principal,
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    await host.atoms.put(plan);

    await expect(executePlan(plan, host, {
      principalId: principal,
      run: async () => ({ ok: true }),
    })).rejects.toThrow(/must be in state 'approved'/);
  });

  it('refuses to execute a non-plan atom', async () => {
    const host = createMemoryHost();
    const notPlan = sampleAtom({
      id: 'not-a-plan' as AtomId,
      type: 'observation',
    });
    await host.atoms.put(notPlan);

    await expect(executePlan(notPlan, host, {
      principalId: principal,
      run: async () => ({ ok: true }),
    })).rejects.toThrow(/not a plan/);
  });
});
