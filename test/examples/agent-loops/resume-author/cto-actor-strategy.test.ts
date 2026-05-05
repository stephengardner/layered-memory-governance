import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import {
  CTO_ACTOR_PRINCIPAL_ID,
  ctoActorResumeStrategyDescriptor,
  type CtoActorResumeInput,
} from '../../../../examples/agent-loops/resume-author/cto-actor-strategy.js';
import {
  addDescriptor,
  createResumeStrategyRegistry,
  type ResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/registry.js';
import type {
  Atom,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import type { AgentLoopInput } from '../../../../src/substrate/agent-loop.js';
import type { ActorWalkInput } from '../../../../examples/agent-loops/resume-author/strategy-common.js';
import { mkBaseAtom } from './test-helpers.js';

function mkCtoSessionAtom(opts: {
  readonly id: string;
  readonly createdAt: Time;
  readonly startedAt: Time;
  readonly principalId?: PrincipalId;
  readonly resumableSessionId?: string;
  readonly requestHash?: string;
  readonly iterationN?: number;
}): Atom {
  const principalId = opts.principalId ?? CTO_ACTOR_PRINCIPAL_ID;
  const ctoSlot: Record<string, unknown> = {};
  if (opts.requestHash !== undefined) ctoSlot['request_hash'] = opts.requestHash;
  if (opts.iterationN !== undefined) ctoSlot['iteration_n'] = opts.iterationN;
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
      cto_actor: ctoSlot,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
  });
}

/**
 * Build a minimal `AgentLoopInput`-shaped object for testing. Only
 * the fields read by `identifyWorkItem` are populated; the
 * descriptor reads `requestHash`, `iterationN`, and `correlationId`.
 */
function mkCtoInput(opts: {
  readonly correlationId?: string;
  readonly requestHash?: string;
  readonly iterationN?: number;
}): CtoActorResumeInput {
  const base = {
    correlationId: opts.correlationId ?? 'corr-default',
    // The remaining AgentLoopInput fields are unused by
    // identifyWorkItem; cast through unknown to avoid populating
    // every required field with a stub on every test invocation.
  } as unknown as AgentLoopInput;
  return {
    ...base,
    ...(opts.requestHash !== undefined ? { requestHash: opts.requestHash } : {}),
    ...(opts.iterationN !== undefined ? { iterationN: opts.iterationN } : {}),
  };
}

describe('cto-actor resume strategy descriptor', () => {
  it('round-trips: register descriptor, walk synthetic atoms, find candidate, identifyWorkItem matches expected key', async () => {
    const host = createMemoryHost();
    const registry = createResumeStrategyRegistry();
    addDescriptor(
      registry,
      CTO_ACTOR_PRINCIPAL_ID,
      ctoActorResumeStrategyDescriptor as ResumeStrategyDescriptor,
      ['cto-actor:request-hash'],
    );

    // Seed an agent-session atom matching request_hash=req-A, iteration_n=2.
    const matchingAtom = mkCtoSessionAtom({
      id: 'session-cto-1',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      requestHash: 'req-A',
      iterationN: 2,
      resumableSessionId: 'uuid-cto-1',
    });
    await host.atoms.put(matchingAtom);

    const input = mkCtoInput({ requestHash: 'req-A', iterationN: 2 });
    const expectedKey = 'req-A:2';
    expect(ctoActorResumeStrategyDescriptor.identifyWorkItem(input)).toBe(expectedKey);

    const lookedUp = registry.get(CTO_ACTOR_PRINCIPAL_ID);
    expect(lookedUp).toBe(ctoActorResumeStrategyDescriptor);

    const walkInput: ActorWalkInput = {
      atoms: [matchingAtom],
      workItemKey: expectedKey,
    };
    const candidates = ctoActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.resumableSessionId).toBe('uuid-cto-1');
    expect(candidates[0]!.sessionAtomId).toBe(matchingAtom.id);
  });

  it('work-item key uniqueness across (request_hash x iteration_n)', () => {
    const a = ctoActorResumeStrategyDescriptor.identifyWorkItem(
      mkCtoInput({ requestHash: 'req-A', iterationN: 1 }),
    );
    const b = ctoActorResumeStrategyDescriptor.identifyWorkItem(
      mkCtoInput({ requestHash: 'req-A', iterationN: 2 }),
    );
    const c = ctoActorResumeStrategyDescriptor.identifyWorkItem(
      mkCtoInput({ requestHash: 'req-B', iterationN: 1 }),
    );
    // Same request_hash, different iteration -> distinct keys.
    expect(a).not.toBe(b);
    // Different request_hash, same iteration -> distinct keys.
    expect(a).not.toBe(c);
    // Sanity: equal inputs produce equal keys.
    const dup = ctoActorResumeStrategyDescriptor.identifyWorkItem(
      mkCtoInput({ requestHash: 'req-A', iterationN: 1 }),
    );
    expect(a).toBe(dup);
  });

  it('identifyWorkItem falls back to correlationId when requestHash + iterationN are absent (forward-looking guard)', () => {
    const key = ctoActorResumeStrategyDescriptor.identifyWorkItem(
      mkCtoInput({ correlationId: 'corr-fallback' }),
    );
    expect(key).toBe('corr-fallback:0');
  });

  it('fresh-spawn fallback: returns empty when no candidate atom matches the work-item key', () => {
    // One atom with a non-matching request_hash; another with a
    // matching request_hash but legacy (no resumable_session_id).
    const nonMatching = mkCtoSessionAtom({
      id: 'session-other-key',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      requestHash: 'other-req',
      iterationN: 0,
      resumableSessionId: 'uuid-other',
    });
    const legacy = mkCtoSessionAtom({
      id: 'session-legacy',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      requestHash: 'req-A',
      iterationN: 1,
      // No resumableSessionId -> legacy session, must be skipped.
    });
    const walkInput: ActorWalkInput = {
      atoms: [nonMatching, legacy],
      workItemKey: 'req-A:1',
    };
    const candidates = ctoActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });

  it('empty store edge case: assembleCandidates([]) returns []', () => {
    const candidates = ctoActorResumeStrategyDescriptor.assembleCandidates({
      atoms: [],
      workItemKey: 'req-A:0',
    });
    expect(candidates).toEqual([]);
  });

  it('multiple candidates ordering: most-recent wins (newest started_at first)', () => {
    const older = mkCtoSessionAtom({
      id: 'session-older',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      requestHash: 'req-A',
      iterationN: 0,
      resumableSessionId: 'uuid-older',
    });
    const newer = mkCtoSessionAtom({
      id: 'session-newer',
      createdAt: '2026-04-25T03:00:00.000Z',
      startedAt: '2026-04-25T03:00:00.000Z',
      requestHash: 'req-A',
      iterationN: 0,
      resumableSessionId: 'uuid-newer',
    });
    const middle = mkCtoSessionAtom({
      id: 'session-middle',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      requestHash: 'req-A',
      iterationN: 0,
      resumableSessionId: 'uuid-middle',
    });

    const walkInput: ActorWalkInput = {
      // Insert in non-chronological order to exercise the sort.
      atoms: [older, newer, middle],
      workItemKey: 'req-A:0',
    };
    const candidates = ctoActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.resumableSessionId)).toEqual([
      'uuid-newer',
      'uuid-middle',
      'uuid-older',
    ]);
  });

  it('two-axis filter: rejects atoms with matching work-item key but different principal_id (cross-actor leakage guard)', () => {
    // A code-author-authored session that happens to carry a
    // cto-actor-shaped namespaced metadata slot. The two-axis filter
    // (principal_id + work-item-key) MUST stop this from surfacing.
    const wrongPrincipal = mkCtoSessionAtom({
      id: 'session-wrong-principal',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      principalId: 'code-author' as PrincipalId,
      requestHash: 'req-A',
      iterationN: 0,
      resumableSessionId: 'uuid-wrong-principal',
    });
    const walkInput: ActorWalkInput = {
      atoms: [wrongPrincipal],
      workItemKey: 'req-A:0',
    };
    const candidates = ctoActorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });
});
