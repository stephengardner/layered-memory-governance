/**
 * Deliberation coordinator tests.
 *
 * `deliberate` drives a set of AgentHandles through bounded rounds of
 * Question -> Positions -> (optional Counters), then resolves via the
 * substrate arbitrator, emitting a Decision or an Escalation.
 *
 * The coordinator is mocked at the AgentHandle boundary (no real SDK
 * calls) and at the sink boundary (no AtomStore). Assertions verify
 * the full atom chain (Question / Positions / Counters / Decision|
 * Escalation) lands with the expected shape and authorship.
 */
import { describe, expect, it, vi } from 'vitest';

import { deliberate } from '../../../src/integrations/agent-sdk/coordinator.js';
import type { AgentHandle } from '../../../src/integrations/agent-sdk/agent-process.js';
import {
  validateCounter,
  validateDecision,
  validateEscalation,
  validatePosition,
  validateQuestion,
  type Counter,
  type Decision,
  type Escalation,
  type Position,
  type Question,
} from '../../../src/substrate/deliberation/patterns.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-test',
    type: 'question',
    prompt: 'How do we decide?',
    scope: ['code'],
    authorPrincipal: 'ceo',
    participants: ['cto', 'code-author'],
    roundBudget: 3,
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface FakeAgentSpec {
  readonly principalId: string;
  /** Position fragment (answer, rationale) returned per respondTo call, by round. */
  readonly positions: ReadonlyArray<{ answer: string; rationale: string; derivedFrom?: readonly string[] }>;
  /** Counter fragment (targetId, objection) per counterOnce call, by round. null = no counter. */
  readonly counters?: ReadonlyArray<
    | null
    | { targetPositionId: string; objection: string; derivedFrom?: readonly string[] }
  >;
}

function buildFakeAgent(spec: FakeAgentSpec): AgentHandle {
  let respondCall = 0;
  let counterCall = 0;
  let state: 'running' | 'paused' | 'stopped' = 'running';
  return {
    id: spec.principalId,
    pause() { state = 'paused'; },
    resume() { state = 'running'; },
    stop() { state = 'stopped'; },
    status() { return state; },
    respondTo: vi.fn(async (q: Question): Promise<Position> => {
      const frag = spec.positions[respondCall++];
      if (!frag) {
        throw new Error(
          `fake agent ${spec.principalId}: respondTo over-called (${respondCall})`,
        );
      }
      return {
        id: `pos-${q.id}-${spec.principalId}`,
        type: 'position',
        inResponseTo: q.id,
        answer: frag.answer,
        rationale: frag.rationale,
        derivedFrom: frag.derivedFrom ?? [],
        authorPrincipal: spec.principalId,
        created_at: new Date().toISOString(),
      };
    }),
    counterOnce: vi.fn(async (): Promise<Counter | null> => {
      const frag = spec.counters?.[counterCall++];
      if (frag == null) return null;
      return {
        id: `ctr-${frag.targetPositionId}-${spec.principalId}`,
        type: 'counter',
        inResponseTo: frag.targetPositionId,
        objection: frag.objection,
        derivedFrom: frag.derivedFrom ?? [],
        authorPrincipal: spec.principalId,
        created_at: new Date().toISOString(),
      };
    }),
  };
}

/**
 * Capturing sink: records every shape sent through. Provides a
 * partitioning helper so tests can pick out Question / Position /
 * Counter / Decision / Escalation from the full stream.
 */
function capturingSink() {
  const seen: Array<Question | Position | Counter | Decision | Escalation> = [];
  return {
    seen,
    sink: vi.fn(async (atom: Question | Position | Counter | Decision | Escalation) => {
      seen.push(atom);
    }),
    byType<T extends { type: string }>(t: T['type']): T[] {
      return seen.filter((a) => a.type === t) as T[];
    },
  };
}

// ---------------------------------------------------------------------------
// Atom chain
// ---------------------------------------------------------------------------

describe('deliberate atom chain', () => {
  it('persists the Question atom once before soliciting positions', async () => {
    const { sink, seen } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r' }],
      }),
    };
    const q = makeQuestion({ participants: ['cto'] });
    await deliberate({
      question: q,
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    const questions = seen.filter((a) => a.type === 'question');
    expect(questions).toHaveLength(1);
    expect((questions[0] as Question).id).toBe('q-test');
    expect(() => validateQuestion(questions[0] as Question)).not.toThrow();
    // Question appears before any Position in the stream.
    expect(seen[0]!.type).toBe('question');
  });

  it('persists one Position per participant per round', async () => {
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r-cto' }],
      }),
      'code-author': buildFakeAgent({
        principalId: 'code-author',
        positions: [{ answer: 'B', rationale: 'r-ca' }],
      }),
    };
    await deliberate({
      question: makeQuestion({ roundBudget: 1 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    const positions = byType<Position>('position');
    expect(positions).toHaveLength(2);
    for (const p of positions) expect(() => validatePosition(p)).not.toThrow();
    const authors = positions.map((p) => p.authorPrincipal).sort();
    expect(authors).toEqual(['code-author', 'cto']);
  });

  it('persists Counter atoms when a participant emits one', async () => {
    // roundBudget >= 2: round 0 collects positions, round 1 collects
    // counters. code-author's counter targets cto's tagged position id
    // (pos-q-test-cto-r0).
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r' }],
        counters: [null],
      }),
      'code-author': buildFakeAgent({
        principalId: 'code-author',
        positions: [{ answer: 'B', rationale: 'r' }],
        // code-author counters cto's tagged position p-<qid>-cto-r0
        counters: [{ targetPositionId: 'pos-q-test-cto-r0', objection: 'breaks X' }],
      }),
    };
    await deliberate({
      question: makeQuestion({ roundBudget: 2 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    const counters = byType<Counter>('counter');
    expect(counters).toHaveLength(1);
    expect(() => validateCounter(counters[0]!)).not.toThrow();
    expect(counters[0]!.inResponseTo).toBe('pos-q-test-cto-r0');
    expect(counters[0]!.authorPrincipal).toBe('code-author');
  });
});

// ---------------------------------------------------------------------------
// Conclusion paths
// ---------------------------------------------------------------------------

describe('deliberate conclusion', () => {
  it('emits a Decision when the single unrebutted position is clear', async () => {
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r' }],
      }),
    };
    const outcome = await deliberate({
      question: makeQuestion({ participants: ['cto'] }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    expect(outcome.type).toBe('decision');
    expect(() => validateDecision(outcome as Decision)).not.toThrow();
    const decisions = byType<Decision>('decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.answer).toBe('A');
    expect(decisions[0]!.resolving).toBe('q-test');
  });

  it('calls shouldConclude after each round and stops early when agreement is reached', async () => {
    const { sink } = capturingSink();
    const cto = buildFakeAgent({
      principalId: 'cto',
      positions: [{ answer: 'A', rationale: 'r' }],
    });
    const agents: Record<string, AgentHandle> = { cto };
    await deliberate({
      question: makeQuestion({ participants: ['cto'], roundBudget: 5 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    // After the first round the single position is unrebutted -> stop.
    expect(cto.respondTo).toHaveBeenCalledTimes(1);
  });

  it('emits an Escalation when arbitration is indeterminate (top-tie)', async () => {
    // roundBudget >= 2 so counters can be collected after round 0
    // positions. Both positions get rebutted -> both candidates fall
    // back to the "all rebutted" branch -> source-rank ties at equal
    // depth -> decide returns null -> escalation.
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r' }],
        // Round-1 counter targets the r0-tagged position id.
        counters: [{ targetPositionId: 'pos-q-test-code-author-r0', objection: 'no' }],
      }),
      'code-author': buildFakeAgent({
        principalId: 'code-author',
        positions: [{ answer: 'B', rationale: 'r' }],
        counters: [{ targetPositionId: 'pos-q-test-cto-r0', objection: 'no' }],
      }),
    };
    const outcome = await deliberate({
      question: makeQuestion({ roundBudget: 2 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
      // Equal depth -> source-rank ties -> decide() returns null -> escalation
      principalDepths: { cto: 1, 'code-author': 1 },
    });
    expect(outcome.type).toBe('escalation');
    expect(() => validateEscalation(outcome as Escalation)).not.toThrow();
    const escalations = byType<Escalation>('escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.from).toBe('q-test');
    expect(escalations[0]!.reason).toContain('arbitration');
  });

  it('emits an Escalation with reason "timeout" when timeoutAt is in the past', async () => {
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r' }],
      }),
    };
    const outcome = await deliberate({
      question: makeQuestion({
        participants: ['cto'],
        timeoutAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    expect(outcome.type).toBe('escalation');
    expect((outcome as Escalation).reason).toMatch(/timeout/i);
    const positions = byType<Position>('position');
    expect(positions).toHaveLength(0); // No positions collected after timeout.
  });

  it('honours principalDepths when picking the Decision winner', async () => {
    const { sink } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'cto-answer', rationale: 'r' }],
      }),
      'code-author': buildFakeAgent({
        principalId: 'code-author',
        positions: [{ answer: 'ca-answer', rationale: 'r' }],
      }),
    };
    const outcome = await deliberate({
      question: makeQuestion({ roundBudget: 1 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
      principalDepths: { cto: 1, 'code-author': 3 }, // cto higher in hierarchy
    });
    expect(outcome.type).toBe('decision');
    expect((outcome as Decision).answer).toBe('cto-answer');
  });
});

// ---------------------------------------------------------------------------
// Sink ordering guarantees
// ---------------------------------------------------------------------------

describe('deliberate sink ordering', () => {
  it('emits Question first, Positions/Counters during rounds, Decision/Escalation last', async () => {
    const { sink, seen } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r' }],
      }),
    };
    await deliberate({
      question: makeQuestion({ participants: ['cto'] }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    expect(seen[0]!.type).toBe('question');
    expect(seen[seen.length - 1]!.type).toBe('decision');
  });
});

// ---------------------------------------------------------------------------
// Round-loop shape: positions once, counters per round
// ---------------------------------------------------------------------------

describe('deliberate round-loop shape', () => {
  it('collects Positions only in round 0, counters in subsequent rounds', async () => {
    // Two participants. With a roundBudget of 3, respondTo must be
    // called exactly once per participant (round 0). counterOnce is
    // called in each round (up to 3 times per participant) until
    // shouldConclude / roundBudget ends the loop.
    const { sink, byType } = capturingSink();
    const cto = buildFakeAgent({
      principalId: 'cto',
      positions: [{ answer: 'Same answer', rationale: 'r-cto' }],
      counters: [null, null, null],
    });
    const ca = buildFakeAgent({
      principalId: 'code-author',
      positions: [{ answer: 'Same answer', rationale: 'r-ca' }],
      counters: [null, null, null],
    });
    const agents: Record<string, AgentHandle> = { cto, 'code-author': ca };
    await deliberate({
      question: makeQuestion({ roundBudget: 3 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
    });
    // Positions are posted once, not per-round.
    expect(cto.respondTo).toHaveBeenCalledTimes(1);
    expect(ca.respondTo).toHaveBeenCalledTimes(1);
    const positions = byType<Position>('position');
    expect(positions).toHaveLength(2);
  });

  it('two participants with agreeing answers + roundBudget=3 produce a Decision, not an Escalation', async () => {
    // The exact shape that triggered the 2026-04-20 workaround. With
    // the old loop, each round re-polled positions, inflating the
    // position count to 4 and producing a source-rank tie -> escalation.
    // The fixed loop posts positions once and either shouldConclude
    // fires (unrebutted == 1) or source-rank picks a winner cleanly.
    //
    // Here both participants propose the same answer; no one counters.
    // Conclusion: a Decision atom is written and returned.
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'Bump patch', rationale: 'safe scope' }],
        counters: [null, null, null],
      }),
      'code-author': buildFakeAgent({
        principalId: 'code-author',
        positions: [{ answer: 'Bump patch', rationale: 'agree with CTO' }],
        counters: [null, null, null],
      }),
    };
    const outcome = await deliberate({
      question: makeQuestion({ roundBudget: 3 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
      principalDepths: { cto: 1, 'code-author': 3 },
    });
    expect(outcome.type).toBe('decision');
    expect(() => validateDecision(outcome as Decision)).not.toThrow();
    const decisions = byType<Decision>('decision');
    expect(decisions).toHaveLength(1);
    // Exactly 2 positions persisted total (not 2 x roundBudget).
    const positions = byType<Position>('position');
    expect(positions).toHaveLength(2);
    // No escalation emitted.
    const escalations = byType<Escalation>('escalation');
    expect(escalations).toHaveLength(0);
  });

  it('counters posted in later rounds feed arbitration (rebutting produces a clean Decision)', async () => {
    // Round 0: both post positions. Round 1: cto counters code-author.
    // shouldConclude fires at end of round 1 (unrebutted == 1) ->
    // Decision for CTO's surviving position.
    const { sink, byType } = capturingSink();
    const agents: Record<string, AgentHandle> = {
      cto: buildFakeAgent({
        principalId: 'cto',
        positions: [{ answer: 'A', rationale: 'r-cto' }],
        // Round 0 counter: can't target code-author's position because
        // cto's respondTo runs concurrently with code-author's in round
        // 0; safer to target in round 1.
        counters: [
          null,
          { targetPositionId: 'pos-q-test-code-author-r0', objection: 'rebut' },
          null,
        ],
      }),
      'code-author': buildFakeAgent({
        principalId: 'code-author',
        positions: [{ answer: 'B', rationale: 'r-ca' }],
        counters: [null, null, null],
      }),
    };
    const outcome = await deliberate({
      question: makeQuestion({ roundBudget: 3 }),
      participants: agents,
      sink,
      decidingPrincipal: 'cto',
      principalDepths: { cto: 1, 'code-author': 1 },
    });
    expect(outcome.type).toBe('decision');
    const positions = byType<Position>('position');
    expect(positions).toHaveLength(2);
    const counters = byType<Counter>('counter');
    // Exactly one counter (CTO's in round 1).
    expect(counters).toHaveLength(1);
    // CTO's position wins (code-author's was rebutted).
    expect((outcome as Decision).answer).toBe('A');
  });
});
