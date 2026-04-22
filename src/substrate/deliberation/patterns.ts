/**
 * Deliberation atom patterns.
 *
 * Transport shapes used by the deliberation coordinator to route
 * structured dialogue between participants:
 *
 *   Question    -> posed by the convening principal (scope, participants,
 *                  round budget, timeout).
 *   Position    -> posted by a participant in response to a Question.
 *   Counter     -> posted by a participant objecting to another's Position.
 *   Decision    -> emitted when arbitration produces a winner.
 *   Escalation  -> emitted when arbitration is indeterminate or the
 *                  deliberation times out; the soft-tier human gate.
 *
 * These patterns are intentionally independent from the core `Atom`
 * type. The coordinator layer persists them as-is; downstream consumers
 * who want full Atom semantics wrap them via their AtomStore adapter.
 * Keeping the pattern layer lean means a future `integrations/langgraph/`
 * (or any non-Agent-SDK runtime) can drive the same pattern shape.
 *
 * Validators throw descriptive Errors so a coordinator can surface the
 * failing field to the operator without parsing a code or message id.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Question {
  readonly id: string;
  readonly type: 'question';
  readonly prompt: string;
  readonly scope: readonly string[];
  readonly authorPrincipal: string;
  readonly participants: readonly string[];
  readonly roundBudget: number;
  /** ISO-8601 timestamp after which the deliberation times out. */
  readonly timeoutAt: string;
  readonly created_at: string;
}

export interface Position {
  readonly id: string;
  readonly type: 'position';
  /** Question id. */
  readonly inResponseTo: string;
  readonly answer: string;
  readonly rationale: string;
  /** Atom ids cited as justification. */
  readonly derivedFrom: readonly string[];
  readonly authorPrincipal: string;
  readonly created_at: string;
}

export interface Counter {
  readonly id: string;
  readonly type: 'counter';
  /** Position id being objected to. */
  readonly inResponseTo: string;
  readonly objection: string;
  readonly derivedFrom: readonly string[];
  readonly authorPrincipal: string;
  readonly created_at: string;
}

export interface Decision {
  readonly id: string;
  readonly type: 'decision';
  /** Question id being resolved. */
  readonly resolving: string;
  readonly answer: string;
  /** Human-readable trace of the arbitration path that produced this decision. */
  readonly arbitrationTrace: string;
  readonly authorPrincipal: string;
  readonly created_at: string;
}

export interface Escalation {
  readonly id: string;
  readonly type: 'escalation';
  /** Question id the escalation originates from. */
  readonly from: string;
  readonly reason: string;
  /** ISO-8601 deadline for human response. */
  readonly requiresHumanBy: string;
  readonly suggestedNext: string;
  readonly authorPrincipal: string;
  readonly created_at: string;
}

export type DeliberationAtom =
  | Question
  | Position
  | Counter
  | Decision
  | Escalation;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function requireNonEmptyString(
  value: unknown,
  label: string,
  context: string,
): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context}: ${label} required`);
  }
}

export function validateQuestion(q: Question): void {
  requireNonEmptyString(q.id, 'id', 'Question');
  if (q.type !== 'question') {
    throw new Error('Question: type must be "question"');
  }
  requireNonEmptyString(q.prompt, 'prompt', 'Question');
  requireNonEmptyString(q.authorPrincipal, 'authorPrincipal', 'Question');
  if (!Array.isArray(q.participants) || q.participants.length === 0) {
    throw new Error('Question: participants must be a non-empty array');
  }
  if (typeof q.roundBudget !== 'number' || q.roundBudget < 1) {
    throw new Error('Question: roundBudget must be >= 1');
  }
  requireNonEmptyString(q.timeoutAt, 'timeoutAt', 'Question');
  requireNonEmptyString(q.created_at, 'created_at', 'Question');
}

export function validatePosition(p: Position): void {
  requireNonEmptyString(p.id, 'id', 'Position');
  if (p.type !== 'position') {
    throw new Error('Position: type must be "position"');
  }
  requireNonEmptyString(p.inResponseTo, 'inResponseTo', 'Position');
  requireNonEmptyString(p.answer, 'answer', 'Position');
  requireNonEmptyString(p.rationale, 'rationale', 'Position');
  requireNonEmptyString(p.authorPrincipal, 'authorPrincipal', 'Position');
  requireNonEmptyString(p.created_at, 'created_at', 'Position');
  if (!Array.isArray(p.derivedFrom)) {
    throw new Error('Position: derivedFrom must be an array');
  }
}

export function validateCounter(c: Counter): void {
  requireNonEmptyString(c.id, 'id', 'Counter');
  if (c.type !== 'counter') {
    throw new Error('Counter: type must be "counter"');
  }
  requireNonEmptyString(c.inResponseTo, 'inResponseTo', 'Counter');
  requireNonEmptyString(c.objection, 'objection', 'Counter');
  requireNonEmptyString(c.authorPrincipal, 'authorPrincipal', 'Counter');
  requireNonEmptyString(c.created_at, 'created_at', 'Counter');
  if (!Array.isArray(c.derivedFrom)) {
    throw new Error('Counter: derivedFrom must be an array');
  }
}

export function validateDecision(d: Decision): void {
  requireNonEmptyString(d.id, 'id', 'Decision');
  if (d.type !== 'decision') {
    throw new Error('Decision: type must be "decision"');
  }
  requireNonEmptyString(d.resolving, 'resolving', 'Decision');
  requireNonEmptyString(d.answer, 'answer', 'Decision');
  requireNonEmptyString(d.arbitrationTrace, 'arbitrationTrace', 'Decision');
  requireNonEmptyString(d.authorPrincipal, 'authorPrincipal', 'Decision');
  requireNonEmptyString(d.created_at, 'created_at', 'Decision');
}

export function validateEscalation(e: Escalation): void {
  requireNonEmptyString(e.id, 'id', 'Escalation');
  if (e.type !== 'escalation') {
    throw new Error('Escalation: type must be "escalation"');
  }
  requireNonEmptyString(e.from, 'from', 'Escalation');
  requireNonEmptyString(e.reason, 'reason', 'Escalation');
  requireNonEmptyString(e.requiresHumanBy, 'requiresHumanBy', 'Escalation');
  requireNonEmptyString(e.suggestedNext, 'suggestedNext', 'Escalation');
  requireNonEmptyString(e.authorPrincipal, 'authorPrincipal', 'Escalation');
  requireNonEmptyString(e.created_at, 'created_at', 'Escalation');
}
