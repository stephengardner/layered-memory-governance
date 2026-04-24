/**
 * Multi-reviewer plan approval tests.
 *
 * Parallel to auto-approve.test.ts but for the richer
 * multi-principal consensus pass. The pass scans `plan` atoms in
 * state `proposed` and counts fresh `plan-approval-vote` atoms
 * derived_from the plan; when distinct-principal approvals hit the
 * threshold, the plan transitions to `approved`. A single fresh
 * `reject` vote hard-blocks and abandons the plan per
 * pol-plan-multi-reviewer-approval.
 *
 * Covers (maps 1:1 to the design spec test matrix):
 *   - missing policy atom -> no approvals (fail-closed)
 *   - empty allowlist -> no approvals (fail-closed)
 *   - target sub-actor not in allowlist -> no approvals
 *   - plan below min_plan_confidence -> no approvals
 *   - 1 approve vote, threshold 2 -> no approvals
 *   - 2 distinct-principal approve votes -> approved; metadata
 *     carries voter set + policy id
 *   - 2 approve votes from the same principal -> no approvals
 *     (distinct-principal guard)
 *   - 2 approve + 1 reject -> abandoned (hard reject)
 *   - 3 approves but 1 stale -> 2 fresh pass -> approved
 *   - required_roles: ['sre'], 3 approves but none with role 'sre'
 *     -> no approvals
 *   - required_roles: ['sre'], 3 approves including one 'sre'
 *     -> approved
 *   - tainted vote -> ignored (in-code guard, not just predicate)
 *   - superseded vote -> ignored
 *   - tainted plan -> no approvals
 *   - already-approved plan -> no-op
 *   - per-vote confidence below min_vote_confidence -> ignored
 *   - tainted policy atom -> fail-closed (no approvals)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runPlanApprovalTick } from '../../src/actor-message/plan-approval.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const NOW = '2026-04-23T00:00:00.000Z' as Time;
const NOW_MS = Date.parse(NOW);
// Older than the 24h default window.
const STALE = new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString() as Time;

function policyAtom(overrides: {
  allowed?: ReadonlyArray<string>;
  min_votes?: number;
  min_vote_confidence?: number;
  min_plan_confidence?: number;
  required_roles?: ReadonlyArray<string>;
  hard_reject?: boolean;
  max_age_ms?: number;
  tainted?: boolean;
  superseded?: boolean;
}): Atom {
  return {
    schema_version: 1,
    id: 'pol-plan-multi-reviewer-approval' as AtomId,
    content: 'multi-reviewer auto-approval policy',
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
    superseded_by: overrides.superseded ? ['replacement' as AtomId] : [],
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
        subject: 'plan-multi-reviewer-approval',
        allowed_sub_actors: overrides.allowed ?? ['code-author'],
        min_votes: overrides.min_votes ?? 2,
        min_vote_confidence: overrides.min_vote_confidence ?? 0.8,
        min_plan_confidence: overrides.min_plan_confidence ?? 0.85,
        required_roles: overrides.required_roles ?? [],
        hard_reject_on_any_reject: overrides.hard_reject ?? true,
        max_age_ms: overrides.max_age_ms ?? 86_400_000,
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
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: overrides.confidence ?? 0.9,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['replacement' as AtomId] : [],
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
      planning_actor_version: overrides.planning_actor_version ?? '0.1.0',
      title: 'test plan',
      delegation: {
        sub_actor_principal_id: overrides.sub_actor ?? 'code-author',
      },
    },
  };
}

function voteAtom(
  id: string,
  planId: string,
  voter: string,
  overrides: {
    readonly vote?: 'approve' | 'reject';
    readonly confidence?: number;
    readonly role?: string;
    readonly voted_at?: Time;
    readonly tainted?: boolean;
    readonly superseded?: boolean;
  } = {},
): Atom {
  const votedAt = overrides.voted_at ?? NOW;
  return {
    schema_version: 1,
    id: id as AtomId,
    content: overrides.vote === 'reject' ? 'nope' : 'lgtm',
    type: 'plan-approval-vote',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: voter },
      derived_from: [planId as AtomId],
    },
    confidence: overrides.confidence ?? 0.9,
    created_at: votedAt,
    last_reinforced_at: votedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['replacement' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: voter as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    metadata: {
      plan_id: planId,
      vote: overrides.vote ?? 'approve',
      reason: 'test-vote',
      role: overrides.role,
      voted_at: votedAt,
    },
  };
}

describe('runPlanApprovalTick', () => {
  // ----- fail-closed paths -----

  it('missing policy atom: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  it('empty allowlist: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: [] }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('target sub-actor not in allowlist: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ allowed: ['some-other-actor'] }));
    await host.atoms.put(planAtom('p1', { sub_actor: 'code-author' }));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('tainted policy atom: no approvals (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ tainted: true }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('superseded policy atom: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ superseded: true }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  // ----- plan-level guards -----

  it('plan below min_plan_confidence: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_plan_confidence: 0.9 }));
    await host.atoms.put(planAtom('p1', { confidence: 0.8 }));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('tainted plan: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({}));
    await host.atoms.put(planAtom('p1', { tainted: true }));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('already-approved plan: no-op', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({}));
    await host.atoms.put(planAtom('p1', { plan_state: 'approved' }));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  // ----- vote-count paths -----

  it('1 approve vote, threshold 2: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('2 distinct approves: plan approved, metadata carries voter set + policy id', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('approved');
    const mr = plan?.metadata['multi_reviewer_approved'] as Record<string, unknown> | undefined;
    expect(mr).toBeDefined();
    expect(mr?.via).toBe('pol-plan-multi-reviewer-approval');
    expect(mr?.voters).toEqual(expect.arrayContaining(['reviewer-1', 'reviewer-2']));
    expect((mr?.voters as ReadonlyArray<string>).length).toBe(2);
    expect(mr?.at).toBe(NOW);
  });

  it('2 approves from the same principal: no approvals (distinct-principal guard)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-1'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('per-vote confidence below min: vote ignored, threshold not met', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2, min_vote_confidence: 0.9 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1', { confidence: 0.95 }));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2', { confidence: 0.5 }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  // ----- reject / rescind / stale -----

  it('2 approves + 1 reject with hard_reject: plan abandoned', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2, hard_reject: true }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));
    await host.atoms.put(voteAtom('v3', 'p1', 'reviewer-3', { vote: 'reject' }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.rejected).toBe(1);
    expect(r.approved).toBe(0);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('abandoned');
    expect(String(plan?.metadata['abandoned_reason'])).toContain('reviewer-3');
  });

  it('3 approves, 1 stale: 2 fresh pass threshold -> approved, stale counted', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2'));
    await host.atoms.put(voteAtom('v3', 'p1', 'reviewer-3', { voted_at: STALE }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(1);
    expect(r.stale).toBe(1);
  });

  it('tainted vote: ignored by in-code guard', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2', { tainted: true }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('superseded vote: ignored by in-code guard', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2 }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2', { superseded: true }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  // ----- role-based quorum -----

  it('required_roles [sre], no sre voter: no approvals', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2, required_roles: ['sre'] }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1', { role: 'ic' }));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2', { role: 'pm' }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(0);
  });

  it('required_roles [sre], one sre voter: approved', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2, required_roles: ['sre'] }));
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(voteAtom('v1', 'p1', 'reviewer-1', { role: 'sre' }));
    await host.atoms.put(voteAtom('v2', 'p1', 'reviewer-2', { role: 'ic' }));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    expect(r.approved).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('approved');
  });

  // ----- scan counters -----

  it('scanned tracks pre-filter; eligible tracks post-filter; approved tracks transitioned', async () => {
    // 3 plans total: 2 eligible (pass delegation + confidence + state),
    // 1 filtered out (sub-actor not in allowlist). Of the 2 eligible,
    // 1 has enough votes to approve, 1 does not.
    const host = createMemoryHost();
    await host.atoms.put(policyAtom({ min_votes: 2, allowed: ['code-author'] }));
    await host.atoms.put(planAtom('p-1', { sub_actor: 'code-author' }));
    await host.atoms.put(planAtom('p-2', { sub_actor: 'code-author' }));
    await host.atoms.put(planAtom('p-3', { sub_actor: 'some-other-actor' }));
    await host.atoms.put(voteAtom('v1', 'p-1', 'reviewer-1'));
    await host.atoms.put(voteAtom('v2', 'p-1', 'reviewer-2'));

    const r = await runPlanApprovalTick(host, { now: () => NOW });

    // scanned: all 3 plans the pass pulled from the atom store before
    // applying allowlist / confidence / state filters.
    expect(r.scanned).toBe(3);
    // eligible: the 2 plans that passed every plan-level guard and
    // became vote-count candidates. The `some-other-actor` plan is
    // filtered here.
    expect(r.eligible).toBe(2);
    // approved: only p-1 collected enough votes.
    expect(r.approved).toBe(1);
  });
});
