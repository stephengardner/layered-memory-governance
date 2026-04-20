/**
 * PlanningActor (Phase 55a).
 *
 * Implements the Actor interface and drives through the MAPE-K loop:
 *   observe    -> aggregateRelevantContext(host, request)
 *   classify   -> judgment.classify(context)
 *   propose    -> judgment.draft(context, classification) -> ProposedPlan[]
 *                 then translated into ProposedActions with tool
 *                 'plan-propose' so the policy layer can gate them
 *   apply      -> write a type='plan' atom with plan_state='proposed',
 *                 then surface an HIL escalation via host.notifier
 *                 (the operator approves via lag-respond / Telegram)
 *   reflect    -> stop when all drafted plans are written AND escalated
 *
 * Authority: runs under the operator-provided Principal (cto-actor by
 * convention). The actor does NOT write L2/L3 atoms directly; Plan
 * atoms live at whatever layer the plan itself asserts (typically
 * L1 for "agent-observed proposal"). Promotion to L3 is a separate
 * step via the existing validatePlan + PromotionEngine path.
 *
 * Tool gate: every proposed plan goes through checkToolPolicy via
 * runActor with tool='plan-propose'. Canon can restrict planning by
 * principal / origin (e.g., "emergency plans escalate regardless of
 * classification"). The actor itself does not decide policy; it just
 * proposes and lets the substrate enforce.
 *
 * Sub-actor delegation (e.g., "approved plan invokes PrLandingActor")
 * is Phase 55c. This actor stops at "plan is proposed + escalated".
 */

import type { Actor, ActorContext } from '../actor.js';
import type {
  ActorAdapters,
  Classified,
  ProposedAction,
  Reflection,
} from '../types.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import { aggregateRelevantContext } from './aggregate-context.js';
import type { AggregateContextOptions } from './aggregate-context.js';
import type {
  PlanningClassification,
  PlanningContext,
  PlanningJudgment,
  ProposedPlan,
} from './types.js';

export interface PlanningActorOptions {
  /**
   * The operator-issued request that triggers this planning run. The
   * actor consumes it in observe via aggregateRelevantContext.
   */
  readonly request: string;
  /**
   * The judgment adapter. Injected so tests can stub and Phase 55b
   * can wire a real LLM + versioned prompts without touching actor
   * code. Keeps the actor itself deterministic and pure.
   */
  readonly judgment: PlanningJudgment;
  /** Aggregation caps forwarded to aggregateRelevantContext. */
  readonly aggregate?: AggregateContextOptions;
  /**
   * Clock source for the plan atom's created_at + provenance. When
   * undefined, the context's host.clock.now() is used.
   */
  readonly nowOverride?: () => Time;
}

export interface PlanningObservation {
  readonly context: PlanningContext;
}

export interface PlanningActionPayload {
  readonly plan: ProposedPlan;
  /** 1-based index of this plan within the iteration's proposal set. */
  readonly planIndex: number;
  readonly planCount: number;
}

export interface PlanningOutcome {
  readonly planAtomId: AtomId;
  readonly notificationHandle: string | null;
}

export class PlanningActor implements Actor<
  PlanningObservation,
  PlanningActionPayload,
  PlanningOutcome,
  ActorAdapters
> {
  readonly name = 'planning';
  readonly version = '0.1.0';

  private drafts: ReadonlyArray<ProposedPlan> = [];
  private classification: PlanningClassification | null = null;
  private planAtomIdsWritten = new Set<AtomId>();
  /**
   * Draft-content key -> atom id of the already-written plan atom.
   * Keyed on the full action payload (planIndex + plan body fields)
   * rather than title alone, so two distinct drafts with the same
   * title do not collapse into one atom. If apply() is invoked a
   * second time for the same draft (e.g. reflect kept the loop open
   * because the escalation failed) we reuse this id and skip the
   * atoms.put so a single logical plan never becomes multiple
   * plan-* atoms with different timestamp suffixes.
   */
  private atomIdByDraftKey = new Map<string, AtomId>();

  constructor(private readonly options: PlanningActorOptions) {}

  async observe(ctx: ActorContext<ActorAdapters>): Promise<PlanningObservation> {
    const context = await aggregateRelevantContext(
      ctx.host,
      this.options.request,
      this.options.aggregate ?? {},
    );
    return { context };
  }

  async classify(
    obs: PlanningObservation,
    _ctx: ActorContext<ActorAdapters>,
  ): Promise<Classified<PlanningObservation>> {
    const classification = await this.options.judgment.classify(obs.context);
    this.classification = classification;
    return {
      observation: obs,
      key: `planning:${classification.kind}`,
      metadata: {
        kind: classification.kind,
        rationale: classification.rationale,
        directives: classification.applicableDirectives.length,
      },
    };
  }

  async propose(
    classified: Classified<PlanningObservation>,
    _ctx: ActorContext<ActorAdapters>,
  ): Promise<ReadonlyArray<ProposedAction<PlanningActionPayload>>> {
    if (this.classification === null) return [];
    const drafts = await this.options.judgment.draft(
      classified.observation.context,
      this.classification,
    );
    this.drafts = drafts;
    const total = drafts.length;
    return drafts.map((plan, idx) => ({
      tool: 'plan-propose',
      description: `Propose plan: ${plan.title}`,
      payload: { plan, planIndex: idx + 1, planCount: total },
    }));
  }

  async apply(
    action: ProposedAction<PlanningActionPayload>,
    ctx: ActorContext<ActorAdapters>,
  ): Promise<PlanningOutcome> {
    const { plan } = action.payload;
    const nowFn = this.options.nowOverride ?? (() => ctx.host.clock.now());
    // Authorship is always the actor's running Principal. Options
    // used to expose an `authorPrincipalId` override, which let a
    // caller spoof plan authorship; authority has to come from the
    // running context, not the call-site config. Dropped.
    const principalId = ctx.principal.id;

    // Reuse the atom id if we already wrote this draft on a prior
    // iteration. Without this, a retry (escalation failed, reflect
    // kept the loop open) would generate a fresh id from the current
    // clock and write a second plan-* atom for the same logical
    // proposal.
    const draftKey = draftContentKey(action.payload);
    const existingAtomId = this.atomIdByDraftKey.get(draftKey);
    const planAtomId: AtomId = existingAtomId
      ?? deterministicPlanId(plan.title, principalId, nowFn());
    const now = nowFn();

    const planAtom: Atom = {
      schema_version: 1,
      id: planAtomId,
      content: renderPlanMarkdown(plan),
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: {
          agent_id: principalId,
        },
        derived_from: [...plan.derivedFrom],
      },
      confidence: plan.confidence ?? 0.8,
      created_at: now,
      last_reinforced_at: now,
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
      principal_id: principalId,
      taint: 'clean',
      // plan_state is a TOP-LEVEL field on the Atom interface (see
      // src/types.ts), not a metadata key. Callers that filter by
      // plan state (e.g., dispatch loops, auto-approve passes) read
      // the top-level field; writing it in metadata would leave
      // plan_state undefined to those readers and the plan atom
      // would never surface.
      plan_state: 'proposed',
      metadata: {
        planning_actor_version: this.version,
        title: plan.title,
        principles_applied: [...plan.principlesApplied],
        alternatives_rejected: plan.alternativesRejected.map((a) => a.option),
        what_breaks_if_revisit: plan.whatBreaksIfRevisit,
      },
    };

    // On retry, the atom is already in the store; skip the write and
    // proceed to re-attempt the notifier. atoms.put can throw
    // (ConflictError, transient adapter failure, etc.); wrap so
    // runActor sees the failure cleanly and produces a halt-reason
    // =error with a descriptive note rather than bubbling an uncaught
    // rejection.
    if (existingAtomId === undefined) {
      try {
        await ctx.host.atoms.put(planAtom);
      } catch (err) {
        throw new Error(
          `PlanningActor.apply: atoms.put failed for plan '${plan.title}': ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      this.planAtomIdsWritten.add(planAtom.id);
      this.atomIdByDraftKey.set(draftKey, planAtom.id);
    }

    // Surface as an HIL escalation. Operator approves/rejects via
    // existing notifier channels (file queue, Telegram). The notifier
    // returns a NotificationHandle we store on the outcome so the
    // caller can correlate approvals back to this plan.
    let handle: string | null = null;
    try {
      const notifyResult = await ctx.host.notifier.telegraph(
        {
          kind: 'proposal',
          severity: 'info',
          summary: `Plan proposed: ${plan.title}`,
          body: planAtom.content,
          atom_refs: [planAtom.id],
          principal_id: principalId,
          created_at: now,
        },
        null,
        'pending',
        0,
      );
      handle = String(notifyResult);
    } catch (err) {
      // Notifier failure must not sink the plan; the atom is written
      // and the operator can pick it up via lag-respond.
      // eslint-disable-next-line no-console
      console.error('[PlanningActor] notifier.telegraph failed:', err instanceof Error ? err.message : err);
    }

    return {
      planAtomId: planAtom.id,
      notificationHandle: handle,
    };
  }

  async reflect(
    outcomes: ReadonlyArray<PlanningOutcome>,
    _classified: Classified<PlanningObservation>,
    _ctx: ActorContext<ActorAdapters>,
  ): Promise<Reflection> {
    const total = this.drafts.length;
    const applied = outcomes.length;
    // Convergence requires BOTH: the plan atom was written AND the
    // HIL escalation went out. A silent-done after a notifier failure
    // means the operator never sees the plan; that's a discipline
    // failure, not a success. Count only plans with a live handle.
    const escalated = outcomes.filter((o) => o.notificationHandle !== null).length;
    const done = applied >= total && escalated >= total;
    return {
      done,
      progress: applied > 0,
      note: `Proposed ${applied}/${total} plan(s), ${escalated} escalated; operator approval pending`,
    };
  }
}

/**
 * Collision-safe key for the retry-reuse map. Drafts are identified
 * by their full action payload so two plans that happen to share a
 * title do not collapse to the same key. planIndex pins iteration
 * order; the content fields make two semantically different drafts
 * produce different keys even when titles match verbatim.
 */
function draftContentKey(payload: PlanningActionPayload): string {
  const p = payload.plan;
  return JSON.stringify({
    i: payload.planIndex,
    t: p.title,
    b: p.body,
    d: [...p.derivedFrom],
    pr: [...p.principlesApplied],
    w: p.whatBreaksIfRevisit,
  });
}

/**
 * Deterministic id derived from title + principal + time. Collision-
 * resistant enough for planning-scope (single operator, single
 * actor); replace with a content-hash if we ever relax that.
 */
function deterministicPlanId(title: string, principalId: PrincipalId, now: Time): AtomId {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const ts = now.replace(/[^0-9]/g, '').slice(0, 14);
  return `plan-${slug}-${principalId}-${ts}` as AtomId;
}

/**
 * Produce the markdown body stored on the Plan atom. Structured so
 * lag-respond can display it, so validatePlan can parse it, and so
 * it reads well when rendered into a Telegram message.
 */
function renderPlanMarkdown(plan: ProposedPlan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(plan.body.trim());

  if (plan.principlesApplied.length > 0) {
    lines.push('');
    lines.push('## Principles applied');
    for (const id of plan.principlesApplied) {
      lines.push(`- \`${id}\``);
    }
  }

  if (plan.alternativesRejected.length > 0) {
    lines.push('');
    lines.push('## Alternatives considered (rejected)');
    for (const { option, reason } of plan.alternativesRejected) {
      lines.push(`- **${option}** -- ${reason}`);
    }
  }

  lines.push('');
  lines.push('## What breaks if we revisit');
  lines.push(plan.whatBreaksIfRevisit.trim());

  if (plan.derivedFrom.length > 0) {
    lines.push('');
    lines.push('## Derived from');
    for (const id of plan.derivedFrom) {
      lines.push(`- \`${id}\``);
    }
  }
  return lines.join('\n');
}
