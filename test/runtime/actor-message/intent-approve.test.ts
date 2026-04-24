import { describe, expect, it } from 'vitest';
import {
  RADIUS_RANK,
  isBlastRadiusWithin,
  findIntentInProvenance,
  runIntentAutoApprovePass,
} from '../../../src/runtime/actor-message/intent-approve.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

describe('RADIUS_RANK', () => {
  it('orders radius labels ordinally', () => {
    expect(RADIUS_RANK.none).toBe(0);
    expect(RADIUS_RANK.docs).toBeLessThan(RADIUS_RANK.tooling);
    expect(RADIUS_RANK.tooling).toBeLessThan(RADIUS_RANK.framework);
    expect(RADIUS_RANK.framework).toBeLessThan(RADIUS_RANK['l3-canon-proposal']);
  });
});

describe('isBlastRadiusWithin', () => {
  it('accepts when plan is narrower than envelope', () => {
    expect(isBlastRadiusWithin('tooling', 'framework')).toBe(true);
  });
  it('accepts when equal', () => {
    expect(isBlastRadiusWithin('framework', 'framework')).toBe(true);
  });
  it('rejects when plan is wider than envelope', () => {
    expect(isBlastRadiusWithin('framework', 'tooling')).toBe(false);
  });
});

describe('findIntentInProvenance', () => {
  const makeHost = (atoms: Record<string, unknown>) => ({
    atoms: { get: async (id: string) => (atoms[id] as Atom | undefined) ?? null },
  });

  it('returns the intent id when plan.provenance.derived_from includes an operator-intent atom', async () => {
    const host = makeHost({
      'intent-1': { id: 'intent-1', type: 'operator-intent' },
      'canon-1': { id: 'canon-1', type: 'directive' },
    });
    const plan = { provenance: { derived_from: ['canon-1', 'intent-1'] } };
    expect(await findIntentInProvenance(host as never, plan as never)).toBe('intent-1');
  });
  it('returns null when no intent is cited', async () => {
    const host = makeHost({
      'canon-1': { id: 'canon-1', type: 'directive' },
    });
    const plan = { provenance: { derived_from: ['canon-1'] } };
    expect(await findIntentInProvenance(host as never, plan as never)).toBeNull();
  });
  it('does NOT do a transitive walk (v1: direct-only)', async () => {
    const host = makeHost({
      'intent-1': { id: 'intent-1', type: 'operator-intent' },
      'question-1': { id: 'question-1', type: 'question', provenance: { derived_from: ['intent-1'] } },
    });
    const plan = { provenance: { derived_from: ['question-1'] } };
    expect(await findIntentInProvenance(host as never, plan as never)).toBeNull();
  });
  it('handles missing atom gracefully', async () => {
    const host = makeHost({});
    const plan = { provenance: { derived_from: ['missing-id'] } };
    expect(await findIntentInProvenance(host as never, plan as never)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runIntentAutoApprovePass fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-04-24T12:00:00.000Z' as Time;
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE_EXPIRY = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString() as Time;
const PAST_EXPIRY = new Date(NOW_MS - 1).toISOString() as Time;

/**
 * Canonical pol-plan-autonomous-intent-approve directive atom.
 * The tick reads this via a directive-type query, subject === 'plan-autonomous-intent-approve'.
 */
function intentApprovePolicyAtom(overrides: {
  allowed_sub_actors?: string[];
  tainted?: boolean;
} = {}): Atom {
  return {
    schema_version: 1,
    id: 'pol-plan-autonomous-intent-approve' as AtomId,
    content: 'intent approve policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
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
    taint: overrides.tainted ? 'tainted' : 'clean',
    metadata: {
      policy: {
        subject: 'plan-autonomous-intent-approve',
        allowed_sub_actors: overrides.allowed_sub_actors ?? ['code-author', 'auditor-actor'],
      },
    },
  };
}

/**
 * Canonical pol-operator-intent-creation directive atom.
 */
function intentCreationPolicyAtom(overrides: {
  allowed_principal_ids?: string[];
} = {}): Atom {
  return {
    schema_version: 1,
    id: 'pol-operator-intent-creation' as AtomId,
    content: 'intent creation policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
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
        allowed_principal_ids: overrides.allowed_principal_ids ?? ['operator-principal'],
      },
    },
  };
}

/**
 * A fresh, clean operator-intent atom.
 */
function intentAtom(id: string, overrides: {
  principal_id?: string;
  taint?: 'clean' | 'tainted' | 'compromised';
  expires_at?: string;
  max_blast_radius?: string;
  allowed_sub_actors?: string[];
  min_plan_confidence?: number;
} = {}): Atom {
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
    principal_id: (overrides.principal_id ?? 'operator-principal') as PrincipalId,
    taint: overrides.taint ?? 'clean',
    metadata: {
      kind: 'autonomous-solve',
      request: 'fix something',
      trust_envelope: {
        max_blast_radius: overrides.max_blast_radius ?? 'framework',
        max_plans: 5,
        min_plan_confidence: overrides.min_plan_confidence ?? 0.75,
        allowed_sub_actors: overrides.allowed_sub_actors ?? ['code-author', 'auditor-actor'],
        require_ci_green: true,
        require_cr_approve: true,
        require_auditor_observation: true,
      },
      expires_at: overrides.expires_at ?? FUTURE_EXPIRY,
      consumed_by_plans: [],
      consumed_by_questions: [],
    },
  };
}

/**
 * A plan atom citing an intent in provenance.derived_from.
 */
function planAtom(id: string, intentId: string, overrides: {
  plan_state?: Atom['plan_state'];
  confidence?: number;
  sub_actor?: string;
  implied_blast_radius?: string;
  tainted?: boolean;
} = {}): Atom {
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
    confidence: overrides.confidence ?? 0.80,
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
    taint: overrides.tainted ? 'tainted' : 'clean',
    plan_state: overrides.plan_state ?? 'proposed',
    metadata: {
      planning_actor_version: '0.1.0',
      title: 'test plan',
      delegation: {
        sub_actor_principal_id: overrides.sub_actor ?? 'code-author',
        implied_blast_radius: overrides.implied_blast_radius ?? 'framework',
        reason: 'needs code changes',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// runIntentAutoApprovePass tests (10 scenarios)
// ---------------------------------------------------------------------------

describe('runIntentAutoApprovePass', () => {
  // 1. Happy path: fresh intent + envelope matching -> approved
  it('T1: happy path - fresh intent with matching envelope transitions proposed -> approved', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1', { confidence: 0.80 }));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.halted).toBeFalsy();
    expect(result.scanned).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('approved');
    const meta = plan?.metadata as Record<string, unknown>;
    expect(meta['approved_via']).toBe('pol-plan-autonomous-intent-approve');
    expect(meta['approved_intent_id']).toBe('intent-1');
    expect(typeof meta['approved_at']).toBe('string');
  });

  // 2. Kill-switch tripped -> { scanned: 0, approved: 0, halted: true }, NO mutations
  it('T2: kill-switch tripped -> halted:true, no mutations', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-ks'));
    await host.atoms.put(planAtom('plan-ks', 'intent-ks'));

    host.scheduler.kill();

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.halted).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-ks' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 3. Expired intent -> rejected++, plan stays proposed
  it('T3: expired intent -> rejected, plan stays proposed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-exp', { expires_at: PAST_EXPIRY }));
    await host.atoms.put(planAtom('plan-exp', 'intent-exp'));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.rejected).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-exp' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 4. Compromised intent (taint !== 'clean') -> rejected++, plan stays proposed
  it('T4: tainted intent -> rejected, plan stays proposed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-taint', { taint: 'tainted' }));
    await host.atoms.put(planAtom('plan-taint', 'intent-taint'));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.rejected).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-taint' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 5. Non-whitelisted principal -> rejected++
  it('T5: intent from non-whitelisted principal -> rejected', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom({ allowed_principal_ids: ['operator-principal'] }));
    await host.atoms.put(intentAtom('intent-badprincipal', { principal_id: 'rogue-bot' }));
    await host.atoms.put(planAtom('plan-badprincipal', 'intent-badprincipal'));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.rejected).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-badprincipal' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 6. Plan confidence below envelope.min_plan_confidence -> skipped silently (NOT rejected)
  it('T6: plan confidence below min_plan_confidence -> silently skipped, not rejected', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    // Intent requires 0.75 min confidence; plan is at 0.60
    await host.atoms.put(intentAtom('intent-lowconf', { min_plan_confidence: 0.75 }));
    await host.atoms.put(planAtom('plan-lowconf', 'intent-lowconf', { confidence: 0.60 }));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(0);

    const plan = await host.atoms.get('plan-lowconf' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 7. Sub-actor not in envelope.allowed_sub_actors -> skipped silently
  it('T7: plan sub-actor not in intent allowed_sub_actors -> silently skipped', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    // Intent only allows auditor-actor; plan delegates to code-author
    await host.atoms.put(intentAtom('intent-subactor', { allowed_sub_actors: ['auditor-actor'] }));
    await host.atoms.put(planAtom('plan-subactor', 'intent-subactor', { sub_actor: 'code-author' }));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(0);

    const plan = await host.atoms.get('plan-subactor' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 8. Blast-radius exceeds envelope.max_blast_radius -> skipped silently
  it('T8: plan implied_blast_radius exceeds envelope max -> silently skipped', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    // Intent caps at 'tooling'; plan claims 'framework'
    await host.atoms.put(intentAtom('intent-bigblast', { max_blast_radius: 'tooling' }));
    await host.atoms.put(
      planAtom('plan-bigblast', 'intent-bigblast', { implied_blast_radius: 'framework' }),
    );

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(0);

    const plan = await host.atoms.get('plan-bigblast' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 9. Empty allowed_sub_actors in pol-plan-autonomous-intent-approve -> short-circuit, scanned: 0
  it('T9: empty policy allowlist -> short-circuit with scanned: 0', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom({ allowed_sub_actors: [] }));
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-empty'));
    await host.atoms.put(planAtom('plan-empty', 'intent-empty'));

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.scanned).toBe(0);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-empty' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 10. Claim-before-mutate: concurrent worker already moved plan -> no double-approve
  it('T10: concurrent plan state change (claim-before-mutate) -> no double-approve', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-concurrent'));
    await host.atoms.put(planAtom('plan-concurrent', 'intent-concurrent'));

    // Simulate concurrent worker having already approved the plan
    await host.atoms.update('plan-concurrent' as AtomId, { plan_state: 'approved' });

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    // Should scan, but not double-approve (already approved)
    expect(result.approved).toBe(0);
    // Plan must still be in approved state (not regressed)
    const plan = await host.atoms.get('plan-concurrent' as AtomId);
    expect(plan?.plan_state).toBe('approved');
    // Should NOT have overwritten approved_via with our policy (already was approved by another path)
    const meta = plan?.metadata as Record<string, unknown>;
    expect(meta['approved_via']).toBeUndefined();
  });

  // 11. Unknown plan implied_blast_radius -> fail-closed: silently skipped (not approved)
  it('T11: unknown implied_blast_radius on plan -> fail-closed, not approved', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-unknown-radius', { max_blast_radius: 'framework' }));
    await host.atoms.put(
      planAtom('plan-unknown-radius', 'intent-unknown-radius', { implied_blast_radius: 'galaxy-brain' }),
    );

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.approved).toBe(0);
    const plan = await host.atoms.get('plan-unknown-radius' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  // 12. Unknown envelope max_blast_radius -> fail-closed: silently skipped (not approved)
  it('T12: unknown max_blast_radius in envelope -> fail-closed, not approved', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-unknown-env', { max_blast_radius: 'total-destruction' }));
    await host.atoms.put(
      planAtom('plan-unknown-env', 'intent-unknown-env', { implied_blast_radius: 'tooling' }),
    );

    const result = await runIntentAutoApprovePass(host, { now: () => NOW_ISO });

    expect(result.approved).toBe(0);
    const plan = await host.atoms.get('plan-unknown-env' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });
});
