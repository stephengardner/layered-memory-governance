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
 * Sub-actor delegation: a caller (operator or orchestrator) that
 * knows the plan's target executor can pass `delegateTo` in options.
 * The plan atom then carries `metadata.delegation.sub_actor_principal_id`
 * which the auto-approve dispatcher reads alongside its own
 * `policy.allowed_sub_actors` gate. This actor does not decide what
 * to delegate to; it stamps declared intent onto the plan atom so
 * the governance layer can enforce.
 */

import type { Actor, ActorContext } from '../actor.js';
import type {
  ActorAdapters,
  Classified,
  ProposedAction,
  Reflection,
} from '../types.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../types.js';
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
  /**
   * If a Question atom drove this planning run, propagate its id +
   * verbatim body into the produced Plan atom's metadata as
   * `question_id` + `question_prompt`. Mirrors the agent-sdk
   * executor seam (src/integrations/agent-sdk/executor.ts) so both
   * planning paths produce Plan atoms with the same metadata shape
   * when a Question is the provenance root.
   *
   * The downstream CodeAuthor drafter reads `question_prompt` from
   * Plan metadata as ground-truth payload for the diff; absent this
   * propagation, a Decision whose governance-layer prose paraphrases
   * the Question (e.g. reduces "replace the specified line" to an
   * abstract reference) leaves the drafter with no literal to
   * implement and it emits an empty diff.
   *
   * Omit-when-empty: empty id or empty prompt strings produce the
   * same metadata shape as no originatingQuestion at all, so
   * callers synthesising a Question-shaped object with blank fields
   * do not change the plan-atom hash (fixture / MemoryLLM parity).
   */
  readonly originatingQuestion?: {
    readonly id: AtomId;
    readonly prompt: string;
  };
  /**
   * Declared target sub-actor principal for this plan. When set and
   * non-empty, the produced Plan atom gets
   * `metadata.delegation.sub_actor_principal_id = delegateTo`; the
   * auto-approve dispatcher (src/runtime/actor-message/auto-approve.ts)
   * reads that field and fires the registered invoker for the
   * target, gated by its own `policy.allowed_sub_actors` list.
   *
   * Omit-when-empty parity: `undefined` or `''` produces a Plan
   * atom byte-identical to a pre-seam plan; the `delegation` key is
   * simply absent. Downstream readers that check
   * `'delegation' in metadata` stay honest, and hash-keyed fixtures
   * (MemoryLLM test fixtures) do not break.
   *
   * This option carries declared intent only. Governance (which
   * principals may delegate to which sub-actors) lives in the
   * auto-approve policy atom. PlanningActor stamping `delegateTo`
   * does not bypass that gate.
   */
  readonly delegateTo?: PrincipalId;
  /**
   * When the planning run was triggered by an intent atom (Task 7),
   * pass its id here so it is appended to each produced Plan atom's
   * `provenance.derived_from`. This closes the provenance chain from
   * intent -> plan, enabling taint propagation and audit traces to
   * follow the full lineage.
   *
   * Callers that do not use the intent substrate omit this option;
   * the produced plan atom is byte-identical to the pre-seam
   * baseline. Default: null (no intent id appended).
   */
  readonly intentId?: string | null;
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

/**
 * Map the optional `originatingQuestion` option into the Plan
 * atom's metadata, with the same omit-when-empty contract the
 * agent-sdk executor seam uses (empty id or empty prompt yields
 * no corresponding key so the Plan metadata shape stays identical
 * to the no-Question baseline).
 */
function buildQuestionMetadata(
  origin: PlanningActorOptions['originatingQuestion'],
): Record<string, unknown> {
  if (origin === undefined) return {};
  const out: Record<string, unknown> = {};
  // Trim before length check so whitespace-only ids or prompts are
  // treated as empty; stamping '   ' as question_id would let a
  // mis-constructed caller poison the plan atom's provenance chain
  // with a non-resolvable id.
  if (typeof origin.id === 'string' && origin.id.trim().length > 0) {
    out.question_id = origin.id;
  }
  if (typeof origin.prompt === 'string' && origin.prompt.trim().length > 0) {
    out.question_prompt = origin.prompt;
  }
  return out;
}

/**
 * Full delegation descriptor that can appear on a plan atom's
 * `metadata.delegation` field. Carries the declared sub-actor
 * principal, the rationale for the delegation, and an estimated
 * blast radius so the auto-approve dispatcher can gate on scope
 * before firing the sub-actor invoker.
 *
 * All three fields are optional at the type level: callers that
 * only know `sub_actor_principal_id` (e.g. older callsites using
 * the `delegateTo` option) continue to produce a valid object; the
 * richer fields are stamped when available from a PLAN_DRAFT output.
 */
export interface DelegationDescriptor {
  readonly sub_actor_principal_id: PrincipalId;
  readonly reason?: string;
  readonly implied_blast_radius?: string;
}

/**
 * Map the optional `delegateTo` option OR a full DelegationDescriptor
 * into the Plan atom's `metadata.delegation`. Omit-when-empty
 * contract: an undefined or empty `delegateTo` (and no descriptor)
 * produces no `delegation` key, keeping plan-atom shape identical to
 * the pre-seam baseline and hash-keyed fixtures stable.
 *
 * When a full descriptor is provided it takes precedence over the
 * plain `delegateTo` string, allowing PLAN_DRAFT outputs to stamp
 * reason + implied_blast_radius alongside sub_actor_principal_id.
 */
function buildDelegationMetadata(
  delegateTo: PlanningActorOptions['delegateTo'],
  descriptor?: DelegationDescriptor,
): Record<string, unknown> {
  // Full descriptor takes precedence when supplied.
  if (descriptor !== undefined) {
    if (
      typeof descriptor.sub_actor_principal_id !== 'string' ||
      descriptor.sub_actor_principal_id.trim().length === 0
    ) {
      return {};
    }
    const out: Record<string, unknown> = {
      sub_actor_principal_id: descriptor.sub_actor_principal_id,
    };
    if (typeof descriptor.reason === 'string' && descriptor.reason.trim().length > 0) {
      out.reason = descriptor.reason;
    }
    if (
      typeof descriptor.implied_blast_radius === 'string' &&
      descriptor.implied_blast_radius.trim().length > 0
    ) {
      out.implied_blast_radius = descriptor.implied_blast_radius;
    }
    return { delegation: out };
  }
  // Fallback to the plain delegateTo principal id. Trim before
  // length check so whitespace-only principal ids are treated as
  // empty, same discipline as buildQuestionMetadata above.
  if (typeof delegateTo !== 'string' || delegateTo.trim().length === 0) {
    return {};
  }
  return {
    delegation: {
      sub_actor_principal_id: delegateTo,
    },
  };
}

/**
 * Input shape for the buildPlanAtom pure function. Represents the
 * minimal set of values needed to construct a Plan atom without a
 * running host or actor context. Exported so unit tests can call
 * buildPlanAtom directly without wiring a full ActorContext.
 */
export interface BuildPlanAtomInput {
  /**
   * The PLAN_DRAFT output fields used to construct the atom body.
   * `derived_from` maps to provenance.derived_from; `delegation`
   * (when present) maps to metadata.delegation.
   */
  readonly draft: {
    readonly title: string;
    readonly body: string;
    readonly derived_from: ReadonlyArray<string>;
    readonly principles_applied: ReadonlyArray<string>;
    readonly alternatives_rejected: ReadonlyArray<{
      readonly option: string;
      readonly reason: string;
    }>;
    readonly what_breaks_if_revisit: string;
    readonly confidence?: number;
    readonly delegation?: DelegationDescriptor;
  };
  /** Running principal id; becomes atom.principal_id + provenance.source.agent_id. */
  readonly principalId: string;
  /**
   * When the plan was triggered by an intent atom, append the intent
   * id to provenance.derived_from so the provenance chain is
   * complete. Pass null when no intent drove this plan.
   */
  readonly intentId: string | null;
  /** Wall-clock instant for created_at + last_reinforced_at. */
  readonly now: Date;
  /**
   * Determinism nonce; typically a short random string or a
   * counter. Combined with title + principalId to produce the atom
   * id without relying on the wall-clock alone.
   */
  readonly nonce: string;
}

/**
 * Pure function: construct a Plan atom from the provided inputs
 * without writing to any store. Extracted from PlanningActor.apply
 * so tests can verify the atom shape in isolation without wiring a
 * full host, and so callers like a virtual-org executor can reuse
 * the same construction logic.
 *
 * Exported for unit tests (test/runtime/actors/planning/delegation.test.ts
 * and future callers). The PlanningActor.apply method calls this
 * internally to keep atom construction in one place.
 */
export function buildPlanAtom(input: BuildPlanAtomInput): Atom {
  const { draft, principalId, intentId, now, nonce } = input;
  const nowStr = now.toISOString() as Time;

  // Deterministic id: title-slug + principal + nonce so tests can
  // pass a fixed nonce and get a stable id.
  const slug = draft.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const planAtomId =
    `plan-${slug}-${principalId}-${nonce}` as AtomId;

  // Build derived_from: start with draft's citations, append intentId
  // when present so the provenance chain traces back to the triggering
  // intent atom.
  const derivedFrom: string[] = [...draft.derived_from];
  if (typeof intentId === 'string' && intentId.trim().length > 0) {
    derivedFrom.push(intentId);
  }

  // Convert draft's flat arrays into ProposedPlan-compatible shapes
  // for renderPlanMarkdown.
  const proposedPlan: ProposedPlan = {
    title: draft.title,
    body: draft.body,
    derivedFrom: draft.derived_from as ReadonlyArray<AtomId>,
    principlesApplied: draft.principles_applied as ReadonlyArray<AtomId>,
    alternativesRejected: draft.alternatives_rejected,
    whatBreaksIfRevisit: draft.what_breaks_if_revisit,
    ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
  };

  return {
    schema_version: 1,
    id: planAtomId,
    content: renderPlanMarkdown(proposedPlan),
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: principalId as PrincipalId,
      },
      derived_from: derivedFrom as AtomId[],
    },
    confidence: draft.confidence ?? 0.8,
    created_at: nowStr,
    last_reinforced_at: nowStr,
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
    principal_id: principalId as PrincipalId,
    taint: 'clean',
    plan_state: 'proposed',
    metadata: {
      planning_actor_version: '0.1.0',
      title: draft.title,
      principles_applied: [...draft.principles_applied],
      alternatives_rejected: draft.alternatives_rejected.map((a) => a.option),
      what_breaks_if_revisit: draft.what_breaks_if_revisit,
      ...buildDelegationMetadata(undefined, draft.delegation),
    },
  };
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
    const now = nowFn();

    // Build via the exported pure helper so the atom construction
    // logic lives in one place and unit tests can exercise it without
    // a running host. The nonce is derived from the plan index to
    // keep atom ids deterministic across retries (same index -> same
    // id), matching the pre-seam deterministicPlanId contract.
    const builtAtom = buildPlanAtom({
      draft: {
        title: plan.title,
        body: plan.body,
        derived_from: [...plan.derivedFrom],
        principles_applied: [...plan.principlesApplied],
        alternatives_rejected: [...plan.alternativesRejected],
        what_breaks_if_revisit: plan.whatBreaksIfRevisit,
        ...(plan.confidence !== undefined ? { confidence: plan.confidence } : {}),
        // DelegationDescriptor is not on ProposedPlan; it comes from
        // actor options only. The pure function path picks it up via
        // the descriptor field; absence means no delegation key.
        ...(this.options.delegateTo
          ? { delegation: { sub_actor_principal_id: this.options.delegateTo } satisfies DelegationDescriptor }
          : {}),
      },
      principalId,
      intentId: this.options.intentId ?? null,
      now: new Date(now),
      // Nonce: use the wall-clock timestamp string so the id is
      // deterministic for a given (title, principal, time) tuple,
      // matching the pre-seam deterministicPlanId contract.
      nonce: now.replace(/[^0-9]/g, '').slice(0, 14),
    });

    // Carry forward the originating-question metadata which lives on
    // actor options (not on the draft shape) and merge with the atom
    // produced by buildPlanAtom.
    const planAtomId: AtomId = existingAtomId ?? builtAtom.id;
    // When retrying a previously-written plan we need the same atom
    // id (existingAtomId) but the question-metadata merge still
    // applies. Reconstruct with the correct id + question fields in
    // both the first-write and retry paths.
    const planAtom: Atom = {
      ...builtAtom,
      id: planAtomId,
      metadata: {
        ...builtAtom.metadata,
        // Propagate the originating Question's id + verbatim body
        // into metadata. Load-bearing for the CodeAuthor drafter:
        // plan_content is the governance-layer Decision (may
        // paraphrase), question_prompt is the literal payload.
        // Mirrors src/integrations/agent-sdk/executor.ts's
        // enrichment so both planning paths land the same metadata
        // shape when a Question drives the run. Omit-when-empty
        // parity means no originatingQuestion (or empty fields)
        // leaves the metadata byte-identical to the pre-seam
        // baseline -- MemoryLLM fixture keys + downstream
        // `'question_id' in metadata` checks stay honest.
        ...buildQuestionMetadata(this.options.originatingQuestion),
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
