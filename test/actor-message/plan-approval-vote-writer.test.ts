/**
 * Unit coverage for the plan-approval-vote writer primitive.
 *
 * The writer is the seam that `lag-respond [v]` and (in future) other
 * reviewer surfaces use to cast a vote. Tests here exercise it via the
 * memory Host so they stay fast; a companion e2e in
 * test/runtime/plans/plan-approval-vote-e2e.test.ts covers the full
 * "2 votes + runPlanApprovalTick -> plan approved" loop.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  buildPlanApprovalVoteAtom,
  writePlanApprovalVote,
} from '../../src/runtime/actor-message/plan-approval-vote-writer.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';

describe('buildPlanApprovalVoteAtom', () => {
  it('emits a plan-approval-vote atom with derived_from=[planId], metadata.vote, voted_at, role, rationale', () => {
    const atom = buildPlanApprovalVoteAtom({
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      vote: 'approve',
      rationale: 'matches spec, fence atoms intact',
      role: 'reviewer',
      confidence: 0.92,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    });

    expect(atom.type).toBe('plan-approval-vote');
    expect(atom.layer).toBe('L1');
    expect(atom.provenance.derived_from).toEqual(['plan-alpha']);
    expect(atom.provenance.kind).toBe('user-directive');
    expect(atom.metadata['vote']).toBe('approve');
    expect(atom.metadata['voted_at']).toBe('2026-04-23T12:00:00.000Z');
    expect(atom.metadata['role']).toBe('reviewer');
    expect(atom.metadata['rationale']).toBe('matches spec, fence atoms intact');
    expect(atom.metadata['plan_id']).toBe('plan-alpha');
    expect(atom.confidence).toBe(0.92);
    expect(atom.principal_id).toBe('alice');
    expect(atom.scope).toBe('project');
    expect(atom.taint).toBe('clean');
    expect(atom.superseded_by).toEqual([]);
    expect(atom.created_at).toBe('2026-04-23T12:00:00.000Z');
    expect(atom.last_reinforced_at).toBe('2026-04-23T12:00:00.000Z');
  });

  it('emits a stable id keyed on (planId, voterId, nowIso) so tests can assert determinism', () => {
    const a = buildPlanApprovalVoteAtom({
      planId: 'plan-x' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'reject',
      rationale: 'fails fence check',
      role: undefined,
      confidence: 0.9,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    });
    const b = buildPlanApprovalVoteAtom({
      planId: 'plan-x' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'reject',
      rationale: 'different rationale',
      role: undefined,
      confidence: 0.9,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    });
    expect(a.id).toBe(b.id);
  });

  it('omits role from metadata when undefined (not stored as "null" or "undefined")', () => {
    const atom = buildPlanApprovalVoteAtom({
      planId: 'plan-y' as AtomId,
      voterId: 'carol' as PrincipalId,
      vote: 'approve',
      rationale: 'looks good',
      role: undefined,
      confidence: 0.9,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    });
    expect('role' in atom.metadata).toBe(false);
  });

  it('rejects rationale shorter than 10 chars (guard against thoughtless one-word votes)', () => {
    expect(() =>
      buildPlanApprovalVoteAtom({
        planId: 'plan-z' as AtomId,
        voterId: 'dan' as PrincipalId,
        vote: 'approve',
        rationale: 'ok',
        role: undefined,
        confidence: 0.9,
        scope: 'project',
        nowIso: '2026-04-23T12:00:00.000Z' as Time,
      }),
    ).toThrow(/rationale/i);
  });
});

describe('writePlanApprovalVote', () => {
  it('writes the built atom into host.atoms and returns the atom id', async () => {
    const host = createMemoryHost();
    const id = await writePlanApprovalVote(host, {
      planId: 'plan-happy' as AtomId,
      voterId: 'alice' as PrincipalId,
      vote: 'approve',
      rationale: 'ready to ship, fence atoms present',
      role: 'reviewer',
      confidence: 0.95,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    });
    expect(id).toBeTruthy();
    const stored = await host.atoms.get(id);
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe('plan-approval-vote');
    expect(stored!.metadata['vote']).toBe('approve');
    expect(stored!.provenance.derived_from).toEqual(['plan-happy']);
  });

  it('a second vote by the same voter on the same plan is idempotent when same timestamp (ConflictError swallowed or re-asserted)', async () => {
    const host = createMemoryHost();
    const args = {
      planId: 'plan-idem' as AtomId,
      voterId: 'alice' as PrincipalId,
      vote: 'approve' as const,
      rationale: 'ready to ship, fence atoms present',
      role: undefined,
      confidence: 0.95,
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    };
    const firstId = await writePlanApprovalVote(host, args);
    const secondId = await writePlanApprovalVote(host, args);
    expect(firstId).toBe(secondId);
    const all = await host.atoms.query({ type: ['plan-approval-vote'] }, 100);
    expect(all.atoms.length).toBe(1);
  });

  it('a vote with a different timestamp (same voter + plan + vote) creates a distinct atom (reviewer changed their mind mid-window)', async () => {
    const host = createMemoryHost();
    const base = {
      planId: 'plan-changer' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'approve' as const,
      rationale: 'initial read, looks fine on surface',
      role: undefined,
      confidence: 0.9,
      scope: 'project' as const,
    };
    const a = await writePlanApprovalVote(host, {
      ...base,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
    });
    const b = await writePlanApprovalVote(host, {
      ...base,
      vote: 'reject',
      rationale: 'second read revealed fence drift, change my vote',
      nowIso: '2026-04-23T12:05:00.000Z' as Time,
    });
    expect(a).not.toBe(b);
    const all = await host.atoms.query({ type: ['plan-approval-vote'] }, 100);
    expect(all.atoms.length).toBe(2);
  });
});
