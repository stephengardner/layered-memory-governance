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
import { buildJudgeSchema } from '../lib/zod-to-judge-schema.js';

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
const MAX_DELEGATION_REASON = 1000;

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

/**
 * JSON-schema shape passed to host.llm.judge. Derived mechanically
 * from `planPayloadSchema` via the shared `buildJudgeSchema` helper,
 * so a new bounded field added to the zod schema produces a bounded
 * JSON-schema field with no second edit. The helper covers the
 * supported zod surface (object/string/number/boolean/enum/array
 * with min and max bounds, plus optional/nullable/effects wrappers)
 * and throws on anything outside it; that throw is the substrate
 * signal that a stage adopted a new zod shape and the helper must be
 * extended rather than worked around.
 *
 * The parity test in test/examples/planning-stages/schema-parity.test.ts
 * walks both schemas to assert agreement on every bounded field, so a
 * helper-level regression that loosens the JSON-schema produces a
 * single-test failure pointing at the forgotten field. Dogfeed-7
 * (pipeline-cto-1777614599370-8xgy3p) halted at plan-stage because
 * what_breaks_if_revisit was 500+ chars under a JSON-schema with no
 * maxLength; the helper-derived schema enforces the bound.
 *
 * Exported for the parity test; the runStage function below references
 * this same constant so a single edit lands in both the LLM-time fence
 * and the parity assertion.
 */
export const PLAN_JUDGE_SCHEMA = buildJudgeSchema(planPayloadSchema);

/**
 * Plan system prompt.
 *
 * Exported so the contract-tests can assert on the citation-grounding
 * language. Two HARD-CONSTRAINT fences live here:
 *
 *   (1) Atom-id citation grounding: every atom-id placed in
 *       derived_from and principles_applied MUST appear in
 *       data.verified_cited_atom_ids. The dogfeed of 2026-04-30
 *       halted on this gate because the unconstrained prompt invited
 *       plausible-but-invented principle ids; the auditor caught
 *       them and surfaced critical findings. The fix added the
 *       positive grounding signal mirrored from the brainstorm
 *       stage's `verified_seed_atom_ids` pattern.
 *
 *   (2) Sub-actor delegation grounding: delegation.sub_actor_principal_id
 *       MUST appear in data.verified_sub_actor_principal_ids. The
 *       set is the seed operator-intent's
 *       metadata.trust_envelope.allowed_sub_actors -- the per-run
 *       authoritative list of sub-actors the autonomous-intent flow
 *       will auto-approve. Without this fence the drafter chose
 *       arbitrary strings: dogfeed-4 picked 'plan-dispatcher' (a
 *       real principal id but the pipeline's OWN dispatch-stage
 *       principal, not an executable sub-actor) and dogfeed-5 picked
 *       'pol-llm-tool-policy-code-author' (a POLICY ATOM ID, not a
 *       principal id at all). Both shapes pass the freeform-string
 *       schema and only fail later when the auto-approve check
 *       skips the plan with sub-actor-not-allowed. Surfacing the
 *       fence at draft-time means the LLM never gets a chance to
 *       guess; if no allowed sub-actor fits the plan, the plan is
 *       incomplete and the drafter should not emit it.
 */
export const PLAN_SYSTEM_PROMPT = `You are the plan stage of a deep-planning pipeline.
Synthesize the spec-stage output into a plan that the operator can
approve and dispatch. Each plan carries a title, a markdown body with
"Why this", "Concrete steps", and "Provenance" sections, a derived_from
list of atom ids that already resolve in the system, the
principles_applied subset that the plan claims to satisfy, an
alternatives_rejected list with one-line reasons, a
what_breaks_if_revisit sentence, a confidence score in [0,1], and a
delegation object naming the sub-actor that will implement the plan.

HARD CONSTRAINT on semantic faithfulness to operator-intent: the
literal text of the operator's seed request is supplied in
data.operator_intent_content, and the upstream spec output is
supplied in data.spec_output. The plan title and body MUST be
semantically faithful to data.operator_intent_content -- the
literal request is the source of truth. Do NOT abstract beyond it,
do NOT generalise into a meta-task, do NOT plan work the operator
did not ask for. If the literal request is "add a one-line README
note", the plan title must describe a one-line README addition and
the body's "Concrete steps" must specify the README edit concretely;
the plan must NOT propose a meta-task about the pipeline itself,
must NOT pivot to "research-then-propose mode", must NOT propose
adding fences, dials, or process changes the operator did not ask
for. The spec_output is context, not a re-mandate; when the spec
has drifted, anchor back to the literal intent. When
data.operator_intent_content is empty the caller did not compute an
anchor; fall back to data.spec_output for context.

HARD CONSTRAINT on atom-id citations: every atom-id you place in
derived_from and principles_applied MUST appear in
data.verified_cited_atom_ids. If a principle or supporting atom you
would cite is not in that set, OMIT the citation rather than guess.
Inventing or paraphrasing an atom-id outside the verified set produces
a critical audit finding and halts the stage. principles_applied is a
subset of derived_from; both are bounded by the verified set.

HARD CONSTRAINT on delegation.sub_actor_principal_id: the value MUST
appear in data.verified_sub_actor_principal_ids. That set is the seed
operator-intent's allowed sub-actors and is the only authoritative
list of executable principals for this run. Do NOT name the
pipeline's own stage principals (e.g. plan-dispatcher, spec-author,
brainstorm-actor); they are stage actors, not implementation
sub-actors. Do NOT name a policy atom id (e.g. anything starting
with pol-); policy atoms are not principals. If no allowed sub-actor
fits the plan you would emit, the plan is incomplete and you must
NOT emit it. Inventing or paraphrasing a sub-actor outside the
verified set produces a critical audit finding and halts the stage.

Emit ONLY a payload that matches the provided schema; no prose
outside the schema fields.`;

async function runPlan(
  input: StageInput<unknown>,
): Promise<StageOutput<PlanPayload>> {
  // Mechanism scaffold: route through host.llm.judge. The caller is
  // responsible for resolving per-principal disallowedTools from the
  // per-principal LLM tool-policy atom and forwarding via LlmOptions;
  // this module does not hardcode tool-policy.
  const result = await input.host.llm.judge<PlanPayload>(
    // PLAN_JUDGE_SCHEMA mirrors the zod planPayloadSchema's bounds at
    // the LLM-time fence. See the constant declaration for the parity
    // contract and the dogfeed-7 evidence that motivated the bounds.
    PLAN_JUDGE_SCHEMA,
    PLAN_SYSTEM_PROMPT,
    {
      pipeline_id: String(input.pipelineId),
      seed_atom_ids: input.seedAtomIds.map(String),
      // Citation-grounding fence: the LLM is constrained by
      // PLAN_SYSTEM_PROMPT to cite ONLY atom-ids that appear in this
      // array, in derived_from and principles_applied. Computed by
      // the runner's caller (runDeepPipeline) from the seed atoms
      // plus the canon atoms applicable at the planning principal's
      // scope. Empty array means the caller did not compute a set;
      // the prompt still instructs the LLM to cite only from this
      // set, so an empty set effectively forbids atom-id citations
      // entirely. The post-stage auditor continues to verify each
      // citation against host.atoms.get and emits a critical finding
      // on fabrication or non-authoritative resolution.
      verified_cited_atom_ids: input.verifiedCitedAtomIds.map(String),
      // Sub-actor-grounding fence: the LLM is constrained by
      // PLAN_SYSTEM_PROMPT to name delegation.sub_actor_principal_id
      // ONLY from this array. Computed by the runner's caller
      // (runDeepPipeline) from the seed operator-intent's
      // metadata.trust_envelope.allowed_sub_actors -- the intent
      // envelope IS the per-run authoritative list of sub-actors,
      // and matches the same set the auto-approve evaluator checks
      // against. An empty array effectively forbids any delegation
      // (and the prompt instructs the LLM not to emit a plan it
      // cannot delegate). The post-stage auditor walks the emitted
      // delegation against the same set and emits a critical
      // finding on out-of-set ids.
      verified_sub_actor_principal_ids:
        input.verifiedSubActorPrincipalIds.map(String),
      // Semantic-faithfulness anchor: the literal operator-intent
      // content the runner read at preflight. The HARD-CONSTRAINT
      // block in PLAN_SYSTEM_PROMPT instructs the LLM to keep the
      // plan title and body semantically faithful to this string,
      // anchoring back when the spec drifted. Without the anchor, the
      // plan compounds the brainstorm + spec abstractions; dogfeed-8
      // of 2026-04-30 produced a plan title "Dogfeed deep-planning
      // pipeline in research-then-propose mode under default-deny +
      // advisory citations + $1 cap" when the literal request was
      // "Add a one-line note to the README explaining what the deep
      // planning pipeline does" -- a docs-only change. Empty string
      // when the runner caller did not compute a value; the prompt
      // instructs the LLM to fall back to data.spec_output in that
      // case.
      operator_intent_content: input.operatorIntentContent,
      correlation_id: input.correlationId,
      // Forward the upstream spec-stage payload so the plan synthesises
      // against the goal, body, cited_paths, and cited_atom_ids the
      // spec produced. Without this, the model sees only correlation
      // metadata and plans in a vacuum.
      spec_output: input.priorOutput ?? null,
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
  // Build a Set view of the verified citation set for O(1) membership
  // checks below. Empty set => skip the closure-of-citations check
  // and fall back to resolvability-only (legacy callers, including
  // direct audit() invocations from tests, do not compute a verified
  // set; they rely on the existing fabricated-cited-atom check
  // alone).
  const verifiedSet = new Set(ctx.verifiedCitedAtomIds.map(String));
  const enforceVerifiedSet = verifiedSet.size > 0;
  // Same shape for the verified sub-actor principal-id set. Empty
  // set => skip the delegation closure check entirely (legacy callers
  // and direct audit() invocations from tests do not compute the
  // set). When non-empty, the LLM was prompted to name only ids in
  // this set, and the auditor enforces the same closure.
  const verifiedSubActorSet = new Set(
    ctx.verifiedSubActorPrincipalIds.map(String),
  );
  const enforceVerifiedSubActorSet = verifiedSubActorSet.size > 0;
  for (const plan of output.plans) {
    // Verify every derived_from atom-id is authoritative: present,
    // untainted, and not superseded. Any failure is a critical finding;
    // the runner halts the stage. A tainted or superseded citation is
    // equivalent to a fabricated id because the LLM cited a state that
    // does not hold under arbitration.
    const derivedFromSet = new Set(plan.derived_from.map(String));
    for (const id of plan.derived_from) {
      const atom = await ctx.host.atoms.get(id as AtomId);
      const status = classifyAtomAuthority(atom);
      if (status !== 'authoritative') {
        findings.push(citationFinding(plan.title, 'derived_from', id, status));
        continue;
      }
      // Closure-of-citations: a derived_from id that resolves but
      // is NOT in the verified set means the LLM grounded a citation
      // outside the input contract, which is the same failure mode
      // as fabrication (the auditor cannot distinguish "LLM made up
      // a plausible id that accidentally exists" from "LLM honestly
      // cited an in-set atom" without the verified set as a
      // referent).
      if (enforceVerifiedSet && !verifiedSet.has(String(id))) {
        findings.push({
          severity: 'critical',
          category: 'non-verified-cited-atom',
          message:
            `Plan "${plan.title}" cites atom id "${id}" in derived_from `
            + 'which resolves but is NOT in the verified citation set. The '
            + 'plan-stage citation fence enforces the closure-of-citations '
            + 'property at the audit layer, not just the prompt layer.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
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
        continue;
      }
      // Subset-rule enforcement: the prompt promises
      // principles_applied is a subset of derived_from, but neither
      // the schema nor the audit checked it before. A clean atom in
      // principles_applied that is NOT in derived_from breaks the
      // plan's provenance contract.
      if (!derivedFromSet.has(String(id))) {
        findings.push({
          severity: 'critical',
          category: 'principles-not-in-derived-from',
          message:
            `Plan "${plan.title}" cites atom id "${id}" in `
            + 'principles_applied which is NOT present in derived_from. '
            + 'principles_applied must be a subset of derived_from per '
            + 'the plan-stage provenance contract.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
        continue;
      }
      if (enforceVerifiedSet && !verifiedSet.has(String(id))) {
        findings.push({
          severity: 'critical',
          category: 'non-verified-cited-atom',
          message:
            `Plan "${plan.title}" cites atom id "${id}" in `
            + 'principles_applied which resolves but is NOT in the '
            + 'verified citation set. The plan-stage citation fence '
            + 'enforces the closure-of-citations property at the audit '
            + 'layer, not just the prompt layer.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
      }
    }
    // Sub-actor closure check: delegation.sub_actor_principal_id MUST
    // appear in the verified sub-actor principal-id set when the
    // runner supplied one. Mirrors the cited-atom closure pattern
    // above; the prompt fences the LLM at draft-time and this audit
    // fences at the substrate layer so a prompt drift cannot quietly
    // ship an out-of-set delegation. Empty verified set short-circuits
    // (legacy / test callers without a set rely on the
    // single-pass auto-approve gate alone).
    if (enforceVerifiedSubActorSet) {
      const subActor = plan.delegation.sub_actor_principal_id;
      if (!verifiedSubActorSet.has(String(subActor))) {
        findings.push({
          severity: 'critical',
          category: 'non-verified-sub-actor-principal-id',
          message:
            `Plan "${plan.title}" delegates to sub_actor_principal_id `
            + `"${subActor}" which is NOT in the verified sub-actor `
            + 'set sourced from the seed operator-intent\'s '
            + 'trust_envelope.allowed_sub_actors. The plan-stage '
            + 'delegation fence enforces the per-run sub-actor '
            + 'allowlist at the audit layer, mirroring the citation '
            + 'closure check. Surfaced when the LLM names a stage '
            + 'principal (e.g. plan-dispatcher), a policy atom id '
            + '(e.g. pol-llm-tool-policy-code-author), or any other '
            + 'string outside the envelope-authorised set.',
          cited_atom_ids: [],
          cited_paths: [],
        });
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
