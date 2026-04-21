/**
 * Question primitive (Phase 50b).
 *
 * A question is an atom with `type: 'question'` and a
 * `question_state` lifecycle (pending -> answered | expired |
 * abandoned). Asker creates one when seeking HIL input; the answer
 * binds back via `provenance.derived_from = [questionId]` so the
 * audit trail reconstructs which answer addressed which question
 * even under network delay.
 *
 * Parallels the Plan primitive: same "atom with mutable state
 * field" shape. Two primitives share the governance substrate.
 *
 * Complements the Notifier handle pattern: Notifier gives Q-A
 * binding for structured escalations (diff + default disposition);
 * question atoms give Q-A binding for free-form chat exchanges
 * that lack a Notifier envelope.
 */

import type { Host } from '../substrate/interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  QuestionState,
  Scope,
  Time,
} from '../substrate/types.js';

const ALLOWED: Readonly<Record<QuestionState, ReadonlyArray<QuestionState>>> = Object.freeze({
  pending: ['answered', 'expired', 'abandoned'],
  answered: [],
  expired: [],
  abandoned: [],
});

export class InvalidQuestionTransitionError extends Error {
  constructor(
    public readonly from: QuestionState | undefined,
    public readonly to: QuestionState,
    public readonly atomId: AtomId,
  ) {
    super(
      from === undefined
        ? `Cannot transition non-question atom ${String(atomId)} to ${to}`
        : `Invalid question transition for ${String(atomId)}: ${from} -> ${to}. Allowed from ${from}: ${ALLOWED[from].join(', ') || '(terminal)'}`,
    );
    this.name = 'InvalidQuestionTransitionError';
  }
}

export function canTransitionQuestion(
  from: QuestionState | undefined,
  to: QuestionState,
): boolean {
  if (from === undefined) return false;
  return ALLOWED[from].includes(to);
}

export interface AskQuestionOptions {
  readonly content: string;
  readonly asker: PrincipalId;
  readonly scope?: Scope;
  /** Deadline after which the question auto-expires. */
  readonly expiresAt?: Time;
  /**
   * Optional atoms this question is about (e.g., a plan awaiting
   * approval, an atom requiring validation). Stored in derived_from
   * so lineage walks both directions.
   */
  readonly relatedAtoms?: ReadonlyArray<AtomId>;
  /**
   * Optional metadata (expected_response_type, asked_via channel,
   * tg_message_id, etc). Merged into atom.metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Create a pending question atom. The caller is responsible for
 * actually DELIVERING the question to the human (via Notifier,
 * Telegram, terminal print, whatever); this primitive only records
 * the intent and tracks state.
 */
export async function askQuestion(
  host: Host,
  options: AskQuestionOptions,
): Promise<Atom> {
  const now = host.clock.now() as Time;
  const contentHash = host.atoms.contentHash(options.content).slice(0, 16);
  const id = `q-${contentHash}-${now.replace(/[:.]/g, '-')}` as AtomId;
  const atom: Atom = {
    schema_version: 1,
    id,
    content: options.content,
    type: 'question',
    layer: 'L1',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: options.asker },
      derived_from: options.relatedAtoms ?? [],
    },
    confidence: 0.5,
    created_at: now,
    last_reinforced_at: now,
    expires_at: options.expiresAt ?? null,
    supersedes: [],
    superseded_by: [],
    scope: options.scope ?? 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: options.asker,
    taint: 'clean',
    metadata: options.metadata ?? {},
    question_state: 'pending',
  };
  await host.atoms.put(atom);
  await host.auditor.log({
    kind: 'question.asked',
    principal_id: options.asker,
    timestamp: now,
    refs: { atom_ids: [id, ...(options.relatedAtoms ?? [])] },
    details: {
      content_preview: options.content.slice(0, 200),
      expires_at: options.expiresAt ?? null,
    },
  });
  return atom;
}

export interface BindAnswerOptions {
  readonly questionId: AtomId;
  readonly answerContent: string;
  readonly answerer: PrincipalId;
  /** Inherit scope + other fields from this source (optional). */
  readonly scope?: Scope;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface BindAnswerResult {
  readonly questionId: AtomId;
  readonly answerId: AtomId;
}

/**
 * Record the answer to a pending question. Transitions the question
 * to 'answered', writes a new observation atom with
 * `provenance.derived_from = [questionId]`, and audit-logs the bind.
 * Throws if the question is not in 'pending' state.
 */
export async function bindAnswer(
  host: Host,
  options: BindAnswerOptions,
): Promise<BindAnswerResult> {
  const question = await host.atoms.get(options.questionId);
  if (!question) {
    throw new Error(`bindAnswer: question ${String(options.questionId)} not found`);
  }
  if (question.type !== 'question') {
    throw new InvalidQuestionTransitionError(undefined, 'answered', options.questionId);
  }
  if (!canTransitionQuestion(question.question_state, 'answered')) {
    throw new InvalidQuestionTransitionError(
      question.question_state,
      'answered',
      options.questionId,
    );
  }

  const now = host.clock.now() as Time;
  const contentHash = host.atoms.contentHash(options.answerContent).slice(0, 16);
  const answerId = `a-${String(options.questionId).slice(0, 12)}-${contentHash}` as AtomId;

  const answer: Atom = {
    schema_version: 1,
    id: answerId,
    content: options.answerContent,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: options.answerer },
      derived_from: [options.questionId],
    },
    confidence: 0.95,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: options.scope ?? question.scope,
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'verified',
      last_validated_at: now,
    },
    principal_id: options.answerer,
    taint: 'clean',
    metadata: {
      answers_question: options.questionId,
      ...(options.metadata ?? {}),
    },
  };

  await host.atoms.put(answer);
  await host.atoms.update(options.questionId, { question_state: 'answered' });

  await host.auditor.log({
    kind: 'question.answered',
    principal_id: options.answerer,
    timestamp: now,
    refs: { atom_ids: [options.questionId, answerId] },
    details: {
      question_content_preview: question.content.slice(0, 200),
      answer_content_preview: options.answerContent.slice(0, 200),
    },
  });

  return { questionId: options.questionId, answerId };
}

/**
 * Query all pending questions (optionally narrowed by asker).
 */
export async function listPendingQuestions(
  host: Host,
  options: { principalId?: PrincipalId; limit?: number } = {},
): Promise<ReadonlyArray<Atom>> {
  const filter = {
    type: ['question'] as const,
    question_state: ['pending'] as const,
    ...(options.principalId
      ? { principal_id: [options.principalId] as const }
      : {}),
  };
  const page = await host.atoms.query(filter, options.limit ?? 100);
  return page.atoms;
}

/**
 * Scan pending questions and expire any past their deadline. Returns
 * how many got expired. Safe to call from a LoopRunner tick.
 */
export async function expirePastDueQuestions(
  host: Host,
  principalId: PrincipalId,
): Promise<number> {
  const now = host.clock.now() as Time;
  const nowMs = Date.parse(now);
  const pending = await listPendingQuestions(host, { limit: 500 });
  let expired = 0;
  for (const q of pending) {
    if (!q.expires_at) continue;
    const deadlineMs = Date.parse(q.expires_at);
    if (Number.isFinite(deadlineMs) && deadlineMs <= nowMs) {
      await host.atoms.update(q.id, { question_state: 'expired' });
      await host.auditor.log({
        kind: 'question.expired',
        principal_id: principalId,
        timestamp: now,
        refs: { atom_ids: [q.id] },
        details: { expires_at: q.expires_at },
      });
      expired += 1;
    }
  }
  return expired;
}
