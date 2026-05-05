import { describe, it, expect } from 'vitest';
import {
  CODE_AUTHOR_PRINCIPAL_ID,
  codeAuthorResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/code-author-strategy.js';
import {
  addDescriptor,
  createResumeStrategyRegistry,
  type ResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/registry.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import type { AgentLoopInput, AgentTask } from '../../../../src/substrate/agent-loop.js';
import type { ActorWalkInput } from '../../../../examples/agent-loops/resume-author/strategy-common.js';

/**
 * Build a generic atom-skeleton mirroring the shape used in
 * `walk-author-sessions.test.ts`.
 */
function mkBaseAtom(
  id: string,
  type: Atom['type'],
  createdAt: Time,
  principalId: PrincipalId,
  metadata: Record<string, unknown>,
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: id,
    type,
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: String(principalId) },
      derived_from: [],
    },
    confidence: 1,
    created_at: createdAt,
    last_reinforced_at: createdAt,
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
    principal_id: principalId,
    taint: 'clean',
    metadata,
  };
}

function mkCodeAuthorSessionAtom(opts: {
  readonly id: string;
  readonly createdAt: Time;
  readonly startedAt: Time;
  readonly principalId?: PrincipalId;
  readonly resumableSessionId?: string;
  readonly planAtomId?: string;
}): Atom {
  const principalId = opts.principalId ?? CODE_AUTHOR_PRINCIPAL_ID;
  const codeAuthorSlot: Record<string, unknown> = {};
  if (opts.planAtomId !== undefined) {
    codeAuthorSlot['plan_atom_id'] = opts.planAtomId;
  }
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
      code_author: codeAuthorSlot,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
  });
}

/**
 * Build a minimal `AgentLoopInput`-shaped object for testing. Only
 * the fields read by `identifyWorkItem` are populated; the
 * descriptor reads `input.task.planAtomId`.
 */
function mkCodeAuthorInput(planAtomId: string): AgentLoopInput {
  const task: AgentTask = { planAtomId: planAtomId as AtomId };
  // Cast through unknown: the descriptor reads only `task.planAtomId`,
  // so populating the other AgentLoopInput fields with stubs would
  // pollute every test invocation without exercising any code path.
  return { task } as unknown as AgentLoopInput;
}

describe('code-author resume strategy descriptor', () => {
  it('round-trips: register descriptor, walk synthetic atoms, find candidate, identifyWorkItem matches expected key', () => {
    const registry = createResumeStrategyRegistry();
    addDescriptor(
      registry,
      CODE_AUTHOR_PRINCIPAL_ID,
      codeAuthorResumeStrategyDescriptor as ResumeStrategyDescriptor,
      ['code-author:plan-atom-id'],
    );

    const matchingAtom = mkCodeAuthorSessionAtom({
      id: 'session-code-1',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      planAtomId: 'plan-abc-123',
      resumableSessionId: 'uuid-code-1',
    });
    const input = mkCodeAuthorInput('plan-abc-123');
    const expectedKey = 'plan-abc-123';
    expect(codeAuthorResumeStrategyDescriptor.identifyWorkItem(input)).toBe(expectedKey);

    const lookedUp = registry.get(CODE_AUTHOR_PRINCIPAL_ID);
    expect(lookedUp).toBe(codeAuthorResumeStrategyDescriptor);

    const walkInput: ActorWalkInput = {
      atoms: [matchingAtom],
      workItemKey: expectedKey,
    };
    const candidates = codeAuthorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.resumableSessionId).toBe('uuid-code-1');
    expect(candidates[0]!.sessionAtomId).toBe(matchingAtom.id);
  });

  it('work-item key uniqueness: different plan_id values produce distinct keys', () => {
    const a = codeAuthorResumeStrategyDescriptor.identifyWorkItem(
      mkCodeAuthorInput('plan-A'),
    );
    const b = codeAuthorResumeStrategyDescriptor.identifyWorkItem(
      mkCodeAuthorInput('plan-B'),
    );
    expect(a).not.toBe(b);
    // Sanity: equal plan id -> equal key.
    const dup = codeAuthorResumeStrategyDescriptor.identifyWorkItem(
      mkCodeAuthorInput('plan-A'),
    );
    expect(a).toBe(dup);
  });

  it('fresh-spawn fallback: empty candidate list when no atom matches the plan id', () => {
    const otherPlan = mkCodeAuthorSessionAtom({
      id: 'session-other-plan',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      planAtomId: 'plan-other',
      resumableSessionId: 'uuid-other',
    });
    const legacy = mkCodeAuthorSessionAtom({
      id: 'session-legacy',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      planAtomId: 'plan-target',
      // No resumableSessionId -> legacy session, must be skipped.
    });
    const walkInput: ActorWalkInput = {
      atoms: [otherPlan, legacy],
      workItemKey: 'plan-target',
    };
    const candidates = codeAuthorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });

  it('empty store edge case: assembleCandidates([]) returns []', () => {
    const candidates = codeAuthorResumeStrategyDescriptor.assembleCandidates({
      atoms: [],
      workItemKey: 'plan-anything',
    });
    expect(candidates).toEqual([]);
  });

  it('multiple candidates ordering: most-recent wins (newest started_at first)', () => {
    const older = mkCodeAuthorSessionAtom({
      id: 'session-older',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      planAtomId: 'plan-multi',
      resumableSessionId: 'uuid-older',
    });
    const newer = mkCodeAuthorSessionAtom({
      id: 'session-newer',
      createdAt: '2026-04-25T03:00:00.000Z',
      startedAt: '2026-04-25T03:00:00.000Z',
      planAtomId: 'plan-multi',
      resumableSessionId: 'uuid-newer',
    });
    const middle = mkCodeAuthorSessionAtom({
      id: 'session-middle',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      planAtomId: 'plan-multi',
      resumableSessionId: 'uuid-middle',
    });

    const walkInput: ActorWalkInput = {
      // Insert out of order to exercise the sort.
      atoms: [middle, older, newer],
      workItemKey: 'plan-multi',
    };
    const candidates = codeAuthorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.resumableSessionId)).toEqual([
      'uuid-newer',
      'uuid-middle',
      'uuid-older',
    ]);
  });

  it('two-axis filter: rejects atoms with matching plan_id but different principal_id (cross-actor leakage guard)', () => {
    // A cto-actor-authored session that happens to carry a
    // code-author-shaped namespaced metadata slot. The two-axis
    // filter (principal_id + work-item-key) MUST stop this from
    // surfacing.
    const wrongPrincipal = mkCodeAuthorSessionAtom({
      id: 'session-wrong-principal',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      principalId: 'cto-actor' as PrincipalId,
      planAtomId: 'plan-target',
      resumableSessionId: 'uuid-wrong-principal',
    });
    const walkInput: ActorWalkInput = {
      atoms: [wrongPrincipal],
      workItemKey: 'plan-target',
    };
    const candidates = codeAuthorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });

  it('skips atoms missing the namespaced plan_atom_id field', () => {
    const missingSlot = mkCodeAuthorSessionAtom({
      id: 'session-missing-slot',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      // planAtomId omitted -> code_author slot empty -> work-item key undefined.
      resumableSessionId: 'uuid-missing',
    });
    const walkInput: ActorWalkInput = {
      atoms: [missingSlot],
      workItemKey: 'plan-target',
    };
    const candidates = codeAuthorResumeStrategyDescriptor.assembleCandidates(walkInput);
    expect(candidates).toEqual([]);
  });
});
