/**
 * Interactive-vote primitives for lag-respond. Tests the pieces in
 * isolation (plan-id resolution + prompt sequencing + vote writing)
 * so the main CLI loop remains a thin shell and the mutation paths
 * are covered without needing a real TTY.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  castVoteInteractive,
  resolvePlanIdFromAtomRefs,
} from '../../src/cli/respond-vote.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const NOW = '2026-04-23T12:00:00.000Z' as Time;

function plan(id: string): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto' }, derived_from: [] },
    confidence: 0.9,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto' as PrincipalId,
    taint: 'clean',
    plan_state: 'proposed',
    metadata: { title: 'test plan' },
  };
}

function observation(id: string): Atom {
  return {
    ...plan(id),
    type: 'observation',
    plan_state: undefined,
  } as Atom;
}

/**
 * Build a linesIterator from an array of lines. Each call to
 * .next() returns the next line (or { done: true } when exhausted).
 * Mirrors what `rl[Symbol.asyncIterator]()` produces in the CLI so the
 * prompt code under test sees the same shape as in production.
 */
function mockLineIter(lines: ReadonlyArray<string>): AsyncIterableIterator<string> {
  let i = 0;
  return {
    async next() {
      if (i >= lines.length) return { value: undefined as unknown as string, done: true };
      return { value: lines[i++]!, done: false };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

describe('resolvePlanIdFromAtomRefs', () => {
  it('returns the first atom_ref whose type is "plan"', async () => {
    const host = createMemoryHost();
    await host.atoms.put(observation('obs-1'));
    await host.atoms.put(plan('plan-alpha'));

    const r = await resolvePlanIdFromAtomRefs(host, ['obs-1' as AtomId, 'plan-alpha' as AtomId]);
    expect(r).toBe('plan-alpha');
  });

  it('returns null when no atom_ref is a plan', async () => {
    const host = createMemoryHost();
    await host.atoms.put(observation('obs-1'));

    const r = await resolvePlanIdFromAtomRefs(host, ['obs-1' as AtomId]);
    expect(r).toBeNull();
  });

  it('returns null on empty atom_refs', async () => {
    const host = createMemoryHost();
    const r = await resolvePlanIdFromAtomRefs(host, []);
    expect(r).toBeNull();
  });

  it('returns null on unknown ids (not in store)', async () => {
    const host = createMemoryHost();
    const r = await resolvePlanIdFromAtomRefs(host, ['nonexistent' as AtomId]);
    expect(r).toBeNull();
  });
});

describe('castVoteInteractive', () => {
  it('happy path: approve + rationale + role -> writes plan-approval-vote atom', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter([
      'a', // approve
      'ready to ship, fence atoms verified', // rationale
      'reviewer', // role
      '', // confidence (default)
    ]);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r).not.toBeNull();
    expect(r!.disposition).toBe('approve');
    const votes = await host.atoms.query({ type: ['plan-approval-vote'] }, 10);
    expect(votes.atoms.length).toBe(1);
    expect(votes.atoms[0]!.metadata['vote']).toBe('approve');
    expect(votes.atoms[0]!.metadata['rationale']).toBe('ready to ship, fence atoms verified');
    expect(votes.atoms[0]!.metadata['role']).toBe('reviewer');
  });

  it('reject path: reject + rationale + no role -> writes reject vote', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter([
      'r', // reject
      'plan violates fence atoms, will regress',
      '', // no role
      '', // default confidence
    ]);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'bob' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r!.disposition).toBe('reject');
    const votes = await host.atoms.query({ type: ['plan-approval-vote'] }, 10);
    expect(votes.atoms.length).toBe(1);
    expect(votes.atoms[0]!.metadata['vote']).toBe('reject');
    expect('role' in votes.atoms[0]!.metadata).toBe(false);
  });

  it('cancel path: c at the vote prompt -> returns null, no atom written', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter(['c']);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r).toBeNull();
    const votes = await host.atoms.query({ type: ['plan-approval-vote'] }, 10);
    expect(votes.atoms.length).toBe(0);
  });

  it('unrecognized vote key -> returns null, no atom written (caller can re-prompt)', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter(['x']);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r).toBeNull();
  });

  it('short rationale -> returns null, no atom written (policy: >= 10 chars)', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter(['a', 'ok', 'reviewer', '']);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r).toBeNull();
    const votes = await host.atoms.query({ type: ['plan-approval-vote'] }, 10);
    expect(votes.atoms.length).toBe(0);
  });

  it('custom confidence -> carried through to atom', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter([
      'a',
      'looks sound after careful review',
      '',
      '0.75',
    ]);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r!.disposition).toBe('approve');
    const votes = await host.atoms.query({ type: ['plan-approval-vote'] }, 10);
    expect(votes.atoms[0]!.confidence).toBe(0.75);
  });

  it('invalid confidence value -> returns null, no atom written', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter([
      'a',
      'well-reviewed rationale here',
      '',
      '1.5', // out of [0, 1]
    ]);
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r).toBeNull();
    const votes = await host.atoms.query({ type: ['plan-approval-vote'] }, 10);
    expect(votes.atoms.length).toBe(0);
  });

  it('stdin closes mid-flow -> returns null (clean bail)', async () => {
    const host = createMemoryHost();
    const iter = mockLineIter(['a']); // approve, then EOF
    const r = await castVoteInteractive(host, iter, {
      planId: 'plan-alpha' as AtomId,
      voterId: 'alice' as PrincipalId,
      scope: 'project',
      nowIso: NOW,
    });
    expect(r).toBeNull();
  });
});
