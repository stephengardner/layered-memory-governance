/**
 * The Actor interface.
 *
 * An Actor is a named mechanism with a five-phase lifecycle
 * (observe -> classify -> propose -> apply -> reflect). Actors
 * do not drive themselves; the runActor driver in run-actor.ts does.
 *
 * Actors compose with:
 *   - a Host (governance primitives: atoms, canon, llm, notifier, etc.)
 *   - a Principal (authority the actor runs under)
 *   - declared ActorAdapters (external-system effects)
 *
 * Type parameters:
 *   Obs      - what observe() produces (e.g., list of review comments)
 *   Action   - the payload shape for ProposedAction
 *   Outcome  - what apply() returns for one action
 *   Adapters - the adapter record this actor requires
 */

import type { Host } from '../../interface.js';
import type { Principal } from '../../types.js';
import type {
  ActorAdapters,
  ActorBudget,
  ActorAuditEvent,
  Classified,
  ProposedAction,
  Reflection,
} from './types.js';

export interface ActorContext<Adapters extends ActorAdapters = ActorAdapters> {
  readonly host: Host;
  readonly principal: Principal;
  readonly adapters: Adapters;
  readonly budget: ActorBudget;
  readonly iteration: number;
  /** Cooperative halt predicate. runActor calls it at the top of every iteration. */
  readonly killSwitch: () => boolean;
  /**
   * Runtime-revocation signal plumbed through every actor call.
   *
   * Complements the `killSwitch` predicate above: `killSwitch` fires
   * at iteration / action boundaries (soft); `abortSignal` fires the
   * moment a trip condition is met and is expected to be subscribed
   * by every long-running async call the actor or its adapters make
   * (fetch, spawn, execa, LLM stream). When the signal aborts,
   * adapters throw AbortError and the actor's current operation
   * unwinds within milliseconds rather than waiting for the next
   * loop-level check.
   *
   * ALWAYS present. When `RunActorOptions.killSwitchSignal` is not
   * supplied, runActor injects a never-aborted signal so adapters
   * can thread `ctx.abortSignal` unconditionally without null-
   * checking. Back-compat with actors that never read this field:
   * additive only, zero behavior change when ignored.
   */
  readonly abortSignal: AbortSignal;
  /** Structured audit sink. Actors may also call this directly. */
  readonly audit: (event: Omit<ActorAuditEvent, 'at' | 'actor' | 'principal' | 'iteration'>) => Promise<void>;
}

export interface Actor<
  Obs = unknown,
  Action = unknown,
  Outcome = unknown,
  Adapters extends ActorAdapters = ActorAdapters,
> {
  readonly name: string;
  readonly version: string;

  /**
   * Gather external-world state into Obs. No side effects except read-only
   * adapter calls. If observe returns empty, reflect still runs with the
   * empty observation so the actor can decide to halt.
   */
  observe(ctx: ActorContext<Adapters>): Promise<Obs>;

  /**
   * Categorize the observation. The Classified.key is used for
   * convergence detection (same key two iterations in a row with
   * progress=false halts the loop).
   */
  classify(obs: Obs, ctx: ActorContext<Adapters>): Promise<Classified<Obs>>;

  /**
   * Propose zero or more actions. Each carries a `tool` identifier that
   * policy can match against. runActor gates each proposal through
   * checkToolPolicy before letting apply run.
   */
  propose(
    classified: Classified<Obs>,
    ctx: ActorContext<Adapters>,
  ): Promise<ReadonlyArray<ProposedAction<Action>>>;

  /**
   * Execute an allowed action. runActor calls this only for actions
   * where the policy decision is 'allow'. Deny and escalate short-circuit.
   */
  apply(
    action: ProposedAction<Action>,
    ctx: ActorContext<Adapters>,
  ): Promise<Outcome>;

  /**
   * Inspect the iteration's outcomes and decide whether to continue.
   * Return done:true to halt with 'converged'. Return progress:false
   * to mark the iteration as non-progressing (for convergence detection).
   */
  reflect(
    outcomes: ReadonlyArray<Outcome>,
    classified: Classified<Obs>,
    ctx: ActorContext<Adapters>,
  ): Promise<Reflection>;
}
