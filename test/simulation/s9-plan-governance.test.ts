/**
 * Scenario s9: plan governance end-to-end.
 *
 * The autonomous-organization story for INTENT (not just memory):
 *   1. A root principal seeds an L3 canon invariant.
 *   2. An agent authors a plan atom that CONTRADICTS the invariant.
 *   3. validatePlan() runs and flags the conflict.
 *   4. The caller escalates via notifier; here we simulate the HIL
 *      rejecting the plan, so we transition the plan to 'abandoned'.
 *   5. A second plan that does NOT contradict canon validates clean,
 *      gets approved, transitions through executing -> succeeded, and
 *      writes an outcome atom tagged derived_from: [planId].
 *
 * This proves the shipped Phase 38 pieces compose into the full
 * "plans are governed" loop that powers autonomous-org action:
 *   - validatePlan against L3 canon
 *   - state machine transitions
 *   - outcome distillation via derived_from
 *   - audit trail reconstructs the decision
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  DETECT_SCHEMA,
  DETECT_SYSTEM,
} from '../../src/arbitration/index.js';
import {
  transitionPlanState,
  validatePlan,
} from '../../src/plans/index.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';
import { sampleAtom, samplePrincipal } from '../fixtures.js';

const rootPrincipal = 'root-human' as PrincipalId;
const agentPrincipal = 'agent-alice' as PrincipalId;
const arbiter = 'arbiter-s9' as PrincipalId;
const FIXED_TIME = '2026-04-19T00:00:00.000Z' as Time;

function makePlan(id: string, content: string): Atom {
  return sampleAtom({
    id: id as AtomId,
    type: 'plan',
    layer: 'L1',
    content,
    plan_state: 'proposed',
    principal_id: agentPrincipal,
    scope: 'project',
    created_at: FIXED_TIME,
    last_reinforced_at: FIXED_TIME,
  });
}

function makeCanon(id: string, content: string): Atom {
  return sampleAtom({
    id: id as AtomId,
    type: 'directive',
    layer: 'L3',
    content,
    confidence: 1.0,
    principal_id: rootPrincipal,
    provenance: {
      kind: 'user-directive',
      source: { agent_id: rootPrincipal },
      derived_from: [],
    },
    scope: 'project',
    created_at: FIXED_TIME,
    last_reinforced_at: FIXED_TIME,
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

describe('s9: plan governance (end-to-end)', () => {
  it('blocks a plan that contradicts canon, lets a compliant plan through', async () => {
    const host = createMemoryHost();

    // Seed principals.
    await host.principals.put(samplePrincipal({
      id: rootPrincipal,
      name: 'root',
      signed_by: null,
      created_at: FIXED_TIME,
    }));
    await host.principals.put(samplePrincipal({
      id: agentPrincipal,
      name: 'alice',
      role: 'agent',
      signed_by: rootPrincipal,
      created_at: FIXED_TIME,
    }));

    // Seed L3 canon: all services emit structured logs.
    const canon = makeCanon('inv-logs', 'All services emit structured logs.');
    await host.atoms.put(canon);

    // Plan 1 (conflicting): agent proposes plain-text logs.
    const badPlan = makePlan('plan-bad', 'Deploy the billing service with plain-text logs for readability.');
    await host.atoms.put(badPlan);
    registerJudge(host, badPlan, canon, {
      kind: 'semantic',
      explanation: 'Plan proposes plain-text logs; canon requires structured logs.',
    });

    const badResult = await validatePlan(badPlan, host, { principalId: arbiter });
    expect(badResult.status).toBe('conflicts');
    expect(badResult.conflicts).toHaveLength(1);

    // HIL rejects the bad plan: transition to abandoned.
    const abandoned = await transitionPlanState(badPlan.id, 'abandoned', host, rootPrincipal, 'violates structured-log invariant');
    expect(abandoned.plan_state).toBe('abandoned');

    // Plan 2 (compliant): different content, no conflict.
    const goodPlan = makePlan('plan-good', 'Add a new request_id field to every structured log entry.');
    await host.atoms.put(goodPlan);
    registerJudge(host, goodPlan, canon, {
      kind: 'none',
      explanation: 'Plan extends structured logging, compatible with canon.',
    });

    const goodResult = await validatePlan(goodPlan, host, { principalId: arbiter });
    expect(goodResult.status).toBe('clean');

    // Transition through the happy path.
    await transitionPlanState(goodPlan.id, 'approved', host, rootPrincipal, 'HIL approved');
    await transitionPlanState(goodPlan.id, 'executing', host, agentPrincipal, 'starting');
    await transitionPlanState(goodPlan.id, 'succeeded', host, agentPrincipal, 'deployed to staging');

    // Write an outcome atom derived from the plan.
    const outcome = sampleAtom({
      id: 'outcome-request-id' as AtomId,
      type: 'observation',
      layer: 'L1',
      content: 'Observation: request_id field present on every structured log line in staging.',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: agentPrincipal },
        derived_from: [goodPlan.id],
      },
      principal_id: agentPrincipal,
      scope: 'project',
      created_at: FIXED_TIME,
      last_reinforced_at: FIXED_TIME,
    });
    await host.atoms.put(outcome);

    // Lineage check: outcome -> plan -> (no further derivation).
    const outcomeRead = await host.atoms.get(outcome.id);
    expect(outcomeRead?.provenance.derived_from).toContain(goodPlan.id);

    // Audit log retrace: multiple state transitions for both plans.
    const audits = await host.auditor.query({ kind: ['plan.state_transition'] }, 100);
    expect(audits.length).toBeGreaterThanOrEqual(4);

    // Query still works: goodPlan shows up as a succeeded plan.
    const succeededPlans = await host.atoms.query(
      { type: ['plan'], plan_state: ['succeeded'] },
      10,
    );
    expect(succeededPlans.atoms.map(a => a.id)).toContain(goodPlan.id);

    // And the conflicting plan shows up as abandoned.
    const abandonedPlans = await host.atoms.query(
      { type: ['plan'], plan_state: ['abandoned'] },
      10,
    );
    expect(abandonedPlans.atoms.map(a => a.id)).toContain(badPlan.id);
  });
});
