/**
 * Unit coverage for the plan-approval-vote writer primitive.
 *
 * The writer is the seam that `lag-respond [v]` and (in future) other
 * reviewer surfaces use to cast a vote. Tests here exercise it via the
 * memory Host so they stay fast; a companion e2e in
 * test/actor-message/plan-approval-vote-e2e.test.ts covers the full
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
      tool: 'test-surface',
    });

    expect(atom.type).toBe('plan-approval-vote');
    expect(atom.layer).toBe('L1');
    expect(atom.provenance.derived_from).toEqual(['plan-alpha']);
    expect(atom.provenance.kind).toBe('user-directive');
    expect(atom.provenance.source.tool).toBe('test-surface');
    expect(atom.provenance.source.agent_id).toBe('alice');
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

  it('emits a stable id on identical inputs (exact-duplicate idempotency)', () => {
    const args = {
      planId: 'plan-x' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'reject' as const,
      rationale: 'fails fence check at line 42',
      confidence: 0.9,
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
    };
    const a = buildPlanApprovalVoteAtom(args);
    const b = buildPlanApprovalVoteAtom(args);
    expect(a.id).toBe(b.id);
  });

  it('different rationale at same (planId, voterId, vote, nowIso) -> distinct id (CR #131 fix)', () => {
    const base = {
      planId: 'plan-x' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'reject' as const,
      confidence: 0.9,
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
    };
    const a = buildPlanApprovalVoteAtom({ ...base, rationale: 'initial read, fails fence check' });
    const b = buildPlanApprovalVoteAtom({ ...base, rationale: 'second read, different rationale entirely' });
    expect(a.id).not.toBe(b.id);
  });

  it('different role at same base -> distinct id', () => {
    const base = {
      planId: 'plan-x' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'approve' as const,
      rationale: 'looks fine on surface read',
      confidence: 0.9,
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
    };
    const a = buildPlanApprovalVoteAtom({ ...base, role: 'reviewer' });
    const b = buildPlanApprovalVoteAtom({ ...base, role: 'sre' });
    expect(a.id).not.toBe(b.id);
  });

  it('different confidence at same base -> distinct id', () => {
    const base = {
      planId: 'plan-x' as AtomId,
      voterId: 'bob' as PrincipalId,
      vote: 'approve' as const,
      rationale: 'looks fine on surface read',
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
    };
    const a = buildPlanApprovalVoteAtom({ ...base, confidence: 0.9 });
    const b = buildPlanApprovalVoteAtom({ ...base, confidence: 0.75 });
    expect(a.id).not.toBe(b.id);
  });

  it('omits role from metadata when undefined (not stored as "null" or "undefined")', () => {
    const atom = buildPlanApprovalVoteAtom({
      planId: 'plan-y' as AtomId,
      voterId: 'carol' as PrincipalId,
      vote: 'approve',
      rationale: 'looks good, ready to ship',
      confidence: 0.9,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
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
        confidence: 0.9,
        scope: 'project',
        nowIso: '2026-04-23T12:00:00.000Z' as Time,
        tool: 'test-surface',
      }),
    ).toThrow(/rationale/i);
  });

  it('threads sessionId through to provenance.source when provided', () => {
    const atom = buildPlanApprovalVoteAtom({
      planId: 'plan-s' as AtomId,
      voterId: 'eve' as PrincipalId,
      vote: 'approve',
      rationale: 'session-traced write looks good',
      confidence: 0.9,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
      sessionId: 'session-abc-123',
    });
    expect(atom.provenance.source.session_id).toBe('session-abc-123');
  });

  it('omits session_id from provenance.source when not provided (no empty string stored)', () => {
    const atom = buildPlanApprovalVoteAtom({
      planId: 'plan-t' as AtomId,
      voterId: 'frank' as PrincipalId,
      vote: 'approve',
      rationale: 'no session context, clean vote',
      confidence: 0.9,
      scope: 'project',
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
    });
    expect('session_id' in atom.provenance.source).toBe(false);
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
      tool: 'test-surface',
    });
    expect(id).toBeTruthy();
    const stored = await host.atoms.get(id);
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe('plan-approval-vote');
    expect(stored!.metadata['vote']).toBe('approve');
    expect(stored!.provenance.derived_from).toEqual(['plan-happy']);
  });

  it('a second vote by the same voter on the same plan is idempotent when same timestamp + same payload (ConflictError swallowed)', async () => {
    const host = createMemoryHost();
    const args = {
      planId: 'plan-idem' as AtomId,
      voterId: 'alice' as PrincipalId,
      vote: 'approve' as const,
      rationale: 'ready to ship, fence atoms present',
      confidence: 0.95,
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
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
      confidence: 0.9,
      scope: 'project' as const,
      tool: 'test-surface',
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

  it('same-ms re-submit with a corrected rationale lands a second atom (CR #131: intent-changing re-submit must not be silently eaten)', async () => {
    const host = createMemoryHost();
    const base = {
      planId: 'plan-corrector' as AtomId,
      voterId: 'carol' as PrincipalId,
      vote: 'approve' as const,
      confidence: 0.9,
      scope: 'project' as const,
      nowIso: '2026-04-23T12:00:00.000Z' as Time,
      tool: 'test-surface',
    };
    const firstId = await writePlanApprovalVote(host, {
      ...base,
      rationale: 'typo in initial rationale, wil fix',
    });
    const secondId = await writePlanApprovalVote(host, {
      ...base,
      rationale: 'corrected rationale after re-reading spec',
    });
    expect(firstId).not.toBe(secondId);
    const all = await host.atoms.query({ type: ['plan-approval-vote'] }, 100);
    expect(all.atoms.length).toBe(2);
  });
});
