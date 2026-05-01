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
 * 4. Map the InvokeResult's `kind` through INVOKE_RESULT_TO_TERMINAL_KIND
 *    to a plan_state terminal kind. The mapping is the single source of
 *    truth for "did this dispatch operation succeed?"; both 'completed'
 *    and 'dispatched' invoker outcomes mean "the dispatcher's work
 *    finished cleanly" and transition the plan to 'succeeded'. 'error'
 *    transitions to 'failed' and writes an escalation actor-message.
 *    Unknown kinds fail-closed (treated as failed) so a future invoker
 *    that returns a not-yet-mapped kind doesn't silently strand a plan
 *    in 'executing'. Adding a real "stays-executing-pending-async-reaper"
 *    semantic in the future is a deliberate canon edit, not a fall-
 *    through default.
 * 5. On success, stamp metadata.terminal_at + terminal_kind + (when the
 *    invoker surfaced a PR via the summary) dispatch_pr_number and
 *    dispatch_pr_summary so the console can link plan -> PR without an
 *    out-of-band lookup. dispatch_result is preserved verbatim for
 *    legacy consumers (plan-detail viewer, intent-approve audit).
 * 6. On error, stamp metadata.terminal_at + terminal_kind + error_message
 *    + dispatch_result, emit a 'plan.dispatch-failed' audit event, and
 *    write an escalation actor-message back to the plan's operator
 *    principal.
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
 * executing_invoker, terminal_at, terminal_kind, error_message,
 * dispatch_pr_number, dispatch_pr_summary) are additive; an old reader
 * that ignores them sees the same dispatch_result payload as before.
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
 * Single source of truth: which InvokeResult kinds count as a successful
 * dispatch operation? Treated as a comprehensive table rather than an
 * if/else chain so a future invoker that returns a new success kind
 * lands as a one-line addition here, not a scattered patch across the
 * dispatch + audit + console surfaces.
 *
 * Today's kinds:
 *   'completed'  -> sub-actor finished synchronously and emitted result
 *                   atoms; plan transitions to 'succeeded'. Producer:
 *                   auditor-actor and any read-only sub-actor that emits
 *                   atoms in-process.
 *   'dispatched' -> sub-actor handed off durable work (e.g. opened a
 *                   GitHub PR) and considers its dispatch operation
 *                   complete. Plan transitions to 'succeeded' because
 *                   the dispatcher's contract is "did the dispatch
 *                   operation succeed?", not "is the downstream artifact
 *                   merged?". Producers: code-author / autonomous-
 *                   dispatch path, both of which return 'dispatched'
 *                   after a PR is created. Without this terminal
 *                   mapping a plan stays in 'executing' forever because
 *                   no PR-merge reaper exists to flip it.
 *   'error'      -> sub-actor failed; plan transitions to 'failed'.
 *
 * Adding a true "stays-executing-pending-async-reaper" semantic later
 * is a deliberate canon edit (a new InvokeResult kind plus a reaper
 * that flips the plan back into a terminal state). Until then, leaving
 * 'dispatched' as a non-terminal-mapping was the substrate gap that
 * stranded plans on every autonomous-dispatch run.
 */
const INVOKE_RESULT_TO_TERMINAL_KIND: Readonly<
  Record<InvokeResult['kind'], 'succeeded' | 'failed'>
> = Object.freeze({
  completed: 'succeeded',
  dispatched: 'succeeded',
  error: 'failed',
});

/**
 * Loud-fail guard: assert that a particular InvokeResult kind is in the
 * success branch of the mapping table. Called from the per-kind branches
 * in runDispatchTick so a future canon edit that downgrades 'completed'
 * or 'dispatched' to a failed mapping fails noisily on the next
 * dispatch tick rather than silently emitting the wrong audit kind.
 *
 * Throws (rather than logging + continuing) because a misalignment
 * between table and branch is a substrate-correctness regression, not
 * a user-recoverable runtime condition.
 */
function assertSuccessMapping(kind: InvokeResult['kind']): void {
  const mapped = INVOKE_RESULT_TO_TERMINAL_KIND[kind];
  if (mapped !== 'succeeded') {
    throw new Error(
      `runDispatchTick invariant violation: kind=${kind} expected mapping `
      + `'succeeded' but INVOKE_RESULT_TO_TERMINAL_KIND returned '${mapped}'. `
      + 'Update the per-kind branch in runDispatchTick if the table changed.',
    );
  }
}

/**
 * Best-effort extractor for a PR number from an InvokeResult's summary
 * string. The autonomous-dispatch + code-author invokers both format
 * their summaries as "...as PR #<number> (commit-sha)..." so a parse
 * that succeeds gives the console a stable plan -> PR link without
 * widening the InvokeResult type to carry PR-shaped fields (which would
 * bake the autonomous-dispatch shape into the framework boundary).
 *
 * Returns null when no recognizable PR-number pattern is present so a
 * non-PR-shaped invoker (e.g. auditor-actor returning "atoms produced:
 * out-corr-1") doesn't get a misleading number stamped on its plan.
 *
 * Conservative regex: matches '#<digits>' anywhere in the summary,
 * bounded above to 7 digits because GitHub PR numbers in this repo are
 * 3-4 digits today and the substrate-defined ceiling is far below 7.
 * A future repo with a different PR-number scale loosens this when the
 * second example arrives, per the canon dial-after-second-use-case
 * directive.
 */
export function parsePrNumberFromSummary(summary: string): number | null {
  const match = /#(\d{1,7})\b/.exec(summary);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
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
  // duplication-floor canon (3 emit sites: executing, succeeded,
  // failed). Closes over plan + envelope from the caller's scope so
  // the helper signature stays minimal. Note: the prior 'plan.dispatch-
  // in-flight' kind is retained in the type union for back-compat with
  // audit-log consumers reading historical events written before
  // 'dispatched' was mapped to terminal_kind='succeeded'; new
  // emissions only use the three active kinds.
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
    // new top-level fields (terminal_at, terminal_kind, error_message,
    // dispatch_pr_number, dispatch_pr_summary) are additive so a reader
    // querying terminal_kind sees the same outcome without parsing
    // dispatch_result.kind.
    //
    // Branch on the discriminator (result.kind) rather than the mapped
    // terminal kind so TypeScript narrows the InvokeResult union to
    // the per-case shape (.summary + .producedAtomIds on 'completed',
    // .summary on 'dispatched', .message on 'error'). The mapping
    // table INVOKE_RESULT_TO_TERMINAL_KIND remains the single source
    // of truth for "which kinds count as successful?" and is asserted
    // below to keep the table and the branching in lockstep.
    const terminalAt = new Date(now()).toISOString();

    if (result.kind === 'completed') {
      // Sanity check: the success-mapping table must agree with this
      // branch. If a future canon edit downgrades 'completed' to a
      // failed mapping the table change would surface here as a
      // failed-loud guard rather than silently emitting the wrong
      // audit kind.
      assertSuccessMapping('completed');
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
        result_kind: 'completed',
        produced_atom_ids: [...result.producedAtomIds],
      });
      dispatched += 1;
    } else if (result.kind === 'dispatched') {
      // 'dispatched' is the kind autonomous-dispatch / code-author
      // returns after a PR is opened; the dispatcher's contract is
      // "did this dispatch operation succeed?", so the plan transitions
      // to terminal_kind='succeeded'. Without this terminal mapping a
      // plan stays in 'executing' forever (no PR-merge reaper exists
      // today). dispatch_result.kind='dispatched' is preserved so a
      // legacy reader can still distinguish PR-shaped vs atom-emitting
      // completions.
      assertSuccessMapping('dispatched');
      const prNumber = parsePrNumberFromSummary(result.summary);
      await host.atoms.update(plan.id, {
        plan_state: 'succeeded',
        metadata: {
          terminal_at: terminalAt,
          terminal_kind: 'succeeded',
          ...(prNumber !== null
            ? { dispatch_pr_number: prNumber, dispatch_pr_summary: result.summary }
            : {}),
          dispatch_result: {
            kind: 'dispatched',
            summary: result.summary,
            at: terminalAt,
          },
        },
      });
      await emitDispatchAudit(plan, 'plan.dispatch-succeeded', terminalAt, {
        plan_id: String(plan.id),
        sub_actor_principal_id: envelope.sub_actor_principal_id,
        correlation_id: envelope.correlation_id,
        summary: result.summary,
        result_kind: 'dispatched',
        ...(prNumber !== null ? { dispatch_pr_number: prNumber } : {}),
      });
      dispatched += 1;
    } else {
      // result.kind === 'error' is the only remaining variant. The
      // discriminated-union exhaustiveness check below pins this so a
      // future kind addition must be wired up explicitly here rather
      // than slipping through the implicit fallthrough.
      const _exhaustive: 'error' = result.kind;
      void _exhaustive;
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
        result_kind: 'error',
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
