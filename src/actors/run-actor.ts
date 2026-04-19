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

import { checkToolPolicy } from '../policy/index.js';
import type { PolicyContext } from '../policy/index.js';
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
import type { Host } from '../interface.js';
import type { Principal } from '../types.js';

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
   * Optional audit sink. Receives a structured event per phase. If
   * omitted, the driver still writes a minimal record to host.auditor.
   */
  readonly onAudit?: (event: ActorAuditEvent) => Promise<void>;
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

  for (iteration = 1; iteration <= options.budget.maxIterations; iteration++) {
    const iterStartedAt = options.host.clock.now();

    if (options.killSwitch?.()) {
      haltReason = 'kill-switch';
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
      if (options.killSwitch?.()) {
        haltReason = 'kill-switch';
        halted = true;
        break;
      }
      let policyResult: Awaited<ReturnType<typeof checkToolPolicy>>;
      try {
        policyResult = await checkToolPolicy(options.host, policyContextFor(action, options));
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
