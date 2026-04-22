/**
 * Deliberation atom-shape validators.
 *
 * Patterns are lightweight, deliberation-specific atom-like structures
 * carried by the coordinator (Question, Position, Counter, Decision,
 * Escalation). They are NOT the core Atom; they are the transport
 * shapes the coordinator persists and routes between participants.
 * These tests pin down the required-field rules before implementation.
 */
import { describe, expect, it } from 'vitest';

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
// Question
// ---------------------------------------------------------------------------

describe('validateQuestion', () => {
  const valid: Question = {
    id: 'q1',
    type: 'question',
    prompt: 'how to fix X?',
    scope: ['code'],
    authorPrincipal: 'cto',
    participants: ['cto', 'code-author'],
    roundBudget: 3,
    timeoutAt: '2026-04-23T00:00:00.000Z',
    created_at: '2026-04-22T00:00:00.000Z',
  };

  it('accepts a valid Question', () => {
    expect(() => validateQuestion(valid)).not.toThrow();
  });

  it('rejects missing id', () => {
    expect(() => validateQuestion({ ...valid, id: '' })).toThrow(/id/);
  });

  it('rejects wrong type discriminator', () => {
    expect(() =>
      validateQuestion({ ...valid, type: 'position' as unknown as 'question' }),
    ).toThrow(/type/);
  });

  it('rejects missing prompt', () => {
    expect(() => validateQuestion({ ...valid, prompt: '' })).toThrow(/prompt/);
  });

  it('rejects missing authorPrincipal', () => {
    expect(() => validateQuestion({ ...valid, authorPrincipal: '' })).toThrow(
      /authorPrincipal/,
    );
  });

  it('rejects empty participants array', () => {
    expect(() => validateQuestion({ ...valid, participants: [] })).toThrow(
      /participants/,
    );
  });

  it('rejects non-array participants', () => {
    expect(() =>
      validateQuestion({
        ...valid,
        participants: 'cto' as unknown as readonly string[],
      }),
    ).toThrow(/participants/);
  });

  it('rejects roundBudget < 1', () => {
    expect(() => validateQuestion({ ...valid, roundBudget: 0 })).toThrow(
      /roundBudget/,
    );
  });

  it('rejects missing timeoutAt', () => {
    expect(() => validateQuestion({ ...valid, timeoutAt: '' })).toThrow(
      /timeoutAt/,
    );
  });
});

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

describe('validatePosition', () => {
  const valid: Position = {
    id: 'p1',
    type: 'position',
    inResponseTo: 'q1',
    answer: 'use arg-array',
    rationale: 'no platform branch needed',
    derivedFrom: ['dev-no-hacky-workarounds'],
    authorPrincipal: 'cto',
    created_at: '2026-04-22T00:00:00.000Z',
  };

  it('accepts a valid Position', () => {
    expect(() => validatePosition(valid)).not.toThrow();
  });

  it('rejects missing inResponseTo', () => {
    expect(() => validatePosition({ ...valid, inResponseTo: '' })).toThrow(
      /inResponseTo/,
    );
  });

  it('rejects missing answer', () => {
    expect(() => validatePosition({ ...valid, answer: '' })).toThrow(/answer/);
  });

  it('rejects missing rationale', () => {
    expect(() => validatePosition({ ...valid, rationale: '' })).toThrow(
      /rationale/,
    );
  });

  it('rejects wrong type discriminator', () => {
    expect(() =>
      validatePosition({ ...valid, type: 'counter' as unknown as 'position' }),
    ).toThrow(/type/);
  });

  it('rejects missing authorPrincipal', () => {
    expect(() =>
      validatePosition({ ...valid, authorPrincipal: '' }),
    ).toThrow(/authorPrincipal/);
  });
});

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

describe('validateCounter', () => {
  const valid: Counter = {
    id: 'c1',
    type: 'counter',
    inResponseTo: 'p1',
    objection: 'breaks invariant X',
    derivedFrom: [],
    authorPrincipal: 'code-author',
    created_at: '2026-04-22T00:00:00.000Z',
  };

  it('accepts a valid Counter', () => {
    expect(() => validateCounter(valid)).not.toThrow();
  });

  it('rejects missing inResponseTo', () => {
    expect(() => validateCounter({ ...valid, inResponseTo: '' })).toThrow(
      /inResponseTo/,
    );
  });

  it('rejects missing objection', () => {
    expect(() => validateCounter({ ...valid, objection: '' })).toThrow(
      /objection/,
    );
  });

  it('rejects wrong type discriminator', () => {
    expect(() =>
      validateCounter({ ...valid, type: 'position' as unknown as 'counter' }),
    ).toThrow(/type/);
  });
});

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

describe('validateDecision', () => {
  const valid: Decision = {
    id: 'dec-q1',
    type: 'decision',
    resolving: 'q1',
    answer: 'use arg-array',
    arbitrationTrace: 'winner=p1 via source-rank',
    authorPrincipal: 'cto',
    created_at: '2026-04-22T00:00:00.000Z',
  };

  it('accepts a valid Decision', () => {
    expect(() => validateDecision(valid)).not.toThrow();
  });

  it('rejects missing resolving', () => {
    expect(() => validateDecision({ ...valid, resolving: '' })).toThrow(
      /resolving/,
    );
  });

  it('rejects missing answer', () => {
    expect(() => validateDecision({ ...valid, answer: '' })).toThrow(/answer/);
  });

  it('rejects missing arbitrationTrace', () => {
    expect(() =>
      validateDecision({ ...valid, arbitrationTrace: '' }),
    ).toThrow(/arbitrationTrace/);
  });

  it('rejects wrong type discriminator', () => {
    expect(() =>
      validateDecision({
        ...valid,
        type: 'question' as unknown as 'decision',
      }),
    ).toThrow(/type/);
  });
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

describe('validateEscalation', () => {
  const valid: Escalation = {
    id: 'esc-q1-1',
    type: 'escalation',
    from: 'q1',
    reason: 'arbitration-indeterminate',
    requiresHumanBy: '2026-04-23T00:00:00.000Z',
    suggestedNext: 'operator decides or tightens canon',
    authorPrincipal: 'cto',
    created_at: '2026-04-22T00:00:00.000Z',
  };

  it('accepts a valid Escalation', () => {
    expect(() => validateEscalation(valid)).not.toThrow();
  });

  it('rejects missing from', () => {
    expect(() => validateEscalation({ ...valid, from: '' })).toThrow(/from/);
  });

  it('rejects missing reason', () => {
    expect(() => validateEscalation({ ...valid, reason: '' })).toThrow(
      /reason/,
    );
  });

  it('rejects missing suggestedNext', () => {
    expect(() => validateEscalation({ ...valid, suggestedNext: '' })).toThrow(
      /suggestedNext/,
    );
  });

  it('rejects wrong type discriminator', () => {
    expect(() =>
      validateEscalation({
        ...valid,
        type: 'decision' as unknown as 'escalation',
      }),
    ).toThrow(/type/);
  });
});
