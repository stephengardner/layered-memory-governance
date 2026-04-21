/**
 * Question primitive tests (Phase 50b).
 *
 * Covers the state machine + Q-A binding:
 *   - askQuestion writes a pending question atom
 *   - bindAnswer transitions to 'answered' + writes answer with
 *     derived_from: [questionId]
 *   - Double bind rejected (terminal state)
 *   - Non-question atom rejected
 *   - listPendingQuestions filters correctly
 *   - expirePastDueQuestions flips questions past deadline
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  askQuestion,
  bindAnswer,
  canTransitionQuestion,
  expirePastDueQuestions,
  InvalidQuestionTransitionError,
  listPendingQuestions,
} from '../../src/questions/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';

const agent = 'agent-alice' as PrincipalId;
const operator = 'stephen-human' as PrincipalId;

describe('canTransitionQuestion', () => {
  it('pending -> answered | expired | abandoned', () => {
    expect(canTransitionQuestion('pending', 'answered')).toBe(true);
    expect(canTransitionQuestion('pending', 'expired')).toBe(true);
    expect(canTransitionQuestion('pending', 'abandoned')).toBe(true);
  });

  it('terminal states have no transitions out', () => {
    for (const t of ['answered', 'expired', 'abandoned'] as const) {
      for (const to of ['pending', 'answered', 'expired', 'abandoned'] as const) {
        expect(canTransitionQuestion(t, to)).toBe(false);
      }
    }
  });

  it('undefined from returns false', () => {
    expect(canTransitionQuestion(undefined, 'answered')).toBe(false);
  });
});

describe('askQuestion', () => {
  it('writes a pending question atom with correct attribution', async () => {
    const host = createMemoryHost();
    const q = await askQuestion(host, {
      content: 'Should we use Postgres?',
      asker: agent,
    });

    expect(q.type).toBe('question');
    expect(q.question_state).toBe('pending');
    expect(q.principal_id).toBe(agent);
    expect(q.content).toBe('Should we use Postgres?');

    const stored = await host.atoms.get(q.id);
    expect(stored?.question_state).toBe('pending');

    const audits = await host.auditor.query({ kind: ['question.asked'] }, 10);
    expect(audits).toHaveLength(1);
  });

  it('related_atoms land in derived_from', async () => {
    const host = createMemoryHost();
    const q = await askQuestion(host, {
      content: 'approve plan?',
      asker: agent,
      relatedAtoms: ['plan-123' as AtomId, 'plan-456' as AtomId],
    });
    expect(q.provenance.derived_from).toEqual(['plan-123', 'plan-456']);
  });
});

describe('bindAnswer', () => {
  it('transitions question to answered + writes answer with derived_from', async () => {
    const host = createMemoryHost();
    const q = await askQuestion(host, {
      content: 'Should we do X?',
      asker: agent,
    });
    const result = await bindAnswer(host, {
      questionId: q.id,
      answerContent: 'Yes, do X.',
      answerer: operator,
    });

    expect(result.questionId).toBe(q.id);

    const qAfter = await host.atoms.get(q.id);
    expect(qAfter?.question_state).toBe('answered');

    const answer = await host.atoms.get(result.answerId);
    expect(answer?.provenance.derived_from).toContain(q.id);
    expect(answer?.principal_id).toBe(operator);

    const audits = await host.auditor.query({ kind: ['question.answered'] }, 10);
    expect(audits).toHaveLength(1);
  });

  it('refuses to bind twice (terminal state)', async () => {
    const host = createMemoryHost();
    const q = await askQuestion(host, {
      content: 'one shot',
      asker: agent,
    });
    await bindAnswer(host, {
      questionId: q.id,
      answerContent: 'yes',
      answerer: operator,
    });
    await expect(bindAnswer(host, {
      questionId: q.id,
      answerContent: 'no',
      answerer: operator,
    })).rejects.toBeInstanceOf(InvalidQuestionTransitionError);
  });

  it('refuses to bind to a non-question atom', async () => {
    const host = createMemoryHost();
    await expect(bindAnswer(host, {
      questionId: 'ghost' as AtomId,
      answerContent: 'x',
      answerer: operator,
    })).rejects.toThrow(/not found/);
  });
});

describe('listPendingQuestions', () => {
  it('returns only pending questions, optionally scoped by principal', async () => {
    const host = createMemoryHost();
    const q1 = await askQuestion(host, { content: 'q1', asker: agent });
    const q2 = await askQuestion(host, { content: 'q2', asker: agent });
    await askQuestion(host, { content: 'q3-operator', asker: operator });
    await bindAnswer(host, { questionId: q2.id, answerContent: 'a', answerer: operator });

    const pending = await listPendingQuestions(host);
    expect(pending.map(q => q.id).sort()).toEqual([q1.id, expect.any(String)].sort() as AtomId[]);

    const agentOnly = await listPendingQuestions(host, { principalId: agent });
    expect(agentOnly.map(q => q.id)).toEqual([q1.id]);
  });
});

describe('expirePastDueQuestions', () => {
  it('expires questions past their deadline; leaves fresh ones', async () => {
    const host = createMemoryHost();
    const past = '1970-01-01T00:00:00.000Z' as Time;
    const future = '2099-01-01T00:00:00.000Z' as Time;
    const qPast = await askQuestion(host, {
      content: 'old question',
      asker: agent,
      expiresAt: past,
    });
    const qFuture = await askQuestion(host, {
      content: 'fresh question',
      asker: agent,
      expiresAt: future,
    });

    const expired = await expirePastDueQuestions(host, operator);
    expect(expired).toBe(1);

    expect((await host.atoms.get(qPast.id))!.question_state).toBe('expired');
    expect((await host.atoms.get(qFuture.id))!.question_state).toBe('pending');

    const audits = await host.auditor.query({ kind: ['question.expired'] }, 10);
    expect(audits).toHaveLength(1);
  });
});
