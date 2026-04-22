/**
 * Shared types for the Actor primitive (Phase 53a).
 *
 * Actors are governed autonomous loops. See design/actors-and-adapters.md
 * for the shape rationale and D16/D17 for the architectural context.
 */

import type { PrincipalId, Time } from '../../types.js';

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * An actor-scoped external-system adapter. Per D17, these live OUTSIDE the
 * Host boundary: Host is for governance, ActorAdapter is for external
 * effects. Concrete adapters are responsible for their own lifecycle;
 * `dispose` is called by the caller when they're done with the adapter.
 */
export interface ActorAdapter {
  readonly name: string;
  readonly version: string;
  dispose?(): Promise<void>;
}

/**
 * A record of adapters keyed by a caller-chosen string. Actors declare
 * the shape of adapters they require; the caller supplies matching
 * instances at runActor time.
 */
export type ActorAdapters = Readonly<Record<string, ActorAdapter>>;

// ---------------------------------------------------------------------------
// Budget + halt reasons
// ---------------------------------------------------------------------------

export interface ActorBudget {
  /** Hard cap on iterations. Required; prevents runaway loops. */
  readonly maxIterations: number;
  /**
   * Optional deadline (ISO-8601). If set, runActor halts the first
   * iteration whose start is at or after this time.
   */
  readonly deadline?: Time;
  /**
   * Optional token budget. Actors that use an LLM should track their
   * own token usage and compare to this; runActor does not enforce it.
   */
  readonly maxTokens?: number;
}

export type ActorHaltReason =
  | 'kill-switch'
  | 'budget-iterations'
  | 'budget-deadline'
  | 'convergence-loop'
  | 'converged'
  | 'error'
  | 'policy-escalate-blocking';

// ---------------------------------------------------------------------------
// Proposed actions
// ---------------------------------------------------------------------------

/**
 * A proposal produced by Actor.propose. Each proposal must carry a `tool`
 * identifier so the policy layer can match against it (same key used by
 * checkToolPolicy). Arbitrary payload otherwise.
 */
export interface ProposedAction<Payload = unknown> {
  readonly tool: string;
  readonly payload: Payload;
  /** Human-readable description, used in audit + escalations. */
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Classification + reflection
// ---------------------------------------------------------------------------

/**
 * The result of Actor.classify. The `key` is used for convergence
 * detection: if the same key is returned on two consecutive iterations
 * without progress, runActor halts with convergence-loop.
 */
export interface Classified<Obs> {
  readonly observation: Obs;
  readonly key: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The result of Actor.reflect. `done: true` signals runActor to halt
 * with status 'converged'. `progress: false` marks this iteration as
 * non-progressing for convergence detection (same classification key
 * twice with `progress: false` triggers convergence-loop halt).
 */
export interface Reflection {
  readonly done: boolean;
  readonly progress: boolean;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Audit events emitted by the driver
// ---------------------------------------------------------------------------

export type ActorAuditEventKind =
  | 'iteration-start'
  | 'observation'
  | 'classification'
  | 'proposal'
  | 'policy-decision'
  | 'apply-outcome'
  | 'reflection'
  | 'halt';

export interface ActorAuditEvent {
  readonly kind: ActorAuditEventKind;
  readonly iteration: number;
  readonly at: Time;
  readonly principal: PrincipalId;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ActorReport {
  readonly actor: string;
  readonly principal: PrincipalId;
  readonly haltReason: ActorHaltReason;
  readonly iterations: number;
  readonly startedAt: Time;
  readonly endedAt: Time;
  readonly escalations: ReadonlyArray<string>;
  readonly lastNote?: string;
}
