/**
 * The runActor driver (Phase 53a).
 *
 * Runs an Actor through its five-phase lifecycle with governance gates
 * wrapped around every external action:
 *
 *   1. Kill-switch check  (cooperative halt)
 *   2. Budget check       (iterations, deadline)
 *   3. observe
 *   4. classify
 *   5. Convergence guard  (same key twice + no progress -> halt)
 *   6. propose
 *   7. Policy gate        (checkToolPolicy per action; 52a)
 *   8. apply              (only for allowed actions)
 *   9. reflect            (drives done and progress decisions)
 *  10. audit               (structured record of the iteration)
 *  11. loop or halt
 *
 * runActor is deliberately boring: no LLM knowledge, no external-system
 * knowledge. It enforces the governance contract and composes the actor's
 * phases. Everything else is the actor's problem.
 */

import { checkToolPolicy } from '../../policy/index.js';
import type { PolicyContext } from '../../policy/index.js';
import { isKillSwitchAbortReason } from '../../kill-switch/index.js';
import {
  mkKillSwitchTrippedAtom,
  type KillSwitchTripPhase,
  type KillSwitchTripTrigger,
} from '../../kill-switch/tripped-atom.js';
import type { Actor, ActorContext } from './actor.js';
import type {
  ActorAdapters,
  ActorAuditEvent,
  ActorBudget,
  ActorHaltReason,
  ActorReport,
  Classified,
  ProposedAction,
  Reflection,
} from './types.js';
import type { Host } from '../../interface.js';
import type { Principal } from '../../types.js';

export interface RunActorOptions<Adapters extends ActorAdapters> {
  readonly host: Host;
  readonly principal: Principal;
  readonly adapters: Adapters;
  readonly budget: ActorBudget;
  /** Prompt origin used by checkToolPolicy (e.g., 'telegram', 'terminal', 'scheduled'). */
  readonly origin: string;
  /**
   * Cooperative halt predicate. Called at the top of every iteration.
   * Common pattern: return existsSync('.lag/STOP') for a file sentinel.
   */
  readonly killSwitch?: () => boolean;
  /**
   * Runtime-revocation signal propagated into `ActorContext.abortSignal`
   * and checked at every loop-boundary. When aborted, `runActor` halts
   * at the earliest safe point AND adapters subscribed to the signal
   * abort their in-flight work (fetch, spawn, execa, LLM stream).
   *
   * Compatible with the existing `killSwitch` predicate; either, both,
   * or neither is valid. If both are supplied, either one tripping
   * halts the loop. If neither is supplied, a never-aborted signal is
   * injected so adapters can thread `ctx.abortSignal` unconditionally.
   */
  readonly killSwitchSignal?: AbortSignal;
  /**
   * Session identifier stamped into the kill-switch-tripped atom's
   * provenance.source.session_id when a trip halts the loop.
   * Required for downstream lineage projections that group trips
   * by operator session; when absent, the driver synthesizes a
   * fallback id of the form `run-actor-<actor>-<startedAt>` so the
   * atom still has a session_id, but the fallback is clearly not
   * a real session and should be treated as such by consumers.
   */
  readonly killSwitchSessionId?: string;
  /**
   * Optional free-form narrative stamped into the kill-switch-
   * tripped atom's metadata.revocation_notes. Use for operator-
   * supplied context the audit trail should preserve ("operator
   * STOP mid-merge because rollback branch stale", "pushed wrong
   * commit, cancelling before it lands", etc). Absent when not
   * supplied; the metadata key is omitted entirely.
   */
  readonly killSwitchRevocationNotes?: string;
  /**
   * Optional audit sink. Receives a structured event per phase. If
   * omitted, the driver still writes a minimal record to host.auditor.
   */
  readonly onAudit?: (event: ActorAuditEvent) => Promise<void>;
}

/**
 * A singleton never-aborted signal shared across `runActor` calls
 * that do not supply their own `killSwitchSignal`. Constructed lazily
 * so module import is free of side effects.
 */
let neverAbortedSignal: AbortSignal | null = null;
function getNeverAbortedSignal(): AbortSignal {
  if (neverAbortedSignal === null) {
    neverAbortedSignal = new AbortController().signal;
  }
  return neverAbortedSignal;
}

export async function runActor<
  Obs,
  Action,
  Outcome,
  Adapters extends ActorAdapters,
>(
  actor: Actor<Obs, Action, Outcome, Adapters>,
  options: RunActorOptions<Adapters>,
): Promise<ActorReport> {
  const startedAt = options.host.clock.now();
  const escalations: string[] = [];
  let haltReason: ActorHaltReason = 'budget-iterations';
  let lastNote: string | undefined;
  let iteration = 0;
  let prevKey: string | null = null;
  let prevProgress = true;
  // Tracked so the kill-switch-tripped atom can record the exact
  // state that was interrupted. Captured at the detection point so
  // the attribution is stable even when predicate-then-signal (or
  // vice-versa) races tip both to true before the post-loop
  // resolve. Starts as stop-sentinel for the predicate-common
  // case; overwritten when the signal path wins.
  let trippedPhase: KillSwitchTripPhase = 'between-iterations';
  let trippedInFlightTool: string | undefined;
  let trippedTrigger: KillSwitchTripTrigger = 'stop-sentinel';

  for (iteration = 1; iteration <= options.budget.maxIterations; iteration++) {
    const iterStartedAt = options.host.clock.now();

    const detected = detectKillSwitchTrip(options);
    if (detected !== null) {
      haltReason = 'kill-switch';
      trippedPhase = 'between-iterations';
      trippedTrigger = detected;
      break;
    }
    if (options.budget.deadline && iterStartedAt >= options.budget.deadline) {
      haltReason = 'budget-deadline';
      break;
    }

    const ctx = buildContext(actor, options, iteration);

    await emitAudit(options, actor, {
      kind: 'iteration-start',
      iteration,
      at: iterStartedAt,
      principal: options.principal.id,
      actor: actor.name,
      payload: {},
    });

    let obs: Obs;
    try {
      obs = await actor.observe(ctx);
    } catch (err) {
      haltReason = 'error';
      lastNote = `observe failed: ${errString(err)}`;
      break;
    }
    await emitAudit(options, actor, {
      kind: 'observation',
      iteration,
      at: options.host.clock.now(),
      principal: options.principal.id,
      actor: actor.name,
      payload: { observation: obs as unknown as Record<string, unknown> },
    });

    let classified: Classified<Obs>;
    try {
      classified = await actor.classify(obs, ctx);
    } catch (err) {
      haltReason = 'error';
      lastNote = `classify failed: ${errString(err)}`;
      break;
    }
    await emitAudit(options, actor, {
      kind: 'classification',
      iteration,
      at: options.host.clock.now(),
      principal: options.principal.id,
      actor: actor.name,
      payload: { key: classified.key, metadata: classified.metadata ?? {} },
    });

    // Convergence-loop guard: if the previous iteration made no progress
    // AND this iteration classifies to the same key, the loop is stuck.
    // Halt before wasting more apply cycles on actions we already know
    // won't change state. For "slow external system" scenarios where the
    // state is actually transient (e.g. waiting for CodeRabbit to post),
    // use budget.deadline -- that's what deadlines are for.
    if (
      prevKey !== null
      && classified.key === prevKey
      && prevProgress === false
    ) {
      haltReason = 'convergence-loop';
      lastNote = `same classification key "${classified.key}" without progress`;
      escalations.push(`convergence: ${classified.key}`);
      break;
    }

    let proposed: ReadonlyArray<ProposedAction<Action>>;
    try {
      proposed = await actor.propose(classified, ctx);
    } catch (err) {
      haltReason = 'error';
      lastNote = `propose failed: ${errString(err)}`;
      break;
    }
    await emitAudit(options, actor, {
      kind: 'proposal',
      iteration,
      at: options.host.clock.now(),
      principal: options.principal.id,
      actor: actor.name,
      payload: { count: proposed.length, tools: proposed.map((p) => p.tool) },
    });

    const outcomes: Outcome[] = [];
    let blockedByEscalate = false;
    let halted = false;
    for (const action of proposed) {
      // Kill-switch is checked BEFORE each apply, not only at iteration
      // start. This is the contract in design/actors-and-adapters.md:
      // a halt request during a multi-action iteration must land at the
      // earliest safe point (between actions; never mid-adapter-call).
      // Both the predicate and the AbortSignal are consulted; either
      // tripping halts the loop. Medium-tier adapters that see the
      // signal should ALREADY be aborting their own in-flight work -
      // this loop-level check catches the signal between adapter calls
      // so the actor halts cleanly instead of starting a new apply.
      const detected = detectKillSwitchTrip(options);
      if (detected !== null) {
        haltReason = 'kill-switch';
        trippedPhase = 'apply';
        trippedInFlightTool = action.tool;
        trippedTrigger = detected;
        halted = true;
        break;
      }
      let policyResult: Awaited<ReturnType<typeof checkToolPolicy>>;
      try {
        // Actor-layer default is permissive (allow) because runActor is
        // a generic loop primitive used by zero-config callers that
        // haven't provisioned a policy atom yet. The substrate primitive
        // defaults to escalate (fail-closed) when no policy matches;
        // this caller opts into the legacy permissive behavior.
        // Downstream operators tighten by seeding a deny / escalate
        // policy atom at L3 - still strictly more restrictive than
        // this default.
        policyResult = await checkToolPolicy(
          options.host,
          policyContextFor(action, options),
          { fallbackDecision: 'allow' },
        );
      } catch (err) {
        haltReason = 'error';
        lastNote = `policy check failed for ${action.tool}: ${errString(err)}`;
        halted = true;
        break;
      }
      await emitAudit(options, actor, {
        kind: 'policy-decision',
        iteration,
        at: options.host.clock.now(),
        principal: options.principal.id,
        actor: actor.name,
        payload: {
          tool: action.tool,
          decision: policyResult.decision,
          reason: policyResult.reason,
          matchedAtomId: policyResult.matchedAtomId,
        },
      });

      if (policyResult.decision === 'deny') {
        escalations.push(`deny: ${action.tool} (${policyResult.reason})`);
        continue;
      }
      if (policyResult.decision === 'escalate') {
        escalations.push(`escalate: ${action.tool} (${policyResult.reason})`);
        blockedByEscalate = true;
        continue;
      }

      try {
        const outcome = await actor.apply(action, ctx);
        outcomes.push(outcome);
        await emitAudit(options, actor, {
          kind: 'apply-outcome',
          iteration,
          at: options.host.clock.now(),
          principal: options.principal.id,
          actor: actor.name,
          payload: {
            tool: action.tool,
            outcome: outcome as unknown as Record<string, unknown>,
          },
        });
      } catch (err) {
        haltReason = 'error';
        lastNote = `apply failed for ${action.tool}: ${errString(err)}`;
        break;
      }
    }
    if (haltReason === 'error') break;
    if (halted) break;

    let reflection: Reflection;
    try {
      reflection = await actor.reflect(outcomes, classified, ctx);
    } catch (err) {
      haltReason = 'error';
      lastNote = `reflect failed: ${errString(err)}`;
      break;
    }
    lastNote = reflection.note;
    await emitAudit(options, actor, {
      kind: 'reflection',
      iteration,
      at: options.host.clock.now(),
      principal: options.principal.id,
      actor: actor.name,
      payload: {
        done: reflection.done,
        progress: reflection.progress,
        note: reflection.note ?? null,
      },
    });

    if (blockedByEscalate && !reflection.done) {
      haltReason = 'policy-escalate-blocking';
      break;
    }

    if (reflection.done) {
      haltReason = 'converged';
      break;
    }

    prevKey = classified.key;
    prevProgress = reflection.progress;
  }

  const endedAt = options.host.clock.now();
  await emitAudit(options, actor, {
    kind: 'halt',
    iteration,
    at: endedAt,
    principal: options.principal.id,
    actor: actor.name,
    payload: { haltReason, escalations: escalations.slice() },
  });

  // On kill-switch halt, write the kill-switch-tripped L1 observation
  // so there is a durable atom record of WHAT got interrupted and
  // WHY. Best-effort: any failure here logs a fatal stderr line and
  // falls through; the stored audit halt event above already carries
  // haltReason='kill-switch' so the incident is auditable either way.
  if (haltReason === 'kill-switch') {
    try {
      const sessionId =
        options.killSwitchSessionId
        ?? `run-actor-${actor.name}-${startedAt}`;
      const atom = mkKillSwitchTrippedAtom({
        actor: actor.name,
        principalId: options.principal.id,
        trigger: trippedTrigger,
        trippedAt: endedAt,
        iteration,
        phase: trippedPhase,
        sessionId,
        ...(trippedInFlightTool !== undefined
          ? { inFlightTool: trippedInFlightTool }
          : {}),
        ...(options.killSwitchRevocationNotes !== undefined
          ? { revocationNotes: options.killSwitchRevocationNotes }
          : {}),
      });
      await options.host.atoms.put(atom);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[runActor] FATAL: kill-switch-tripped atom write failed: ${errString(err)}`,
      );
    }
  }

  const base = {
    actor: actor.name,
    principal: options.principal.id,
    haltReason,
    iterations: Math.min(iteration, options.budget.maxIterations),
    startedAt,
    endedAt,
    escalations,
  };
  return lastNote === undefined ? base : { ...base, lastNote };
}

function buildContext<Adapters extends ActorAdapters>(
  actor: Actor<unknown, unknown, unknown, Adapters>,
  options: RunActorOptions<Adapters>,
  iteration: number,
): ActorContext<Adapters> {
  return {
    host: options.host,
    principal: options.principal,
    adapters: options.adapters,
    budget: options.budget,
    iteration,
    killSwitch: options.killSwitch ?? (() => false),
    abortSignal: options.killSwitchSignal ?? getNeverAbortedSignal(),
    audit: async (partial) => {
      await emitAudit(options, actor, {
        ...partial,
        iteration,
        at: options.host.clock.now(),
        principal: options.principal.id,
        actor: actor.name,
      });
    },
  };
}

/**
 * Check whether the kill-switch has tripped, and return the
 * attribution of which path tripped first. Returns null when
 * neither path has fired.
 *
 * Signal path is checked BEFORE the predicate path so that a
 * medium-tier AbortSignal trip (parent-signal or a
 * KillSwitchAbortReason-tagged stop-sentinel abort) attributes
 * correctly even when the soft predicate is ALSO true at the same
 * iteration boundary. When both mechanisms race to true between
 * checks, the signal's recorded reason is the richer signal and
 * wins attribution. When only the predicate has fired, the trigger
 * is classified as stop-sentinel (the .lag/STOP common case for
 * `killSwitch` predicates).
 */
function detectKillSwitchTrip<A extends ActorAdapters>(
  options: RunActorOptions<A>,
): KillSwitchTripTrigger | null {
  const signal = options.killSwitchSignal;
  if (signal !== undefined && signal.aborted) {
    if (isKillSwitchAbortReason(signal.reason)) {
      return signal.reason.trigger;
    }
    return 'stop-sentinel';
  }
  if (options.killSwitch?.()) {
    return 'stop-sentinel';
  }
  return null;
}

async function emitAudit<Adapters extends ActorAdapters>(
  options: RunActorOptions<Adapters>,
  _actor: Actor<unknown, unknown, unknown, Adapters>,
  event: ActorAuditEvent,
): Promise<void> {
  if (options.onAudit) {
    await options.onAudit(event);
    return;
  }
  await options.host.auditor.log({
    kind: `actor.${event.kind}`,
    principal_id: event.principal,
    timestamp: event.at,
    refs: {},
    details: {
      actor: event.actor,
      iteration: event.iteration,
      ...event.payload,
    },
  });
}

function policyContextFor<Action, Adapters extends ActorAdapters>(
  action: ProposedAction<Action>,
  options: RunActorOptions<Adapters>,
): PolicyContext {
  return {
    tool: action.tool,
    origin: options.origin,
    principal: options.principal.id,
  };
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
