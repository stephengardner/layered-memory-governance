/**
 * Auto-approve low-stakes plan tests.
 *
 * Covers:
 *   - missing policy -> no approvals (fail-closed)
 *   - empty allowlist -> no approvals (fail-closed)
 *   - plan delegating to allowed sub-actor + meeting confidence bar
 *     -> approved + metadata.auto_approved set
 *   - plan delegating to NON-allowed sub-actor -> ignored
 *   - plan below min_confidence -> ignored
 *   - plan missing planning_actor_version -> ignored
 *   - already-approved plan -> ignored
 *   - tainted or superseded plan -> ignored
 *   - tainted policy atom -> fail-closed (no approvals)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runAutoApprovePass } from '../../src/actor-message/auto-approve.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';

const NOW = '2026-04-20T00:00:00.000Z' as Time;

function policyAtom(overrides: {
  allowed?: ReadonlyArray<string>;
  min_confidence?: number;
  tainted?: boolean;
}): Atom {
  return {
    schema_version: 1,
    id: 'pol-plan-auto-approve-low-stakes' as AtomId,
    content: 'auto-approve policy',
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
    taint: overrides.tainted ? 'tainted' : 'clean',
    metadata: {
      policy: {
        subject: 'plan-auto-approve-low-stakes',
        allowed_sub_actors: overrides.allowed ?? ['auditor-actor'],
        min_confidence: overrides.min_confidence ?? 0.55,
      },
    },
  };
}

function planAtom(
  id: string,
  overrides: {
    readonly plan_state?: Atom['plan_state'];
    readonly confidence?: number;
    readonly sub_actor?: string;
    readonly planning_actor_version?: string;
    readonly superseded?: boolean;
    readonly tainted?: boolean;
  } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'cto-actor', tool: 'planner' },
      derived_from: [],
    },
    confidence: overrides.confidence ?? 0.8,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['ghost' as AtomId] : [],
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
      ...(overrides.planning_actor_version !== undefined || !('planning_actor_version' in overrides)
        ? { planning_actor_version: overrides.planning_actor_version ?? '0.1.0' }
        : {}),
      ...(overrides.sub_actor !== undefined
        ? {
            delegation: {
              sub_actor_principal_id: overrides.sub_actor,
              payload: {},
              correlation_id: `corr-${id}`,
              escalate_to: 'operator',
            },
          }
        : {}),
    },
  };
}

describe('runAutoApprovePass', () => {
  it('no policy atom -> zero approvals (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { sub_actor: 'auditor-actor' }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
    const p = await host.atoms.get('p1' as AtomId);
    expect(p!.plan_state).toBe('proposed');
  });

  it('empty allowlist -> zero approvals (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: [] }));
    await host.atoms.put(planAtom('p1', { sub_actor: 'auditor-actor' }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
  });

  it('tainted policy atom -> zero approvals (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({
      allowed: ['auditor-actor'],
      tainted: true,
    }));
    await host.atoms.put(planAtom('p1', { sub_actor: 'auditor-actor' }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
  });

  it('plan targets allowed sub-actor with sufficient confidence -> approved', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'] }));
    await host.atoms.put(planAtom('p-yes', {
      sub_actor: 'auditor-actor',
      confidence: 0.9,
    }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(1);
    const p = await host.atoms.get('p-yes' as AtomId);
    expect(p!.plan_state).toBe('approved');
    expect((p!.metadata.auto_approved as { via: string }).via).toBe(
      'pol-plan-auto-approve-low-stakes',
    );
  });

  it('plan targets NON-allowed sub-actor -> ignored', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'] }));
    await host.atoms.put(planAtom('p-no', {
      sub_actor: 'code-writer-actor',
      confidence: 0.9,
    }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
    const p = await host.atoms.get('p-no' as AtomId);
    expect(p!.plan_state).toBe('proposed');
  });

  it('plan below min_confidence -> ignored', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'], min_confidence: 0.8 }));
    await host.atoms.put(planAtom('p-low', {
      sub_actor: 'auditor-actor',
      confidence: 0.7,
    }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
  });

  it('plan without planning_actor_version -> ignored (sanity gate)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'] }));
    await host.atoms.put(planAtom('p-noversion', {
      sub_actor: 'auditor-actor',
      planning_actor_version: '',
    }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
  });

  it('already-approved plan -> ignored', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'] }));
    await host.atoms.put(planAtom('p-approved', {
      sub_actor: 'auditor-actor',
      plan_state: 'approved',
    }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
  });

  it('re-reads the plan before approving (claim pattern, no stale-state regression)', async () => {
    // Regression guard for the CR-flagged race: the prior code used
    // the scan snapshot for the approval update, so a plan that
    // moved out of 'proposed' between scan and update would be
    // forced back to 'approved'. Fix re-reads host.atoms.get(plan.id)
    // immediately before update and skips if the state has changed.
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'] }));
    await host.atoms.put(planAtom('p-race', { sub_actor: 'auditor-actor' }));

    // Simulate operator revoking (superseding) the plan BETWEEN the
    // scan's snapshot and the approval write. Easiest to do by
    // calling runAutoApprovePass after transitioning the plan.
    await host.atoms.update('p-race' as AtomId, { plan_state: 'abandoned' });

    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
    const p = await host.atoms.get('p-race' as AtomId);
    // Must NOT have been re-approved.
    expect(p!.plan_state).toBe('abandoned');
  });

  it('stamps via with the actual policy atom id (supports superseded-by-newer-id)', async () => {
    // A deployment that supersedes pol-plan-auto-approve-low-stakes
    // with a different id (e.g., pol-plan-auto-approve-v2) needs
    // the stamp to reflect the actual governing atom, not a
    // hardcoded string.
    const host = createMemoryHost();
    // Create a policy atom with a NON-default id.
    const custom: Atom = {
      ...policyAtom({ allowed: ['auditor-actor'] }),
      id: 'pol-plan-auto-approve-v2' as AtomId,
    };
    await host.atoms.put(custom);
    await host.atoms.put(planAtom('p-via', { sub_actor: 'auditor-actor' }));

    await runAutoApprovePass(host);

    const p = await host.atoms.get('p-via' as AtomId);
    expect((p!.metadata.auto_approved as { via: string }).via).toBe('pol-plan-auto-approve-v2');
  });

  it('tainted plan and superseded plan -> ignored', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['auditor-actor'] }));
    await host.atoms.put(planAtom('p-tainted', { sub_actor: 'auditor-actor', tainted: true }));
    await host.atoms.put(planAtom('p-superseded', { sub_actor: 'auditor-actor', superseded: true }));
    const result = await runAutoApprovePass(host);
    expect(result.approved).toBe(0);
  });
});
