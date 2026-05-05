/**
 * Unit tests for `pr-fix-actor-strategy.ts` (Phase 3, PR #308).
 *
 * Mirrors the cto-actor + code-author test files in shape (see
 * `test/examples/agent-loops/resume-author/cto-actor-strategy.test.ts`).
 * The descriptor's `assembleCandidates` delegates to
 * `walkAuthorSessionsForPrFix` (synchronous, host-free) so the tests
 * construct a synthetic atom list + walk input directly without
 * spinning up a Host. The walker test cases proper live in
 * `walk-author-sessions.test.ts`; this file exercises the descriptor's
 * shape: `identifyWorkItem` derivation, registry round-trip, two-axis
 * filter at the descriptor seam.
 */

import { describe, it, expect } from 'vitest';
import {
  PR_FIX_ACTOR_PRINCIPAL_ID,
  encodePrFixWorkItemKey,
  prFixActorResumeStrategyDescriptor,
  type PrFixActorResumeInput,
} from '../../../../examples/agent-loops/resume-author/pr-fix-actor-strategy.js';
import {
  addDescriptor,
  createResumeStrategyRegistry,
  type ResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/registry.js';
import type { PrFixWalkInput } from '../../../../examples/agent-loops/resume-author/walk-author-sessions.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import type { AgentLoopInput } from '../../../../src/substrate/agent-loop.js';
import { mkBaseAtom } from './test-helpers.js';

const PR_FIX_PRINCIPAL = PR_FIX_ACTOR_PRINCIPAL_ID;
const OWNER = 'stephengardner';
const REPO = 'layered-autonomous-governance';
const PR_NUMBER = 308;

function mkObservationAtom(opts: {
  readonly id: string;
  readonly createdAt: Time;
  readonly priorObservationAtomId?: string;
  readonly dispatchedSessionAtomId?: string;
  readonly principalId?: PrincipalId;
  readonly prOwner?: string;
  readonly prRepo?: string;
  readonly prNumber?: number;
}): Atom {
  const principalId = opts.principalId ?? PR_FIX_PRINCIPAL;
  const prFixObservation: Record<string, unknown> = {
    pr_owner: opts.prOwner ?? OWNER,
    pr_repo: opts.prRepo ?? REPO,
    pr_number: opts.prNumber ?? PR_NUMBER,
    head_branch: 'feat/test',
    head_sha: 'abc1234567',
    cr_review_states: [],
    merge_state_status: null,
    mergeable: null,
    line_comment_count: 0,
    body_nit_count: 0,
    check_run_failure_count: 0,
    legacy_status_failure_count: 0,
    partial: false,
    classification: 'has-findings',
  };
  if (opts.dispatchedSessionAtomId !== undefined) {
    prFixObservation['dispatched_session_atom_id'] = opts.dispatchedSessionAtomId;
  }
  const atom = mkBaseAtom(opts.id, 'observation', opts.createdAt, principalId, {
    kind: 'pr-fix-observation',
    pr_fix_observation: prFixObservation,
  });
  if (opts.priorObservationAtomId !== undefined) {
    return {
      ...atom,
      provenance: {
        ...atom.provenance,
        derived_from: [opts.priorObservationAtomId as AtomId],
      },
    };
  }
  return atom;
}

function mkPrFixSessionAtom(opts: {
  readonly id: string;
  readonly createdAt: Time;
  readonly startedAt: Time;
  readonly principalId?: PrincipalId;
  readonly resumableSessionId?: string;
}): Atom {
  const principalId = opts.principalId ?? PR_FIX_PRINCIPAL;
  const extra: Record<string, unknown> = {};
  if (opts.resumableSessionId !== undefined) {
    extra['resumable_session_id'] = opts.resumableSessionId;
  }
  return mkBaseAtom(opts.id, 'agent-session', opts.createdAt, principalId, {
    agent_session: {
      model_id: 'stub-model',
      adapter_id: 'claude-code-agent-loop',
      workspace_id: 'ws-1',
      started_at: opts.startedAt,
      terminal_state: 'completed',
      replay_tier: 'best-effort',
      budget_consumed: { turns: 1, wall_clock_ms: 1 },
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
  });
}

function mkPrFixInput(opts: {
  readonly correlationId?: string;
  readonly prOwner?: string;
  readonly prRepo?: string;
  readonly prNumber?: number;
}): PrFixActorResumeInput {
  const base = {
    correlationId: opts.correlationId ?? 'corr-default',
  } as unknown as AgentLoopInput;
  return {
    ...base,
    ...(opts.prOwner !== undefined ? { prOwner: opts.prOwner } : {}),
    ...(opts.prRepo !== undefined ? { prRepo: opts.prRepo } : {}),
    ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
  };
}

function mkSessionsMap(sessions: ReadonlyArray<Atom>): ReadonlyMap<string, Atom> {
  const map = new Map<string, Atom>();
  for (const s of sessions) map.set(String(s.id), s);
  return map;
}

describe('pr-fix-actor resume strategy descriptor', () => {
  it('round-trips: register descriptor, walk synthetic atoms, find candidate, identifyWorkItem matches expected key', () => {
    const registry = createResumeStrategyRegistry();
    addDescriptor(
      registry,
      PR_FIX_ACTOR_PRINCIPAL_ID,
      prFixActorResumeStrategyDescriptor as ResumeStrategyDescriptor,
      ['pr-fix:'],
    );

    const sessionAtom = mkPrFixSessionAtom({
      id: 'session-pr-fix-1',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      resumableSessionId: 'uuid-pr-fix-1',
    });
    const observation = mkObservationAtom({
      id: 'obs-1',
      createdAt: '2026-04-25T01:00:30.000Z',
      dispatchedSessionAtomId: sessionAtom.id,
    });

    const input = mkPrFixInput({ prOwner: OWNER, prRepo: REPO, prNumber: PR_NUMBER });
    const expectedKey = encodePrFixWorkItemKey(OWNER, REPO, PR_NUMBER);
    expect(prFixActorResumeStrategyDescriptor.identifyWorkItem(input)).toBe(expectedKey);

    const lookedUp = registry.get(PR_FIX_ACTOR_PRINCIPAL_ID);
    expect(lookedUp).toBe(prFixActorResumeStrategyDescriptor);

    const walkInput: PrFixWalkInput = {
      observations: [observation],
      sessionsById: mkSessionsMap([sessionAtom]),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    };
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.resumableSessionId).toBe('uuid-pr-fix-1');
    expect(candidates[0]!.sessionAtomId).toBe(sessionAtom.id);
  });

  it('encodePrFixWorkItemKey produces a stable string with PR-tuple format', () => {
    expect(encodePrFixWorkItemKey('alice', 'repo', 1)).toBe('pr-fix:alice/repo#1');
    expect(encodePrFixWorkItemKey('alice', 'repo', 999)).toBe('pr-fix:alice/repo#999');
  });

  it('work-item key uniqueness across (owner x repo x number)', () => {
    const a = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ prOwner: 'alice', prRepo: 'repo', prNumber: 1 }),
    );
    const b = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ prOwner: 'alice', prRepo: 'repo', prNumber: 2 }),
    );
    const c = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ prOwner: 'bob', prRepo: 'repo', prNumber: 1 }),
    );
    const d = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ prOwner: 'alice', prRepo: 'other', prNumber: 1 }),
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    // Sanity: equal inputs produce equal keys.
    const dup = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ prOwner: 'alice', prRepo: 'repo', prNumber: 1 }),
    );
    expect(a).toBe(dup);
  });

  it('identifyWorkItem falls back to correlationId when PR identity fields are absent (forward-looking guard)', () => {
    // Today's substrate does not surface PR identity on AgentLoopInput;
    // the descriptor falls back to a correlationId-keyed key so the
    // assembleCandidates walk produces an empty list (fresh-spawn) and
    // the wrapper delegates to the fallback adapter cleanly.
    const key = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ correlationId: 'corr-fallback' }),
    );
    expect(key).toBe('pr-fix:corr-fallback');
  });

  it('identifyWorkItem ignores partial PR identity (any missing field -> fallback)', () => {
    // Partial fields (e.g., prOwner without prRepo) MUST NOT produce a
    // half-formed key; the descriptor falls back to the correlationId
    // path. This prevents a typo on the runner from silently routing
    // resume to a sibling PR.
    const key = prFixActorResumeStrategyDescriptor.identifyWorkItem(
      mkPrFixInput({ correlationId: 'corr-x', prOwner: 'alice', prRepo: 'repo' }),
    );
    expect(key).toBe('pr-fix:corr-x');
  });

  it('fresh-spawn fallback: returns empty when no observation matches the PR identity', () => {
    const sessionAtom = mkPrFixSessionAtom({
      id: 'session-other',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      resumableSessionId: 'uuid-other',
    });
    const otherPrObs = mkObservationAtom({
      id: 'obs-other',
      createdAt: '2026-04-25T01:00:30.000Z',
      dispatchedSessionAtomId: sessionAtom.id,
      prOwner: 'alice',
      prRepo: 'other-repo',
      prNumber: 99,
    });

    const walkInput: PrFixWalkInput = {
      observations: [otherPrObs],
      sessionsById: mkSessionsMap([sessionAtom]),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    };
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });

  it('empty store edge case: assembleCandidates([]) returns []', () => {
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates({
      observations: [],
      sessionsById: new Map(),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    });
    expect(candidates).toEqual([]);
  });

  it('multiple candidates ordering: most-recent wins (newest started_at first)', () => {
    const sessionOlder = mkPrFixSessionAtom({
      id: 'session-older',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      resumableSessionId: 'uuid-older',
    });
    const sessionMiddle = mkPrFixSessionAtom({
      id: 'session-middle',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      resumableSessionId: 'uuid-middle',
    });
    const sessionNewer = mkPrFixSessionAtom({
      id: 'session-newer',
      createdAt: '2026-04-25T03:00:00.000Z',
      startedAt: '2026-04-25T03:00:00.000Z',
      resumableSessionId: 'uuid-newer',
    });
    // Three observations chained newest-first, each pointing back at
    // the previous.
    const obsOlder = mkObservationAtom({
      id: 'obs-older',
      createdAt: '2026-04-25T01:00:30.000Z',
      dispatchedSessionAtomId: sessionOlder.id,
    });
    const obsMiddle = mkObservationAtom({
      id: 'obs-middle',
      createdAt: '2026-04-25T02:00:30.000Z',
      dispatchedSessionAtomId: sessionMiddle.id,
      priorObservationAtomId: obsOlder.id,
    });
    const obsNewer = mkObservationAtom({
      id: 'obs-newer',
      createdAt: '2026-04-25T03:00:30.000Z',
      dispatchedSessionAtomId: sessionNewer.id,
      priorObservationAtomId: obsMiddle.id,
    });

    const walkInput: PrFixWalkInput = {
      observations: [obsNewer, obsMiddle, obsOlder],
      sessionsById: mkSessionsMap([sessionOlder, sessionMiddle, sessionNewer]),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    };
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.resumableSessionId)).toEqual([
      'uuid-newer',
      'uuid-middle',
      'uuid-older',
    ]);
  });

  it('two-axis filter: rejects observations authored by a different principal (cross-actor leakage guard)', () => {
    // A code-author-authored observation that happens to carry a
    // pr-fix-shaped namespaced metadata slot. The two-axis filter
    // (principal_id + work-item-key) MUST stop this from surfacing.
    const sessionAtom = mkPrFixSessionAtom({
      id: 'session-shared',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      resumableSessionId: 'uuid-shared',
    });
    const wrongPrincipal = mkObservationAtom({
      id: 'obs-wrong-principal',
      createdAt: '2026-04-25T01:00:30.000Z',
      dispatchedSessionAtomId: sessionAtom.id,
      principalId: 'code-author' as PrincipalId,
    });
    const walkInput: PrFixWalkInput = {
      observations: [wrongPrincipal],
      sessionsById: mkSessionsMap([sessionAtom]),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    };
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });

  it('two-axis filter: rejects sessions authored by a different principal even when observation is pr-fix-actor', () => {
    // The observation walks correctly but the dispatched session was
    // authored by another principal. The walker MUST skip the
    // mismatched session rather than fabricate a candidate from it.
    const wrongPrincipalSession = mkPrFixSessionAtom({
      id: 'session-cross-principal',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      principalId: 'code-author' as PrincipalId,
      resumableSessionId: 'uuid-cross',
    });
    const observation = mkObservationAtom({
      id: 'obs-1',
      createdAt: '2026-04-25T01:00:30.000Z',
      dispatchedSessionAtomId: wrongPrincipalSession.id,
    });
    const walkInput: PrFixWalkInput = {
      observations: [observation],
      sessionsById: mkSessionsMap([wrongPrincipalSession]),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    };
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });

  it('skips legacy sessions lacking resumable_session_id', () => {
    const legacySession = mkPrFixSessionAtom({
      id: 'session-legacy',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      // No resumableSessionId -> legacy session, must be skipped.
    });
    const observation = mkObservationAtom({
      id: 'obs-1',
      createdAt: '2026-04-25T01:00:30.000Z',
      dispatchedSessionAtomId: legacySession.id,
    });
    const walkInput: PrFixWalkInput = {
      observations: [observation],
      sessionsById: mkSessionsMap([legacySession]),
      prIdentity: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    };
    const candidates = prFixActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });
});
