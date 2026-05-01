/**
 * Plan dispatcher: scans approved plans for a delegation envelope
 * and dispatches via SubActorRegistry.
 *
 * Workflow:
 * 1. listApprovedDelegatablePlans(host) walks plans with
 *    plan_state='approved' that carry a metadata.delegation envelope.
 * 2. For each, claim approved -> executing (with metadata.executing_at
 *    + executing_invoker) and emit a 'plan.dispatch-executing' audit
 *    event so the transition is observable through the same channel as
 *    the proposed -> approved transition (auto-approve.ts pattern).
 * 3. Call registry.invoke(...).
 * 4. On success, update the plan to state='succeeded' (with
 *    metadata.terminal_at + terminal_kind + dispatch_result) and emit
 *    a 'plan.dispatch-succeeded' audit event.
 * 5. On error, update the plan to state='failed' (with
 *    metadata.terminal_at + terminal_kind + error_message +
 *    dispatch_result), emit a 'plan.dispatch-failed' audit event, and
 *    write an escalation actor-message back to the plan's operator
 *    principal.
 * 6. On 'dispatched' (fire-and-forget), keep the plan in 'executing'
 *    and emit a 'plan.dispatch-in-flight' audit event so the operator
 *    can see the async path without waiting for terminal state.
 * 7. Unregistered sub-actor principal -> ValidationError bubbled by
 *    registry.invoke; the dispatcher catches, writes an escalation
 *    actor-message, and marks the plan 'failed'. This makes the
 *    "delegated to a non-existent actor" failure mode visible.
 *
 * Each dispatch is idempotent by plan id: a dispatcher restart
 * re-scans for 'approved' plans, but once a plan is moved to
 * 'succeeded' or 'failed' it drops out of the scan.
 *
 * Audit-log emission posture mirrors src/runtime/actor-message/
 * intent-approve.ts and src/runtime/planning-pipeline/auto-approve.ts:
 * each plan_state transition produces exactly one audit event so an
 * operator walking host.auditor.query sees the full lifecycle
 * (proposed -> approved -> executing -> succeeded|failed) without
 * re-reading every plan atom. The audit kind is the load-bearing
 * routing key so dashboards filter on it without a metadata walk.
 *
 * Backward-compatibility note: metadata.dispatch_result is preserved
 * unchanged so console plan-detail and any consumer querying the legacy
 * shape keeps working. The new top-level fields (executing_at,
 * executing_invoker, terminal_at, terminal_kind, error_message) are
 * additive; an old reader that ignores them sees the same dispatch_result
 * payload as before.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import type { ActorMessageV1 } from './types.js';
import type { InvokeResult, SubActorRegistry } from './sub-actor-registry.js';

/**
 * Cap on metadata.error_message length. Bounds runaway emissions from a
 * sub-actor whose error contains a stack trace, full LLM transcript, or
 * other unbounded content. The truncation marker matches the
 * substrate-wide convention of an explicit ellipsis suffix so an audit
 * consumer can detect that the message was clipped.
 */
const MAX_ERROR_MESSAGE_LEN = 1024;

function truncateErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LEN) return message;
  // Reserve room for the marker so the total length stays under the cap.
  const head = message.slice(0, MAX_ERROR_MESSAGE_LEN - 12);
  return `${head}...truncated`;
}

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
  options: {
    readonly now?: () => number;
    /**
     * Optional caller-supplied predicate that further narrows the
     * approved-plans candidate set. Used by pipeline-scoped callers
     * (e.g. the planning-pipeline dispatch-stage) to prevent a tick
     * from claiming approved plans that belong to a different
     * pipeline run. Default: accept every candidate. The base
     * approved + clean + has-delegation filter still applies first;
     * this predicate is an additional narrowing layer, not a way to
     * widen authority.
     */
    readonly planFilter?: (plan: Atom) => boolean;
  } = {},
): Promise<DispatchTickResult> {
  const now = options.now ?? (() => Date.now());
  const page = await host.atoms.query({ type: ['plan'] }, 500);
  const candidates = page.atoms.filter((atom) => {
    if (atom.superseded_by.length > 0) return false;
    if (atom.taint !== 'clean') return false;
    if (atom.plan_state !== 'approved') return false;
    if (!hasDelegationDescriptor(atom)) return false;
    if (options.planFilter !== undefined && !options.planFilter(atom)) return false;
    return true;
  });

  let dispatched = 0;
  let failed = 0;

  // Local helper: every audit emission for a dispatch transition shares
  // the same kind/principal_id/timestamp/refs scaffolding and varies
  // only in the details payload. Extracted at N=2 per the repo's
  // duplication-floor canon (4 emit sites: executing, succeeded,
  // in-flight, failed). Closes over plan + envelope from the caller's
  // scope so the helper signature stays minimal.
  async function emitDispatchAudit(
    plan: Atom,
    kind: 'plan.dispatch-executing'
      | 'plan.dispatch-succeeded'
      | 'plan.dispatch-in-flight'
      | 'plan.dispatch-failed',
    timestamp: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await host.auditor.log({
      kind,
      principal_id: plan.principal_id as PrincipalId,
      timestamp: timestamp as Time,
      refs: { atom_ids: [plan.id] },
      details,
    });
  }

  for (const plan of candidates) {
    // resolveDelegationEnvelope fills correlation_id / payload /
    // escalate_to from the plan atom when the descriptor on
    // metadata.delegation does not carry them. PLAN_DRAFT only requires
    // sub_actor_principal_id + reason + implied_blast_radius; the
    // dispatch-side fields are mechanism, not LLM judgment, so we
    // derive them deterministically here instead of forcing every
    // planner to author them.
    const envelope = await resolveDelegationEnvelope(host, plan);
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
    // in practice and avoid the race; a multi-process adapter needs
    // a native conditional update (e.g., `UPDATE ... WHERE
    // plan_state='approved'`) for correctness.
    const fresh = await host.atoms.get(plan.id);
    if (fresh === null || fresh.plan_state !== 'approved') {
      // Another tick claimed it, or the plan was revoked. Skip.
      continue;
    }
    // Claim the plan AND stamp the executing metadata in a single
    // update so the transition is atomic from the AtomStore's
    // perspective: a peer reader observing plan_state='executing'
    // also sees executing_at + executing_invoker, never the
    // intermediate "executing without provenance" state.
    const executingAt = new Date(now()).toISOString();
    await host.atoms.update(plan.id, {
      plan_state: 'executing',
      metadata: {
        executing_at: executingAt,
        executing_invoker: envelope.sub_actor_principal_id,
      },
    });
    await emitDispatchAudit(plan, 'plan.dispatch-executing', executingAt, {
      plan_id: String(plan.id),
      sub_actor_principal_id: envelope.sub_actor_principal_id,
      correlation_id: envelope.correlation_id,
    });

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
    // key, so passing only the new keys is both correct and avoids
    // clobbering other metadata keys that a concurrent writer may
    // have added to the plan. Re-spreading `...plan.metadata` would
    // replay a stale snapshot.
    //
    // dispatch_result is preserved verbatim (legacy shape; console
    // plan-detail + intent-approve audit consumers all read it). The
    // new top-level fields (terminal_at, terminal_kind, error_message)
    // are additive so a reader querying terminal_kind sees the same
    // outcome without parsing dispatch_result.kind.
    const terminalAt = new Date(now()).toISOString();
    if (result.kind === 'completed') {
      await host.atoms.update(plan.id, {
        plan_state: 'succeeded',
        metadata: {
          terminal_at: terminalAt,
          terminal_kind: 'succeeded',
          dispatch_result: {
            kind: 'completed',
            summary: result.summary,
            produced_atom_ids: result.producedAtomIds,
            at: terminalAt,
          },
        },
      });
      await emitDispatchAudit(plan, 'plan.dispatch-succeeded', terminalAt, {
        plan_id: String(plan.id),
        sub_actor_principal_id: envelope.sub_actor_principal_id,
        correlation_id: envelope.correlation_id,
        summary: result.summary,
        produced_atom_ids: [...result.producedAtomIds],
      });
      dispatched += 1;
    } else if (result.kind === 'dispatched') {
      // Plan stays in 'executing'; the terminal transition lands on a
      // future tick when the async sub-actor completes. terminal_at
      // and terminal_kind intentionally NOT stamped: the plan has not
      // reached terminal yet. dispatch_result records the in-flight
      // hand-off so an audit consumer sees the dispatch happened.
      await host.atoms.update(plan.id, {
        metadata: {
          dispatch_result: {
            kind: 'dispatched',
            summary: result.summary,
            at: terminalAt,
          },
        },
      });
      await emitDispatchAudit(plan, 'plan.dispatch-in-flight', terminalAt, {
        plan_id: String(plan.id),
        sub_actor_principal_id: envelope.sub_actor_principal_id,
        correlation_id: envelope.correlation_id,
        summary: result.summary,
      });
      dispatched += 1;
    } else {
      // error case
      const errorMessage = truncateErrorMessage(result.message);
      await host.atoms.update(plan.id, {
        plan_state: 'failed',
        metadata: {
          terminal_at: terminalAt,
          terminal_kind: 'failed',
          error_message: errorMessage,
          dispatch_result: {
            kind: 'error',
            message: result.message,
            at: terminalAt,
          },
        },
      });
      await emitDispatchAudit(plan, 'plan.dispatch-failed', terminalAt, {
        plan_id: String(plan.id),
        sub_actor_principal_id: envelope.sub_actor_principal_id,
        correlation_id: envelope.correlation_id,
        error_message: errorMessage,
      });
      // Pass the truncated errorMessage (not the raw result.message) so a
      // runaway sub-actor's stack trace cannot pollute the escalation
      // actor-message body and its inbox-rendered cousin. The legacy
      // dispatch_result.message above keeps the verbatim payload for
      // back-compat consumers; everywhere else the bounded form is the
      // contract.
      await writeEscalationMessage(host, plan, envelope, errorMessage, now);
      failed += 1;
    }
  }

  return { scanned: candidates.length, dispatched, failed };
}

/**
 * Synchronous predicate the candidate filter uses to keep dispatch
 * scanning fast. PLAN_DRAFT requires sub_actor_principal_id, so a
 * plan that lacks even that has no chance of becoming a valid
 * dispatch and is not worth the resolveDelegationEnvelope round-trip.
 */
function hasDelegationDescriptor(atom: Atom): boolean {
  const raw = (atom.metadata as Record<string, unknown>)?.delegation;
  if (raw === undefined || raw === null || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.sub_actor_principal_id === 'string'
    && obj.sub_actor_principal_id.length > 0;
}

/**
 * Build the full DelegationEnvelope the dispatcher hands to the
 * SubActorRegistry. Reads the descriptor from `metadata.delegation`
 * and fills mechanism-side fields the planner cannot reasonably
 * author:
 *   - correlation_id: deterministic per plan id; stable across
 *     retries so observation atoms thread back to the same logical
 *     dispatch.
 *   - payload: { plan_id } so a generic invoker can locate the plan
 *     atom without re-deriving the correlation id.
 *   - escalate_to: walks plan.provenance.derived_from for the first
 *     atom whose principal authored an authorizing operator-intent.
 *     Falls back to plan.principal_id when no upstream intent is
 *     reachable, which is correct behaviour for plans seeded by the
 *     orchestrator itself (e.g. multi-reviewer-approved plans whose
 *     escalation routing is owned by that flow, not this dispatcher):
 *     the planner is the highest authority in scope and absorbs the
 *     escalation by writing it to its own inbox.
 *
 * A descriptor that already carries any of these fields takes
 * precedence over the default; a future consumer that wants
 * non-default routing (e.g., escalating to an SRE rotation instead
 * of the originating operator) can override per-plan without
 * teaching the dispatcher about that consumer.
 */
async function resolveDelegationEnvelope(
  host: Host,
  atom: Atom,
): Promise<DelegationEnvelope | null> {
  const raw = (atom.metadata as Record<string, unknown>)?.delegation;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const sub_actor_principal_id = typeof obj.sub_actor_principal_id === 'string'
    ? obj.sub_actor_principal_id
    : null;
  if (sub_actor_principal_id === null || sub_actor_principal_id.length === 0) return null;

  const declaredCorrId = typeof obj.correlation_id === 'string' && obj.correlation_id.length > 0
    ? obj.correlation_id
    : null;
  const declaredEscalate = typeof obj.escalate_to === 'string' && obj.escalate_to.length > 0
    ? obj.escalate_to
    : null;
  // Treat null payload like undefined: PLAN_DRAFT does not author this
  // field, so the only way an explicit null arrives is through a
  // hand-edit or a future schema regression. Falling back to the
  // default { plan_id } in that case keeps the invoker contract intact
  // (the standard invokers all expect at least a plan_id).
  const declaredPayload = obj.payload !== undefined && obj.payload !== null
    ? obj.payload
    : null;

  const correlation_id = declaredCorrId ?? `dispatch-${String(atom.id)}`;
  const payload = declaredPayload !== null
    ? declaredPayload
    : { plan_id: String(atom.id) };
  const escalate_to = declaredEscalate ?? await deriveEscalateTo(host, atom);

  return {
    sub_actor_principal_id,
    payload,
    correlation_id,
    escalate_to,
  };
}

/**
 * Walk plan.provenance.derived_from looking for the first atom whose
 * principal_id can serve as the escalation target. Operator-intent
 * atoms come first because they encode the explicit authorization
 * the plan derived from; if none are found we fall back to the plan's
 * own principal_id (orchestrator-seeded plans).
 */
async function deriveEscalateTo(host: Host, atom: Atom): Promise<string> {
  for (const id of atom.provenance.derived_from) {
    const upstream = await host.atoms.get(id as AtomId);
    if (upstream === null) continue;
    if (upstream.type !== 'operator-intent') continue;
    const principalId = upstream.principal_id;
    if (typeof principalId === 'string' && principalId.length > 0) {
      return principalId;
    }
  }
  return String(atom.principal_id);
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
