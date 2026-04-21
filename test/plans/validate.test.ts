/**
 * validatePlan unit tests (with fixture LLM).
 *
 * The detector in the arbitration stack uses host.llm for semantic
 * conflict detection. Here we pre-register judge responses for the
 * specific plan/canon pairs we feed in, so the test is deterministic
 * and does not require a real model.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/arbitration/index.js';
import { validatePlan } from '../../src/plans/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principalId = 'plan-validate-test' as PrincipalId;

function makePlan(id: string, content: string, scope: Atom['scope'] = 'project'): Atom {
  return sampleAtom({
    id: id as AtomId,
    type: 'plan',
    layer: 'L1',
    content,
    plan_state: 'proposed',
    scope,
    created_at: '2026-04-19T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-04-19T00:00:00.000Z' as Time,
  });
}

function makeCanon(id: string, content: string, scope: Atom['scope'] = 'project'): Atom {
  return sampleAtom({
    id: id as AtomId,
    type: 'directive',
    layer: 'L3',
    content,
    confidence: 1.0,
    scope,
    created_at: '2026-04-19T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-04-19T00:00:00.000Z' as Time,
  });
}

function registerJudge(
  host: ReturnType<typeof createMemoryHost>,
  a: Atom,
  b: Atom,
  response: { kind: 'semantic' | 'temporal' | 'none'; explanation: string },
) {
  host.llm.register(
    DETECT_SCHEMA,
    DETECT_SYSTEM,
    {
      atom_a: { content: a.content, type: a.type, layer: a.layer, created_at: a.created_at },
      atom_b: { content: b.content, type: b.type, layer: b.layer, created_at: b.created_at },
    },
    response,
  );
}

describe('validatePlan', () => {
  it('clean status when no conflicts with any L3 canon', async () => {
    const host = createMemoryHost();
    const canon = makeCanon('inv-logs', 'All services emit structured logs.');
    await host.atoms.put(canon);

    const plan = makePlan('plan-feature', 'Add a new analytics endpoint that logs JSON events.');
    await host.atoms.put(plan);

    // Plan and canon content hashes will DIFFER (different text), so detector
    // falls through to LLM. Register 'none': plan does not contradict canon.
    registerJudge(host, plan, canon, { kind: 'none', explanation: 'Unrelated concerns.' });

    const result = await validatePlan(plan, host, { principalId });
    expect(result.status).toBe('clean');
    expect(result.conflicts).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it('flags conflict when plan contradicts canon', async () => {
    const host = createMemoryHost();
    const canon = makeCanon('inv-logs-structured', 'All services emit structured logs.');
    await host.atoms.put(canon);

    const plan = makePlan('plan-plaintext', 'Deploy service X with plain-text logs for readability.');
    await host.atoms.put(plan);

    registerJudge(host, plan, canon, {
      kind: 'semantic',
      explanation: 'Plan proposes plain-text logs; canon requires structured logs.',
    });

    const result = await validatePlan(plan, host, { principalId });
    expect(result.status).toBe('conflicts');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.canonAtomId).toBe(canon.id);
    expect(result.conflicts[0]!.decision.pair.kind).toBe('semantic');
  });

  it('ignores tainted canon atoms (quarantined L3 does not block)', async () => {
    const host = createMemoryHost();
    const canon = makeCanon('inv-stale', 'Legacy rule nobody enforces anymore.');
    await host.atoms.put(canon);
    // Quarantine the canon; plan should not collide with it.
    await host.atoms.update(canon.id, { taint: 'quarantined' });

    const plan = makePlan('plan-new', 'Do the new thing.');
    await host.atoms.put(plan);

    const result = await validatePlan(plan, host, { principalId });
    expect(result.status).toBe('clean');
    expect(result.scanned).toBe(0);
  });

  it('temporal-scope coexist does NOT count as a blocking conflict', async () => {
    const host = createMemoryHost();
    const canon = makeCanon('hist', 'In 2020 we used framework X.');
    await host.atoms.put(canon);

    const plan = makePlan('plan-now', 'In 2026 we adopt framework Y.');
    await host.atoms.put(plan);

    registerJudge(host, plan, canon, {
      kind: 'temporal',
      explanation: 'Different time windows.',
    });

    const result = await validatePlan(plan, host, { principalId });
    // Temporal coexist is a non-blocking "both true at different times".
    expect(result.status).toBe('clean');
  });

  it('throws on non-plan atom', async () => {
    const host = createMemoryHost();
    const notPlan = sampleAtom({ id: 'not-plan' as AtomId, type: 'observation' });
    await host.atoms.put(notPlan);

    await expect(validatePlan(notPlan, host, { principalId })).rejects.toThrow(/not a plan/);
  });

  it('scope filter: project plan only checked against project canon by default', async () => {
    const host = createMemoryHost();
    const globalCanon = makeCanon('inv-g', 'Global thing.', 'global');
    const projectCanon = makeCanon('inv-p', 'Project thing.', 'project');
    await host.atoms.put(globalCanon);
    await host.atoms.put(projectCanon);

    const plan = makePlan('plan-p', 'Do a project thing.', 'project');
    await host.atoms.put(plan);

    // Only the project-scope canon is candidate; register 'none' for it.
    registerJudge(host, plan, projectCanon, { kind: 'none', explanation: 'fine' });

    const result = await validatePlan(plan, host, { principalId });
    expect(result.scanned).toBe(1); // global canon filtered out
  });

  it('custom canonFilter: explicit scope override scans wider', async () => {
    const host = createMemoryHost();
    const globalCanon = makeCanon('inv-g', 'Global thing.', 'global');
    const projectCanon = makeCanon('inv-p', 'Project thing.', 'project');
    await host.atoms.put(globalCanon);
    await host.atoms.put(projectCanon);

    const plan = makePlan('plan-p', 'Do a thing.', 'project');
    await host.atoms.put(plan);

    registerJudge(host, plan, globalCanon, { kind: 'none', explanation: 'fine' });
    registerJudge(host, plan, projectCanon, { kind: 'none', explanation: 'fine' });

    const result = await validatePlan(plan, host, {
      principalId,
      canonFilter: { layer: ['L3'] },
    });
    expect(result.scanned).toBe(2); // both canon atoms now in scope
  });
});
