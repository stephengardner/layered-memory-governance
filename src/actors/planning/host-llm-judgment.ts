/**
 * HostLlmPlanningJudgment.
 *
 * LLM-backed implementation of the PlanningJudgment contract. Uses
 * host.llm.judge() twice per planning run: once to classify the
 * request, once to draft plans. Every call is schema-validated via
 * zod, every call has a fingerprinted prompt + schema in the audit
 * trail, and every drafted plan is provenance-guarded at this layer
 * so invalid atoms never reach the atom store.
 *
 * Framework primitive: model ids, atom-truncation policy, and any
 * other vendor- or instance-specific defaults live in the caller
 * (scripts, canon, skill config), never here. This module is
 * mechanism-only.
 *
 * Injection seam: swap this for any other PlanningJudgment via the
 * PlanningActor options. The actor itself does not know whether it
 * is reasoning via LLM or a deterministic stub. Keeps tests pure,
 * keeps the rollback path trivial.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId } from '../../types.js';
import { PLAN_CLASSIFY, PLAN_DRAFT } from '../../schemas/index.js';
import type {
  PlanningClassification,
  PlanningContext,
  PlanningJudgment,
  ProposedPlan,
} from './types.js';

/**
 * Default per-call LLM timeout in milliseconds.
 *
 * Conservative framework default. Deployment policy (effort posture,
 * expected draft complexity, cost discipline) belongs at the call
 * site: override via HostLlmPlanningJudgmentOptions.timeoutMs.
 *
 * Exported so drivers can size their run deadline as
 * maxIterations * callsPerIteration * timeoutMs + slack without
 * guessing.
 */
export const DEFAULT_JUDGE_TIMEOUT_MS = 180_000;

/**
 * Default per-call budget cap passed to host.llm.judge as
 * LlmOptions.max_budget_usd. Semantics are adapter-defined; the
 * framework treats this only as a numeric pass-through.
 *
 * Conservative framework default. Callers set deployment policy
 * via HostLlmPlanningJudgmentOptions.maxBudgetUsdPerCall.
 */
export const DEFAULT_MAX_BUDGET_USD_PER_CALL = 0.5;

export interface HostLlmPlanningJudgmentOptions {
  /**
   * Model id for the classify step. REQUIRED. No default: framework
   * code under src/ stays mechanism-focused, so vendor-specific
   * model identifiers come from the caller (script, canon, skill
   * config), never from here. See the "Framework code under src/
   * must stay mechanism-focused and pluggable" canon directive.
   */
  readonly classifyModel: string;
  /**
   * Model id for the draft step. REQUIRED. Same rationale as
   * classifyModel.
   */
  readonly draftModel: string;
  /**
   * Per-call budget cap forwarded to host.llm.judge as
   * LlmOptions.max_budget_usd. Adapter-defined semantics;
   * treat as an opaque numeric knob at this layer.
   * Default DEFAULT_MAX_BUDGET_USD_PER_CALL.
   */
  readonly maxBudgetUsdPerCall?: number;
  /**
   * Plans with confidence below this threshold are dropped. If ALL
   * drafted plans fall below, the judgment emits a single
   * "missing-judgment" escalation plan so the operator sees the
   * failure instead of silence. Default 0.55.
   */
  readonly minConfidence?: number;
  /** Temperature for the judge calls. Default 0.2 (mostly deterministic). */
  readonly temperature?: number;
  /**
   * Override for the timeout on each judge call (ms).
   * Default DEFAULT_JUDGE_TIMEOUT_MS.
   */
  readonly timeoutMs?: number;
  /**
   * Tool deny-list forwarded to every `host.llm.judge(...)` call as
   * `LlmOptions.disallowedTools`. Intended to be resolved from a
   * principal-scoped canon policy atom (see `src/llm-tool-policy.ts`)
   * so per-actor tool access is a canon edit, not a framework
   * release.
   *
   * When undefined, the LLM implementation's own safety default
   * applies. Framework code stays mechanism-focused; the choice of
   * "which tools for which principal" is canon, not src/.
   */
  readonly disallowedTools?: ReadonlyArray<string>;
}

/**
 * Pick a minimal provenance chain for a fallback plan. Canon says
 * every atom carries a source chain; a fallback with `derivedFrom:
 * []` would violate that invariant the moment the actor writes it
 * to the atom store. Prefer the first directive (enforced
 * constraint), then a decision (prior precedent), then any relevant
 * or open-plan atom. Returns empty only if aggregate-context gave
 * us nothing at all, in which case the caller MUST handle the
 * zero-citation case explicitly.
 */
function fallbackDerivedFrom(context: PlanningContext): ReadonlyArray<AtomId> {
  const first =
    context.directives[0] ??
    context.decisions[0] ??
    context.relevantAtoms[0] ??
    context.openPlans[0];
  return first ? ([first.id] as ReadonlyArray<AtomId>) : [];
}

/**
 * Compact "failure" plan surfaced when the judgment cannot produce a
 * grounded plan. Operator-visible via the standard HIL escalation
 * path; confidence is deliberately low so the operator sees "this is
 * a meta-signal, not a real plan" and can retry or broaden context.
 *
 * `derivedFrom` is REQUIRED to be non-empty in practice (every atom
 * carries a source chain per canon). Caller passes
 * fallbackDerivedFrom(context) in most cases. If aggregation really
 * returned zero atoms, the caller can still pass [] here and handle
 * the downstream "uncited escalation" case at the actor layer.
 */
function missingJudgmentPlan(
  reason: string,
  request: string,
  derivedFrom: ReadonlyArray<AtomId>,
): ProposedPlan {
  return {
    title: `Clarify: cannot draft a grounded plan (${reason})`,
    body: [
      `Request: ${request}`,
      '',
      `The LLM-backed judgment failed to produce a grounded plan: ${reason}`,
      '',
      'This escalation plan exists so the failure is visible to the',
      'operator rather than silent. Common causes:',
      '- LLM rate limit or timeout: retry in a minute.',
      '- Aggregated context was empty for this request domain: seed',
      '  canon directives relevant to the topic, or relax the',
      '  aggregate-context caps.',
      '- Schema validation failure: the judgment prompt may need a',
      '  version bump if the failure reproduces.',
    ].join('\n'),
    derivedFrom,
    principlesApplied: [],
    alternativesRejected: [
      {
        option: 'Silently drop the failure',
        reason:
          'Violates the canon directive that every atom carries a source chain; we surface the failure instead.',
      },
    ],
    whatBreaksIfRevisit:
      'N/A: this plan exists only to signal that no grounded plan was produced.',
    confidence: 0.15,
  };
}

/**
 * Render an atom for the LLM judge. Sends the full atom content by
 * default; truncation policy, if any, is the caller's choice (canon
 * / skill / script config). Light shape trimming removes fields the
 * judge does not need.
 */
function renderAtomForJudge(atom: Atom): {
  id: string;
  type: string;
  layer: string;
  confidence: number;
  content: string;
  principal_id: string;
  title?: string;
} {
  const title = typeof atom.metadata?.title === 'string'
    ? (atom.metadata.title as string)
    : undefined;
  return {
    id: String(atom.id),
    type: atom.type,
    layer: atom.layer,
    confidence: atom.confidence,
    content: atom.content,
    principal_id: String(atom.principal_id),
    ...(title !== undefined ? { title } : {}),
  };
}

/**
 * Build the data payload the judge sees. Canon + relevant atoms get
 * full content; principals are just id + role + signed_by (no authority
 * content to surface at this layer).
 */
function renderContextForJudge(context: PlanningContext): Record<string, unknown> {
  return {
    request: context.request,
    gathered_at: context.gatheredAt,
    directives: context.directives.map(renderAtomForJudge),
    decisions: context.decisions.map(renderAtomForJudge),
    relevant_atoms: context.relevantAtoms.map(renderAtomForJudge),
    open_plans: context.openPlans.map((atom) => ({
      id: String(atom.id),
      title:
        typeof atom.metadata?.title === 'string'
          ? (atom.metadata.title as string)
          : '(untitled)',
      // Read top-level plan_state first (the correct location per
       // src/types.ts); fall back to metadata.plan_state so plans
       // written before the planning-actor plan_state fix still
       // render as their real state instead of 'unknown'.
      plan_state: String(atom.plan_state ?? atom.metadata?.plan_state ?? 'unknown'),
      content: atom.content,
    })),
    principals: context.relevantPrincipals.map((p) => ({
      id: String(p.id),
      role: p.role,
      signed_by: p.signed_by === null ? null : String(p.signed_by),
    })),
  };
}

export class HostLlmPlanningJudgment implements PlanningJudgment {
  private readonly host: Host;
  private readonly classifyModel: string;
  private readonly draftModel: string;
  private readonly maxBudgetUsdPerCall: number;
  private readonly minConfidence: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly disallowedTools: ReadonlyArray<string> | undefined;

  constructor(host: Host, options: HostLlmPlanningJudgmentOptions) {
    this.host = host;
    this.classifyModel = options.classifyModel;
    this.draftModel = options.draftModel;
    this.disallowedTools = options.disallowedTools;
    const maxBudgetUsdPerCall = options.maxBudgetUsdPerCall ?? DEFAULT_MAX_BUDGET_USD_PER_CALL;
    if (!Number.isFinite(maxBudgetUsdPerCall) || maxBudgetUsdPerCall <= 0) {
      throw new Error(
        `maxBudgetUsdPerCall must be a positive finite number, got ${maxBudgetUsdPerCall}`,
      );
    }
    this.maxBudgetUsdPerCall = maxBudgetUsdPerCall;
    this.minConfidence = options.minConfidence ?? 0.55;
    this.temperature = options.temperature ?? 0.2;
    const timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `timeoutMs must be a positive finite number, got ${timeoutMs}`,
      );
    }
    this.timeoutMs = timeoutMs;
  }

  async classify(context: PlanningContext): Promise<PlanningClassification> {
    const data = renderContextForJudge(context);
    let rawOutput: unknown;
    try {
      const result = await this.host.llm.judge(
        PLAN_CLASSIFY.jsonSchema,
        PLAN_CLASSIFY.systemPrompt,
        data,
        {
          model: this.classifyModel,
          temperature: this.temperature,
          timeout_ms: this.timeoutMs,
          max_budget_usd: this.maxBudgetUsdPerCall,
          sandboxed: true,
          ...(this.disallowedTools !== undefined ? { disallowedTools: this.disallowedTools } : {}),
        },
      );
      rawOutput = result.output;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[HostLlmPlanningJudgment.classify] judge failed: ${reason}`);
      return {
        kind: 'ambiguous',
        rationale: `LLM classification failed: ${reason}`,
        applicableDirectives: [],
      };
    }

    const parsed = PLAN_CLASSIFY.zodSchema.safeParse(rawOutput);
    if (!parsed.success) {
      return {
        kind: 'ambiguous',
        rationale: `LLM classify output failed schema validation: ${parsed.error.message}`,
        applicableDirectives: [],
      };
    }

    // Scrub invented ids: the judge MUST cite directive ids from the
    // input data. If it hallucinates an id that isn't in context, drop
    // it rather than stamp a provenance chain pointing at nothing.
    const directiveIds = new Set(context.directives.map((a) => String(a.id)));
    const applicable = parsed.data.applicable_directives.filter((id) => directiveIds.has(id));
    return {
      kind: parsed.data.kind,
      rationale: parsed.data.rationale,
      applicableDirectives: applicable as unknown as ReadonlyArray<AtomId>,
    };
  }

  async draft(
    context: PlanningContext,
    classification: PlanningClassification,
  ): Promise<ReadonlyArray<ProposedPlan>> {
    const data = {
      ...renderContextForJudge(context),
      classification: {
        kind: classification.kind,
        rationale: classification.rationale,
        applicable_directives: [...classification.applicableDirectives],
      },
    };

    let rawOutput: unknown;
    try {
      const result = await this.host.llm.judge(
        PLAN_DRAFT.jsonSchema,
        PLAN_DRAFT.systemPrompt,
        data,
        {
          model: this.draftModel,
          temperature: this.temperature,
          timeout_ms: this.timeoutMs,
          max_budget_usd: this.maxBudgetUsdPerCall,
          sandboxed: true,
          ...(this.disallowedTools !== undefined ? { disallowedTools: this.disallowedTools } : {}),
        },
      );
      rawOutput = result.output;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[HostLlmPlanningJudgment.draft] judge failed: ${reason}`);
      return [
        missingJudgmentPlan(
          `LLM draft failed: ${reason}`,
          context.request,
          fallbackDerivedFrom(context),
        ),
      ];
    }

    const parsed = PLAN_DRAFT.zodSchema.safeParse(rawOutput);
    if (!parsed.success) {
      return [
        missingJudgmentPlan(
          `LLM draft output failed schema validation: ${parsed.error.message}`,
          context.request,
          fallbackDerivedFrom(context),
        ),
      ];
    }

    // Build the provenance universe the draft is allowed to cite. Any
    // id the judge returns that is NOT in this set is an invented
    // citation and gets scrubbed. If scrubbing leaves a plan with
    // zero citations, the plan is rewritten into a missing-context
    // escalation at this layer so the atom store never sees an
    // uncited plan.
    // Two sets: `citable` for the broad provenance pool (any id the
    // draft is allowed to put in derivedFrom), and `directiveIds` for
    // the narrower "what principlesApplied is allowed to cite". The
    // ProposedPlan contract (see src/actors/planning/types.ts) says
    // principlesApplied is specifically the directive ids the plan
    // claims to satisfy; letting decisions / observations / open
    // plans leak into that field breaks validatePlan's alignment
    // check downstream.
    const citable = new Set<string>();
    const directiveIds = new Set<string>();
    for (const atom of context.directives) {
      const id = String(atom.id);
      citable.add(id);
      directiveIds.add(id);
    }
    for (const atom of context.decisions) citable.add(String(atom.id));
    for (const atom of context.relevantAtoms) citable.add(String(atom.id));
    for (const atom of context.openPlans) citable.add(String(atom.id));

    const cleaned: ProposedPlan[] = [];
    let droppedByCitation = 0;
    let droppedByConfidence = 0;
    for (const p of parsed.data.plans) {
      const derivedFrom = p.derived_from.filter((id) => citable.has(id));
      const derivedFromSet = new Set(derivedFrom);
      // principlesApplied must be BOTH a directive AND part of the
      // already-scrubbed derivedFrom set. Prevents the draft from
      // claiming a principle it did not also cite in the provenance
      // chain.
      const principlesApplied = p.principles_applied.filter(
        (id) => directiveIds.has(id) && derivedFromSet.has(id),
      );
      if (derivedFrom.length === 0) {
        // Uncited plan after scrubbing: the judgment cited atoms that
        // don't exist in the aggregated context, violating the
        // provenance directive. Rewrite into a missing-context form.
        droppedByCitation++;
        continue;
      }
      if (p.confidence < this.minConfidence) {
        droppedByConfidence++;
        continue;
      }
      cleaned.push({
        title: p.title,
        body: p.body,
        derivedFrom: derivedFrom as unknown as ReadonlyArray<AtomId>,
        principlesApplied: principlesApplied as unknown as ReadonlyArray<AtomId>,
        alternativesRejected: p.alternatives_rejected,
        whatBreaksIfRevisit: p.what_breaks_if_revisit,
        confidence: p.confidence,
      });
    }

    if (cleaned.length === 0) {
      // All drafted plans dropped: every one had zero valid citations
      // OR every one fell below minConfidence. Surface the reason.
      const reason =
        droppedByCitation > 0 && droppedByConfidence === 0
          ? `all ${droppedByCitation} drafted plan(s) cited only invented atom ids`
          : droppedByConfidence > 0 && droppedByCitation === 0
            ? `all ${droppedByConfidence} drafted plan(s) fell below minConfidence ${this.minConfidence}`
            : `drafted plans dropped: ${droppedByCitation} uncited + ${droppedByConfidence} low-confidence`;
      return [missingJudgmentPlan(reason, context.request, fallbackDerivedFrom(context))];
    }

    return cleaned;
  }
}
