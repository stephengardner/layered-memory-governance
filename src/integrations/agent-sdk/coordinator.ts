/**
 * Deliberation coordinator.
 *
 * `deliberate` drives the deliberation pattern (Question -> Positions ->
 * optional Counters -> Decision | Escalation) across a set of
 * AgentHandles. The substrate arbitrator decides the winner; the
 * substrate escalation emitter produces the soft-tier human gate when
 * arbitration is indeterminate or the round loop times out.
 *
 * Boundary discipline:
 *   - The coordinator does NOT depend on a specific AtomStore. It
 *     accepts a `DeliberationSink` callback invoked once per emitted
 *     shape (Question, Position, Counter, Decision, Escalation). The
 *     boot script composes the sink to translate these patterns into
 *     proper core Atoms for persistence. This matches the pattern-layer
 *     discipline established in `src/substrate/deliberation/` (see the
 *     patterns.ts preamble).
 *   - The coordinator does NOT depend on a specific agent runtime. It
 *     calls only `respondTo` / `counterOnce` on the AgentHandle
 *     interface, so a non-SDK runtime (e.g. LangGraph) that implements
 *     the same handle drops in unchanged.
 *   - Round parallelism: Positions and Counters are gathered
 *     concurrently per-round via Promise.all so latency is one slow
 *     participant per round, not the sum.
 */

import { decide, shouldConclude } from '../../substrate/deliberation/arbitrator.js';
import { emitEscalation } from '../../substrate/deliberation/escalation.js';
import type {
  Counter,
  Decision,
  Escalation,
  Position,
  Question,
} from '../../substrate/deliberation/patterns.js';
import type { AgentHandle } from './agent-process.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DeliberationEvent =
  | Question
  | Position
  | Counter
  | Decision
  | Escalation;

/**
 * Called by the coordinator once per emitted deliberation shape. The
 * boot script wires this to an AtomStore adapter that synthesises a
 * core Atom (layer, provenance, principal_id, etc.) and calls
 * `atoms.put(atom)`. Kept as a callback so this module never imports
 * AtomStore directly; see the patterns.ts preamble for the rationale.
 */
export type DeliberationSink = (event: DeliberationEvent) => void | Promise<void>;

export interface DeliberateOptions {
  readonly question: Question;
  /**
   * Participant principalId -> AgentHandle. Each handle is invoked
   * per-round. Principals included here but not listed in
   * `question.participants` are still invoked; the source of truth for
   * who actually speaks is this map. The question.participants field
   * remains the authoritative record of the convener's intent.
   */
  readonly participants: Readonly<Record<string, AgentHandle>>;
  readonly sink: DeliberationSink;
  /** Principal authoring the Decision / Escalation atom. */
  readonly decidingPrincipal: string;
  /**
   * Depth of each participant principal from the root. Forwarded to
   * the arbitrator's source-rank tiebreak. Missing keys default to 0.
   */
  readonly principalDepths?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function deliberate(
  opts: DeliberateOptions,
): Promise<Decision | Escalation> {
  const { question, participants, sink, decidingPrincipal } = opts;
  const depthOptions = opts.principalDepths !== undefined
    ? { principalDepths: opts.principalDepths }
    : {};
  await sink(question);

  const positions: Position[] = [];
  const counters: Counter[] = [];

  const timeoutMs = Date.parse(question.timeoutAt);
  if (Number.isFinite(timeoutMs) && Date.now() > timeoutMs) {
    return emitAndReturnEscalation(
      sink,
      question,
      decidingPrincipal,
      'round-timeout (deadline passed before first round)',
      'operator review: no positions were collected before the deadline',
    );
  }

  // Round-loop shape:
  //   Round 0: collect one Position from each participant. Positions are
  //            posted once per deliberation, not per round. counterOnce
  //            is not invoked yet (participants haven't seen each other
  //            because respondTo runs concurrently).
  //   Round 1..roundBudget-1: collect Counter atoms only. Each round
  //            gives every participant a fresh chance to counter
  //            positions posted by others.
  //   After each round: shouldConclude(positions, counters). If true,
  //            break and invoke decide(). Otherwise continue until
  //            roundBudget is exhausted.
  //
  // Why this shape instead of re-polling positions per round:
  //   The original loop re-collected positions in every round, which
  //   with two agreeing agents and roundBudget=2 inflated the position
  //   count to 4 and produced an automatic source-rank tie (same layer
  //   / provenance / depth / confidence) -> escalation. Positions are
  //   a stated stance; a participant only posts once. Subsequent
  //   rounds are for objection + rebuttal, which is what Counter
  //   already models.
  for (let round = 0; round < question.roundBudget; round += 1) {
    if (Number.isFinite(timeoutMs) && Date.now() > timeoutMs) {
      return emitAndReturnEscalation(
        sink,
        question,
        decidingPrincipal,
        'round-timeout',
        'operator review of partial positions',
      );
    }

    if (round === 0) {
      // First round: collect one Position per participant.
      const gatheredPositions = await Promise.all(
        Object.values(participants).map(async (handle) => {
          const p = await handle.respondTo(question);
          const tagged: Position = { ...p, id: `${p.id}-r0` };
          await sink(tagged);
          return tagged;
        }),
      );
      positions.push(...gatheredPositions);
    } else {
      // Subsequent rounds: counters only. Each participant gets a
      // fresh chance to object to any Position posted so far.
      const gatheredCounters = await Promise.all(
        Object.values(participants).map(async (handle) => {
          const c = await handle.counterOnce(positions);
          if (c === null) return null;
          const tagged: Counter = { ...c, id: `${c.id}-r${round}` };
          await sink(tagged);
          return tagged;
        }),
      );
      for (const c of gatheredCounters) {
        if (c !== null) counters.push(c);
      }
    }

    if (shouldConclude(positions, counters)) break;
  }

  const decision = decide(
    question.id,
    positions,
    counters,
    decidingPrincipal,
    depthOptions,
  );
  if (decision !== null) {
    await sink(decision);
    return decision;
  }
  return emitAndReturnEscalation(
    sink,
    question,
    decidingPrincipal,
    'arbitration-indeterminate',
    'operator decides or tightens canon before reopening the question',
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function emitAndReturnEscalation(
  sink: DeliberationSink,
  question: Question,
  authorPrincipal: string,
  reason: string,
  suggestedNext: string,
): Promise<Escalation> {
  const esc = emitEscalation({
    questionId: question.id,
    reason,
    suggestedNext,
    authorPrincipal,
  });
  await sink(esc);
  return esc;
}
