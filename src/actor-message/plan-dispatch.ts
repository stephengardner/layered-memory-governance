/**
 * Plan dispatcher: scans approved plans for a delegation envelope
 * and dispatches via SubActorRegistry.
 *
 * Workflow:
 * 1. listApprovedDelegatablePlans(host) walks plans with
 *    plan_state='approved' that carry a metadata.delegation envelope.
 * 2. For each, call registry.invoke(...).
 * 3. On success, update the plan to state='succeeded' and note the
 *    produced atom ids in metadata.dispatch_result.
 * 4. On error, update the plan to state='failed' and write an
 *    escalation actor-message back to the plan's operator principal.
 * 5. Unregistered sub-actor principal -> ValidationError bubbled by
 *    registry.invoke; the dispatcher catches, writes an escalation
 *    actor-message, and marks the plan 'failed'. This makes the
 *    "delegated to a non-existent actor" failure mode visible.
 *
 * Each dispatch is idempotent by plan id: a dispatcher restart
 * re-scans for 'approved' plans, but once a plan is moved to
 * 'succeeded' or 'failed' it drops out of the scan.
 */

import type { Host } from '../substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../substrate/types.js';
import type { ActorMessageV1 } from './types.js';
import type { InvokeResult, SubActorRegistry } from './sub-actor-registry.js';

/**
 * Envelope that a Plan atom uses to ask for sub-actor dispatch.
 * Written by the PlanningActor (or a caller) into
 * `metadata.delegation` alongside the Plan's other metadata.
 */
export interface DelegationEnvelope {
  /** Sub-actor to invoke via registry.invoke. */
  readonly sub_actor_principal_id: string;
  /** Opaque payload the sub-actor's invoker understands. */
  readonly payload: unknown;
  /** Correlation id so reply messages can thread back. */
  readonly correlation_id: string;
  /** Who to message on failure. Usually the plan's originator. */
  readonly escalate_to: string;
}

export interface DispatchTickResult {
  readonly scanned: number;
  readonly dispatched: number;
  readonly failed: number;
}

/**
 * One sweep over approved delegatable plans. Returns counts for
 * observability; the scheduler/daemon calls this on every tick.
 * Does not block on the sub-actor's work: each invoke awaits in
 * sequence; if a sub-actor is long-running and returns a
 * `dispatched` result without completion, the plan state flips to
 * 'executing' and the result atoms land asynchronously.
 */
export async function runDispatchTick(
  host: Host,
  registry: SubActorRegistry,
  options: { readonly now?: () => number } = {},
): Promise<DispatchTickResult> {
  const now = options.now ?? (() => Date.now());
  const page = await host.atoms.query({ type: ['plan'] }, 500);
  const candidates = page.atoms.filter((atom) => {
    if (atom.superseded_by.length > 0) return false;
    if (atom.taint !== 'clean') return false;
    if (atom.plan_state !== 'approved') return false;
    return extractDelegation(atom) !== null;
  });

  let dispatched = 0;
  let failed = 0;

  for (const plan of candidates) {
    const envelope = extractDelegation(plan);
    if (envelope === null) continue;

    // Claim the plan BEFORE calling the invoker. Without this, two
    // overlapping ticks can both see plan_state='approved', both
    // invoke, and both write duplicate result atoms (plus duplicate
    // escalations on failure) - classic side-effect replay. Claim
    // by transitioning approved -> executing; concurrent ticks that
    // re-read see 'executing' and skip (the candidates filter
    // requires 'approved').
    //
    // Limitation: the AtomStore interface does not expose a true
    // compare-and-swap today, so the claim is best-effort between
    // get() and update(). The memory/file adapters serialize calls
    // in practice and avoid the race; a Postgres adapter with
    // native `UPDATE ... WHERE plan_state='approved'` is required
    // for multi-process concurrency. See the load-test commitment
    // in design/inbox-v1-load-test-commitment.md for the gate.
    const fresh = await host.atoms.get(plan.id);
    if (fresh === null || fresh.plan_state !== 'approved') {
      // Another tick claimed it, or the plan was revoked. Skip.
      continue;
    }
    await host.atoms.update(plan.id, { plan_state: 'executing' });

    let result: InvokeResult;
    try {
      result = await registry.invoke(
        envelope.sub_actor_principal_id,
        envelope.payload,
        envelope.correlation_id,
      );
    } catch (err) {
      result = {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Final state transition. AtomStore.update merges metadata by
    // key, so passing only `{ dispatch_result: ... }` is both
    // correct and avoids clobbering other metadata keys that a
    // concurrent writer may have added to the plan. Re-spreading
    // `...plan.metadata` would replay a stale snapshot.
    if (result.kind === 'completed') {
      await host.atoms.update(plan.id, {
        plan_state: 'succeeded',
        metadata: {
          dispatch_result: {
            kind: 'completed',
            summary: result.summary,
            produced_atom_ids: result.producedAtomIds,
            at: new Date(now()).toISOString(),
          },
        },
      });
      dispatched += 1;
    } else if (result.kind === 'dispatched') {
      // Plan is already in 'executing'; record the dispatch_result
      // but keep the state where the claim put it.
      await host.atoms.update(plan.id, {
        metadata: {
          dispatch_result: {
            kind: 'dispatched',
            summary: result.summary,
            at: new Date(now()).toISOString(),
          },
        },
      });
      dispatched += 1;
    } else {
      // error case
      await host.atoms.update(plan.id, {
        plan_state: 'failed',
        metadata: {
          dispatch_result: {
            kind: 'error',
            message: result.message,
            at: new Date(now()).toISOString(),
          },
        },
      });
      await writeEscalationMessage(host, plan, envelope, result.message, now);
      failed += 1;
    }
  }

  return { scanned: candidates.length, dispatched, failed };
}

function extractDelegation(atom: Atom): DelegationEnvelope | null {
  const raw = (atom.metadata as Record<string, unknown>)?.delegation;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sub_actor_principal_id !== 'string') return null;
  if (typeof obj.correlation_id !== 'string') return null;
  if (typeof obj.escalate_to !== 'string') return null;
  return {
    sub_actor_principal_id: obj.sub_actor_principal_id,
    payload: obj.payload,
    correlation_id: obj.correlation_id,
    escalate_to: obj.escalate_to,
  };
}

async function writeEscalationMessage(
  host: Host,
  plan: Atom,
  envelope: DelegationEnvelope,
  reason: string,
  now: () => number,
): Promise<void> {
  const nowIso = new Date(now()).toISOString() as Time;
  const atomId = `dispatch-escalation-${envelope.correlation_id}-${now()}` as unknown as AtomId;
  const reply: ActorMessageV1 = {
    to: envelope.escalate_to as PrincipalId,
    from: 'plan-dispatcher' as PrincipalId,
    topic: 'dispatch-failed',
    urgency_tier: 'high',
    body:
      `Sub-actor dispatch failed for plan ${String(plan.id)}.\n\n`
      + `Target sub-actor: ${envelope.sub_actor_principal_id}\n`
      + `Correlation id: ${envelope.correlation_id}\n`
      + `Reason: ${reason}\n\n`
      + 'The plan has been moved to state "failed". Investigate via `lag inbox` '
      + 'or fix the delegation target and re-approve a new plan atom.',
    correlation_id: envelope.correlation_id,
  };
  const atom: Atom = {
    schema_version: 1,
    id: atomId,
    content: reply.body,
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'plan-dispatcher',
        agent_id: 'plan-dispatcher',
        session_id: envelope.correlation_id,
      },
      derived_from: [plan.id],
    },
    confidence: 1.0,
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'plan-dispatcher' as PrincipalId,
    taint: 'clean',
    metadata: { actor_message: reply },
  };
  await host.atoms.put(atom);
}
