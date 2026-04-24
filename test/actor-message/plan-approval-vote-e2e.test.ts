/**
 * End-to-end: writer + reader of plan-approval-votes agree on shape.
 *
 * `plan-approval-vote-writer.ts` and the reader
 * `runPlanApprovalTick` in `plan-approval.ts` are separate modules
 * with their own tests. This e2e locks in the contract between them:
 * 2 votes written via the writer, run the tick, plan transitions to
 * `approved`. Without this, a shape drift (e.g. writer renames
 * `voted_at` to `castAt`) passes both modules' unit tests but breaks
 * the multi-reviewer flow silently.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runPlanApprovalTick } from '../../src/actor-message/plan-approval.js';
import { writePlanApprovalVote } from '../../src/runtime/actor-message/plan-approval-vote-writer.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const NOW = '2026-04-23T12:00:00.000Z' as Time;

function policyAtom(): Atom {
  return {
    schema_version: 1,
    id: 'pol-plan-multi-reviewer-approval' as AtomId,
    content: 'multi-reviewer policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test-bootstrap', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'plan-multi-reviewer-approval',
        allowed_sub_actors: ['code-author'],
        min_votes: 2,
        min_vote_confidence: 0.8,
        min_plan_confidence: 0.85,
        required_roles: [],
        hard_reject_on_any_reject: true,
        max_age_ms: 86_400_000,
      },
    },
  };
}

function planAtom(id: string): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    plan_state: 'proposed',
    metadata: {
      planning_actor_version: '0.1.0',
      title: 'test plan',
      delegation: { sub_actor_principal_id: 'code-author' },
    },
  };
}

describe('plan-approval e2e: writer + reader', () => {
  it('2 writer-written approve votes + tick -> plan approved', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom());
    await host.atoms.put(planAtom('plan-e2e'));

    await writePlanApprovalVote(host, {
      planId: 'plan-e2e' as AtomId,
      voterId: 'alice' as PrincipalId,
      vote: 'approve',
      rationale: 'fence atoms intact, spec requirements met',
      role: 'reviewer',
      confidence: 0.9,
      scope: 'project',
      nowIso: NOW,
    });
    await writePlanApprovalVote(host, {
      planId: 'plan-e2e' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'approve',
      rationale: 'code path matches plan scope exactly',
      role: 'reviewer',
      confidence: 0.95,
      scope: 'project',
      nowIso: NOW,
    });

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(1);
    expect(r.eligible).toBe(1);
    const plan = await host.atoms.get('plan-e2e' as AtomId);
    expect(plan?.plan_state).toBe('approved');
    // Approval metadata should name both voters; reader reads voters
    // off the vote atoms' principal_id fields.
    const voters = ((plan?.metadata as Record<string, unknown>)?.multi_reviewer_approved as Record<string, unknown>)?.voters as ReadonlyArray<string>;
    expect(voters).toEqual(expect.arrayContaining(['alice', 'bob']));
  });

  it('1 writer-written reject + tick -> plan abandoned (hard-reject)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom());
    await host.atoms.put(planAtom('plan-rejectable'));

    await writePlanApprovalVote(host, {
      planId: 'plan-rejectable' as AtomId,
      voterId: 'alice' as PrincipalId,
      vote: 'approve',
      rationale: 'low signal review; would lgtm',
      role: undefined,
      confidence: 0.9,
      scope: 'project',
      nowIso: NOW,
    });
    await writePlanApprovalVote(host, {
      planId: 'plan-rejectable' as AtomId,
      voterId: 'carol' as PrincipalId,
      vote: 'reject',
      rationale: 'plan violates pol-code-author-allowed-paths fence',
      role: undefined,
      confidence: 0.95,
      scope: 'project',
      nowIso: NOW,
    });

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
    expect(r.rejected).toBe(1);
    const plan = await host.atoms.get('plan-rejectable' as AtomId);
    expect(plan?.plan_state).toBe('abandoned');
    expect((plan?.metadata as Record<string, unknown>)?.abandoned_reason).toMatch(/carol/);
  });
});
