/**
 * HostLlmPlanningJudgment (Phase 55b+).
 *
 * LLM-backed implementation of the PlanningJudgment contract. Uses
 * host.llm.judge() twice per planning run: once to classify the
 * request, once to draft plans. Every call is schema-validated via
 * zod, every call has a fingerprinted prompt + schema in the audit
 * trail, and every drafted plan is provenance-guarded at this layer
 * so invalid atoms never reach the atom store.
 *
 * Injection seam: swap this for `stubJudgment()` via PlanningActor
 * options. The actor itself does not know whether it is reasoning
 * via LLM or a deterministic stub. Keeps tests pure, keeps the
 * rollback path trivial.
 *
 * Per operator decision 2026-04-19: Opus for both classify and draft,
 * no per-atom content truncation, plans are the most important thing
 * we build, spare no tokens.
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

export interface HostLlmPlanningJudgmentOptions {
  /** Model for the classify step. Default claude-opus-4-7. */
  readonly classifyModel?: string;
  /** Model for the draft step. Default claude-opus-4-7. */
  readonly draftModel?: string;
  /**
   * Per-call budget cap passed to host.llm.judge. Per-run worst case
   * is 2x this value (classify + draft). Default 0.50 USD.
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
   * Optional override for the timeout on each judge call (ms). Plans
   * can take longer than an extract-claims call; default 180_000.
   */
  readonly timeoutMs?: number;
}

/**
 * Compact "failure" plan surfaced when the judgment cannot produce a
 * grounded plan. Operator-visible via the standard HIL escalation
 * path; confidence is deliberately low so the operator sees "this is
 * a meta-signal, not a real plan" and can retry or broaden context.
 */
function missingJudgmentPlan(reason: string, request: string): ProposedPlan {
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
    derivedFrom: [],
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
 * Render an atom for the LLM judge. We send the full atom content
 * (operator directive 2026-04-19: plans are the most important thing
 * we build, spare no tokens). Light shape trimming to remove fields
 * the judge does not need.
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
      plan_state: String(atom.metadata?.plan_state ?? 'unknown'),
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

  constructor(host: Host, options: HostLlmPlanningJudgmentOptions = {}) {
    this.host = host;
    this.classifyModel = options.classifyModel ?? 'claude-opus-4-7';
    this.draftModel = options.draftModel ?? 'claude-opus-4-7';
    this.maxBudgetUsdPerCall = options.maxBudgetUsdPerCall ?? 0.5;
    this.minConfidence = options.minConfidence ?? 0.55;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? 180_000;
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
        },
      );
      rawOutput = result.output;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[HostLlmPlanningJudgment.draft] judge failed: ${reason}`);
      return [missingJudgmentPlan(`LLM draft failed: ${reason}`, context.request)];
    }

    const parsed = PLAN_DRAFT.zodSchema.safeParse(rawOutput);
    if (!parsed.success) {
      return [
        missingJudgmentPlan(
          `LLM draft output failed schema validation: ${parsed.error.message}`,
          context.request,
        ),
      ];
    }

    // Build the provenance universe the draft is allowed to cite. Any
    // id the judge returns that is NOT in this set is an invented
    // citation and gets scrubbed. If scrubbing leaves a plan with
    // zero citations, the plan is rewritten into a missing-context
    // escalation at this layer so the atom store never sees an
    // uncited plan.
    const citable = new Set<string>();
    for (const atom of context.directives) citable.add(String(atom.id));
    for (const atom of context.decisions) citable.add(String(atom.id));
    for (const atom of context.relevantAtoms) citable.add(String(atom.id));
    for (const atom of context.openPlans) citable.add(String(atom.id));

    const cleaned: ProposedPlan[] = [];
    let droppedByCitation = 0;
    let droppedByConfidence = 0;
    for (const p of parsed.data.plans) {
      const derivedFrom = p.derived_from.filter((id) => citable.has(id));
      const principlesApplied = p.principles_applied.filter((id) => citable.has(id));
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
      return [missingJudgmentPlan(reason, context.request)];
    }

    return cleaned;
  }
}
