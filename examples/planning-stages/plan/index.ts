/**
 * Reference plan-stage adapter.
 *
 * Third reference stage shipped under examples/planning-stages/. The
 * adapter exports a value implementing PlanningStage<TIn, PlanPayload>;
 * concrete prompts, schemas, and citation-verification heuristics live
 * HERE (in examples/), not in the src/ pipeline runner. The runner
 * walks any ReadonlyArray<PlanningStage> the same way regardless of
 * which stage adapters compose.
 *
 * Capabilities
 * ------------
 * - run(): mechanism scaffold. Routes through host.llm.judge with a
 *   plan-author system prompt and the PlanPayload zod schema. The
 *   per-principal disallowedTools deny-list is resolved by the caller
 *   from the per-principal LLM tool-policy atom and forwarded via
 *   LlmOptions; no deny-list is hardcoded in this module.
 * - outputSchema: zod-validated. Mirrors the existing PLAN_DRAFT plans
 *   shape (title, body, derived_from, principles_applied,
 *   alternatives_rejected, what_breaks_if_revisit, confidence,
 *   delegation) and adds a defensive cost_usd field. Rejects negative
 *   cost (signed-numeric prompt-injection guard), rejects empty plans
 *   array, rejects directive markup smuggled into plan body, rejects
 *   empty derived_from (provenance directive).
 * - audit(): walks every plan's derived_from and principles_applied
 *   atom-id list via host.atoms.get; emits a 'critical' finding when an
 *   id does not resolve. The plan body itself is not parsed for further
 *   citations; PLAN_DRAFT mandates derived_from carries the full
 *   provenance chain, so an id cited in body but absent from
 *   derived_from is already a schema violation upstream.
 *
 * Pipeline gating
 * ---------------
 * The plan stage runs only after the upstream spec stage's audit is
 * clean: the runner halts on any 'critical' finding from the prior
 * stage, so reaching plan-stage is itself the audit_status==clean gate.
 * This module does not re-check spec audit_status; the substrate-level
 * halt is the authoritative signal.
 *
 * Compromise containment
 * ----------------------
 * - A plan-author that emits a payload outside the schema fails at the
 *   runner (not here): the runner runs outputSchema.safeParse before
 *   treating the value as valid.
 * - A plan-author that fabricates a derived_from or principles_applied
 *   atom id falls through audit() as a 'critical' finding; the runner
 *   halts the stage.
 * - A plan-author that smuggles directive markup into a plan body is
 *   rejected by outputSchema regex check before audit even runs.
 * - List-size caps bound the audit walk so an LLM-emitted runaway list
 *   cannot stall the auditor.
 */

import { z } from 'zod';
import type {
  AuditFinding,
  PlanningStage,
  StageContext,
  StageInput,
  StageOutput,
} from '../../../src/runtime/planning-pipeline/index.js';
import type { AtomId } from '../../../src/types.js';

/** Maximum entries per cited-id list; mirrors MAX_CITED_LIST in atom-shapes. */
const MAX_LIST = 256;

/** Maximum plans per emission; mirrors PLAN_DRAFT plans-array max. */
const MAX_PLANS = 5;

/** Maximum length for a plan body; mirrors PLAN_DRAFT body cap. */
const MAX_BODY = 8000;

/** Maximum length for a plan title; mirrors PLAN_DRAFT title cap. */
const MAX_TITLE = 200;

/** Maximum length for short string fields. */
const MAX_STR_SHORT = 500;

/** Maximum length for the delegation reason field; mirrors PLAN_DRAFT. */
const MAX_DELEGATION_REASON = 300;

/** Maximum length for the delegation principal field; mirrors PLAN_DRAFT. */
const MAX_DELEGATION_PRINCIPAL = 200;

/**
 * Reject any directive-markup token an LLM might smuggle into a plan
 * body to re-prompt a downstream stage. Conservative: a literal
 * occurrence of the string is sufficient signal for v1.
 */
const INJECTION_TOKEN = '<system-reminder>';

const alternativeSchema = z.object({
  option: z.string().min(1).max(MAX_TITLE),
  reason: z.string().min(1).max(MAX_STR_SHORT),
});

const delegationSchema = z.object({
  sub_actor_principal_id: z.string().min(1).max(MAX_DELEGATION_PRINCIPAL),
  reason: z.string().min(1).max(MAX_DELEGATION_REASON),
  implied_blast_radius: z.enum([
    'none',
    'docs',
    'tooling',
    'framework',
    'l3-canon-proposal',
  ]),
});

const planEntrySchema = z.object({
  title: z.string().min(1).max(MAX_TITLE),
  body: z
    .string()
    .min(1)
    .max(MAX_BODY)
    .refine((s) => !s.includes(INJECTION_TOKEN), {
      message: 'body contains directive markup that could re-prompt a downstream stage',
    }),
  derived_from: z.array(z.string().min(1)).min(1).max(MAX_LIST),
  principles_applied: z.array(z.string().min(1)).max(MAX_LIST),
  alternatives_rejected: z.array(alternativeSchema).max(MAX_LIST),
  what_breaks_if_revisit: z.string().min(1).max(MAX_STR_SHORT),
  confidence: z.number().min(0).max(1),
  delegation: delegationSchema,
});

export const planPayloadSchema = z.object({
  plans: z.array(planEntrySchema).min(1).max(MAX_PLANS),
  cost_usd: z.number().nonnegative().finite(),
});

export type PlanPayload = z.infer<typeof planPayloadSchema>;

const PLAN_SYSTEM_PROMPT = `You are the plan stage of a deep-planning pipeline.
Synthesize the spec-stage output into a plan that the operator can
approve and dispatch. Each plan carries a title, a markdown body with
"Why this", "Concrete steps", and "Provenance" sections, a derived_from
list of atom ids that already resolve in the system, the
principles_applied subset that the plan claims to satisfy, an
alternatives_rejected list with one-line reasons, a
what_breaks_if_revisit sentence, a confidence score in [0,1], and a
delegation object naming the sub-actor that will implement the plan.
NEVER invent atom ids. Emit ONLY a payload that matches the provided
schema; no prose outside the schema fields.`;

async function runPlan(
  input: StageInput<unknown>,
): Promise<StageOutput<PlanPayload>> {
  // Mechanism scaffold: route through host.llm.judge. The caller is
  // responsible for resolving per-principal disallowedTools from the
  // per-principal LLM tool-policy atom and forwarding via LlmOptions;
  // this module does not hardcode tool-policy.
  const result = await input.host.llm.judge<PlanPayload>(
    // JsonSchema shape; the runtime validation runs against
    // planPayloadSchema in the runner via stage.outputSchema.
    {
      type: 'object',
      properties: {
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              derived_from: { type: 'array', items: { type: 'string' } },
              principles_applied: {
                type: 'array',
                items: { type: 'string' },
              },
              alternatives_rejected: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    option: { type: 'string' },
                    reason: { type: 'string' },
                  },
                  required: ['option', 'reason'],
                },
              },
              what_breaks_if_revisit: { type: 'string' },
              confidence: { type: 'number' },
              delegation: {
                type: 'object',
                properties: {
                  sub_actor_principal_id: { type: 'string' },
                  reason: { type: 'string' },
                  implied_blast_radius: {
                    type: 'string',
                    enum: [
                      'none',
                      'docs',
                      'tooling',
                      'framework',
                      'l3-canon-proposal',
                    ],
                  },
                },
                required: [
                  'sub_actor_principal_id',
                  'reason',
                  'implied_blast_radius',
                ],
              },
            },
            required: [
              'title',
              'body',
              'derived_from',
              'principles_applied',
              'alternatives_rejected',
              'what_breaks_if_revisit',
              'confidence',
              'delegation',
            ],
          },
        },
        cost_usd: { type: 'number' },
      },
      required: ['plans', 'cost_usd'],
    },
    PLAN_SYSTEM_PROMPT,
    {
      pipeline_id: String(input.pipelineId),
      seed_atom_ids: input.seedAtomIds.map(String),
      correlation_id: input.correlationId,
    },
    {
      // Mechanism scaffold: callers compose this stage with their own
      // resolved per-principal disallowedTools (loaded from the
      // per-principal LLM tool-policy atom) and per-stage budget cap
      // (loaded from the per-stage cost-cap policy atom) at invocation
      // time. The defaults below are conservative scaffolding; they are
      // not the canon-driven values.
      model: 'default',
      sandboxed: true,
      max_budget_usd: 1.0,
    },
  );
  const value = result.output;
  const cost_usd = typeof value.cost_usd === 'number' ? value.cost_usd : 0;
  return {
    value,
    cost_usd,
    duration_ms: result.metadata.latency_ms,
    atom_type: 'plan',
  };
}

/**
 * Categorise a fetched atom for citation-audit purposes. An atom that
 * fails any of {present, untainted, not-superseded} is non-authoritative
 * and a citation pointing at it is treated as a critical finding equal
 * to a fabricated id, because the LLM cited a state that does not hold.
 */
type AtomAuthorityStatus =
  | 'authoritative'
  | 'missing'
  | 'tainted'
  | 'superseded';

function classifyAtomAuthority(
  atom: Awaited<ReturnType<StageContext['host']['atoms']['get']>>,
): AtomAuthorityStatus {
  if (atom === null) return 'missing';
  if (atom.taint !== 'clean') return 'tainted';
  if (atom.superseded_by.length > 0) return 'superseded';
  return 'authoritative';
}

function citationFinding(
  planTitle: string,
  field: 'derived_from' | 'principles_applied',
  id: string,
  status: Exclude<AtomAuthorityStatus, 'authoritative'>,
): AuditFinding {
  const reason: Record<typeof status, string> = {
    missing: 'does not resolve via host.atoms.get',
    tainted: 'resolves to an atom whose taint is not clean',
    superseded: 'resolves to an atom that has been superseded',
  };
  return {
    severity: 'critical',
    category: 'fabricated-cited-atom',
    message:
      `Plan "${planTitle}" cites atom id "${id}" in ${field} which `
      + `${reason[status]}. Mitigates the drafter-citation-verification `
      + 'failure mode at the substrate level.',
    cited_atom_ids: [id as AtomId],
    cited_paths: [],
  };
}

async function auditPlan(
  output: PlanPayload,
  ctx: StageContext,
): Promise<ReadonlyArray<AuditFinding>> {
  const findings: AuditFinding[] = [];
  for (const plan of output.plans) {
    // Verify every derived_from atom-id is authoritative: present,
    // untainted, and not superseded. Any failure is a critical finding;
    // the runner halts the stage. A tainted or superseded citation is
    // equivalent to a fabricated id because the LLM cited a state that
    // does not hold under arbitration.
    for (const id of plan.derived_from) {
      const atom = await ctx.host.atoms.get(id as AtomId);
      const status = classifyAtomAuthority(atom);
      if (status !== 'authoritative') {
        findings.push(citationFinding(plan.title, 'derived_from', id, status));
      }
    }
    // Verify every principles_applied atom-id resolves authoritatively.
    // principles_applied is a SUBSET of derived_from per PLAN_DRAFT, but
    // a misaligned LLM may emit ids in principles_applied not present in
    // derived_from; audit independently to catch that drift.
    for (const id of plan.principles_applied) {
      const atom = await ctx.host.atoms.get(id as AtomId);
      const status = classifyAtomAuthority(atom);
      if (status !== 'authoritative') {
        findings.push(
          citationFinding(plan.title, 'principles_applied', id, status),
        );
      }
    }
  }
  return findings;
}

export const planStage: PlanningStage<unknown, PlanPayload> = {
  name: 'plan-stage',
  outputSchema: planPayloadSchema,
  run: runPlan,
  audit: auditPlan,
};
