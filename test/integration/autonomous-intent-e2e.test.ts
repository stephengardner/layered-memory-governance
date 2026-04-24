import { describe, expect, it } from 'vitest';
import { runIntentAutoApprovePass } from '../../src/runtime/actor-message/intent-approve.js';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const GATED = process.env['LAG_AUTONOMOUS_E2E'] === '1';

const NOW_ISO = '2026-04-24T12:00:00.000Z' as Time;
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE_EXPIRY = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString() as Time;

function intentApprovePolicyAtom(): Atom {
  return {
    schema_version: 1,
    id: 'pol-plan-autonomous-intent-approve' as AtomId,
    content: 'intent approve policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap', agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
        subject: 'plan-autonomous-intent-approve',
        allowed_sub_actors: ['code-author'],
      },
    },
  };
}

function intentCreationPolicyAtom(): Atom {
  return {
    schema_version: 1,
    id: 'pol-operator-intent-creation' as AtomId,
    content: 'intent creation policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap', agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
        subject: 'operator-intent-creation',
        allowed_principal_ids: ['operator-principal'],
      },
    },
  };
}

function operatorIntentAtom(id: string): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'fix something autonomously',
    type: 'operator-intent',
    layer: 'L1',
    provenance: {
      kind: 'operator-seeded',
      source: { tool: 'intend-cli' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
    principal_id: 'operator-principal' as PrincipalId,
    taint: 'clean',
    metadata: {
      kind: 'autonomous-solve',
      request: 'fix the tooling pipeline',
      trust_envelope: {
        max_blast_radius: 'framework',
        max_plans: 5,
        min_plan_confidence: 0.75,
        allowed_sub_actors: ['code-author'],
        require_ci_green: true,
        require_cr_approve: true,
        require_auditor_observation: true,
      },
      expires_at: FUTURE_EXPIRY,
      consumed_by_plans: [],
      consumed_by_questions: [],
    },
  };
}

function proposedPlanAtom(id: string, intentId: string): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'cto-actor', tool: 'planner' },
      derived_from: [intentId as AtomId],
    },
    confidence: 0.85,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
      title: 'e2e test plan',
      delegation: {
        sub_actor_principal_id: 'code-author',
        implied_blast_radius: 'tooling',
        reason: 'requires code changes in tooling layer',
      },
    },
  };
}

(GATED ? describe : describe.skip)('autonomous-intent e2e round-trip', () => {
  it('proposed plan with intent + matching envelope transitions to approved', async () => {
    const host = createMemoryHost();

    // Seed canon policy atoms as bootstrap would
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());

    // Write operator-intent atom
    await host.atoms.put(operatorIntentAtom('intent-e2e-1'));

    // Write plan atom citing the intent in provenance.derived_from
    await host.atoms.put(proposedPlanAtom('plan-e2e-1', 'intent-e2e-1'));

    // Run the approval pass with pinned time
    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    // Assert pass-level counts
    expect(result.scanned).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.halted).toBeFalsy();

    // Re-fetch and assert plan transitioned
    const plan = await host.atoms.get('plan-e2e-1' as AtomId);
    expect(plan?.plan_state).toBe('approved');

    const meta = plan?.metadata as Record<string, unknown>;
    expect(meta['approved_via']).toBe('pol-plan-autonomous-intent-approve');
    expect(meta['approved_intent_id']).toBe('intent-e2e-1');
    expect(typeof meta['approved_at']).toBe('string');

    // Assert auditor received the plan.approved-by-intent event
    const auditEvents = await host.auditor.query({ kind: ['plan.approved-by-intent'] }, 10);
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0]?.kind).toBe('plan.approved-by-intent');
    const details = auditEvents[0]?.details as Record<string, unknown> | undefined;
    expect(details?.['plan_id']).toBe('plan-e2e-1');
    expect(details?.['intent_id']).toBe('intent-e2e-1');
  });
});
