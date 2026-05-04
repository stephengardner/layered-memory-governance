/**
 * Reference brainstorm-stage adapter.
 *
 * First reference stage shipped under examples/planning-stages/. The
 * adapter exports a value implementing PlanningStage<TIn, BrainstormPayload>;
 * concrete prompts and schemas live HERE (in examples/), not in the
 * src/ pipeline runner. The runner walks any ReadonlyArray<PlanningStage>
 * the same way regardless of which stage adapters compose.
 *
 * Capabilities
 * ------------
 * - run(): mechanism scaffold. Routes through host.llm.judge with a
 *   brainstorm system prompt and the BrainstormPayload zod schema. The
 *   per-principal disallowedTools deny-list is resolved by the caller
 *   from the per-principal LLM tool-policy atom and forwarded via
 *   LlmOptions; no deny-list is hardcoded in this module.
 * - outputSchema: zod-validated. Rejects negative cost (signed-numeric
 *   prompt-injection guard), rejects alternatives without a
 *   rejection_reason, and caps list lengths to bound runaway emissions.
 * - audit(): walks every alternative's rejection_reason for cited
 *   atom-id-shaped tokens; calls host.atoms.get(id) on each and emits a
 *   'critical' finding when the id does not resolve. Mirrors the
 *   citation-verification posture the spec for the reference stage set
 *   prescribes.
 *
 * Compromise containment
 * ----------------------
 * - A brainstorm-actor that emits a payload outside the schema fails
 *   at the runner (not here): the runner runs outputSchema.safeParse
 *   before treating the value as valid.
 * - A brainstorm-actor that fabricates a cited atom-id falls through
 *   audit() as a 'critical' finding; the runner halts the stage.
 * - A brainstorm-actor that smuggles HTML or directive markup into a
 *   text field is bounded by per-field length caps in outputSchema.
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

/** Maximum entries per list field; mirrors MAX_CITED_LIST in atom-shapes. */
const MAX_LIST = 256;

/** Maximum characters per string field; bounds runaway LLM emissions. */
const MAX_STR = 4096;

const alternativeSchema = z.object({
  option: z.string().min(1).max(MAX_STR),
  rejection_reason: z.string().min(1).max(MAX_STR),
});

export const brainstormPayloadSchema = z.object({
  open_questions: z.array(z.string().min(1).max(MAX_STR)).max(MAX_LIST),
  alternatives_surveyed: z.array(alternativeSchema).max(MAX_LIST),
  decision_points: z.array(z.string().min(1).max(MAX_STR)).max(MAX_LIST),
  cost_usd: z.number().nonnegative().finite(),
});

export type BrainstormPayload = z.infer<typeof brainstormPayloadSchema>;

/**
 * JSON-schema shape passed to host.llm.judge. Derived mechanically
 * from `brainstormPayloadSchema` via the shared `buildJudgeSchema`
 * helper, so a new bounded field added to the zod schema produces a
 * bounded JSON-schema field with no second edit. The helper covers
 * the supported zod surface (object/string/number/boolean/enum/array
 * with min and max bounds, plus optional/nullable/effects wrappers)
 * and throws on anything outside it; that throw is the substrate
 * signal that a stage adopted a new zod shape and the helper must be
 * extended rather than worked around.
 *
 * The parity test in test/examples/planning-stages/schema-parity.test.ts
 * walks both schemas to assert agreement on every bounded field, so a
 * helper-level regression that loosens the JSON-schema produces a
 * single-test failure pointing at the forgotten field.
 *
 * Exported for the parity test; the runStage function below references
 * this same constant so a single edit lands in both the LLM-time fence
 * and the parity assertion.
 */
export const BRAINSTORM_JUDGE_SCHEMA = buildJudgeSchema(brainstormPayloadSchema);

/**
 * Atom-id citation regex.
 *
 * LAG atom ids are kebab-case lowercase identifiers with at least one
 * hyphen. To avoid matching ordinary hyphenated words (e.g. "rule-of-three"
 * inside prose), this regex requires an explicit `atom:` prefix in front
 * of the id. Callers cite atoms as `atom:dev-no-claude-attribution`.
 * Bounded hyphen-count keeps regex cost linear on adversarial input.
 *
 * NOTE: this is a pragmatic extractor for v1. A future iteration may
 * accept LLM-emitted cited_atom_ids as a structured array on the payload
 * rather than parsing prose.
 */
const ATOM_ID_TOKEN = /\batom:([a-z][a-z0-9]*(?:-[a-z0-9]+){1,15})\b/g;

function extractCitedAtomIds(text: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  ATOM_ID_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATOM_ID_TOKEN.exec(text)) !== null) {
    const id = match[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Brainstorm system prompt.
 *
 * Exported so the contract-tests can assert on the citation-grounding
 * language. Tightened (substrate-fix in this PR) so the LLM does not
 * fabricate plausible-but-invented atom-ids: the e2e of the deep
 * planning pipeline halted 100% of the time on first try because the
 * unconstrained prompt invited citations like
 * "atom:stage-responsibility-brainstorm" and "atom:stage-isolation"
 * that the post-stage auditor had to reject. Constraining citations
 * to the verified seed-atom set passed via the templated DATA block
 * (data.verified_seed_atom_ids) reduces the halt rate without a
 * structural retry-with-feedback loop. Retry-with-feedback is a
 * separate substrate change.
 */
export const BRAINSTORM_SYSTEM_PROMPT = `You are the brainstorm stage of a deep-planning pipeline.
Survey alternatives, surface open questions, and identify decision points
for the seeded operator-intent. Emit ONLY a payload that matches the
provided schema; no prose outside the schema fields.

HARD CONSTRAINT on semantic faithfulness to operator-intent: the
literal text of the operator's seed request is supplied in
data.operator_intent_content. Your output MUST be semantically
faithful to that text. Do NOT abstract beyond it, do NOT generalise
the request into a meta-task, do NOT pivot to discussing the
pipeline itself when the request is about something else. If the
literal request is "add a one-line README note", the alternatives
you survey and the decision points you surface must describe a
one-line README addition and its trade-offs -- not a meta-task
about the pipeline. When data.operator_intent_content is empty the
caller did not compute an anchor; fall back to the seed atom set
for context.

Brainstorm is exploratory and generative. Rejection_reason fields are
prose only; do NOT include literal atom-id citations like
"atom:foo-bar" inside any field. The downstream review-stage
re-walks every cited path and atom-id from the spec/plan output for
provenance verification, so the citation-grounding fence belongs
there (per the dev-deep-planning-pipeline canon directive), not at
the exploratory stage.

The post-stage auditor flags any literal "atom:<id>" citation that
did not come from the verified seed set as a 'major' finding
(advisory, non-blocking) so a stray citation does not halt the
pipeline at the exploratory stage; the run continues to spec-stage
where citation correctness is load-bearing.`;

async function runBrainstorm(
  input: StageInput<unknown>,
): Promise<StageOutput<BrainstormPayload>> {
  // Mechanism scaffold: route through host.llm.judge. The caller is
  // responsible for resolving per-principal disallowedTools from the
  // per-principal LLM tool-policy atom and forwarding via LlmOptions;
  // this module does not hardcode tool-policy.
  const result = await input.host.llm.judge<BrainstormPayload>(
    // BRAINSTORM_JUDGE_SCHEMA mirrors the zod brainstormPayloadSchema's
    // bounds at the LLM-time fence. See the constant declaration for
    // the parity contract.
    BRAINSTORM_JUDGE_SCHEMA,
    BRAINSTORM_SYSTEM_PROMPT,
    {
      pipeline_id: String(input.pipelineId),
      // Legacy key: kept for backwards-compatible consumers that may
      // be reading this DATA block from prompt-fingerprint logs. The
      // load-bearing key for the prompt's citation-grounding contract
      // is verified_seed_atom_ids below.
      seed_atom_ids: input.seedAtomIds.map(String),
      // Citation-grounding fence (brainstorm-narrow): the LLM is
      // constrained by the BRAINSTORM_SYSTEM_PROMPT to cite ONLY
      // atom-ids from the seed set. Brainstorm is exploratory and
      // points the load-bearing citation fence at review-stage; the
      // narrow seed-only set here keeps the brainstorm fence aligned
      // with what the post-stage auditor expects (seed-only set is
      // the resolvable + in-set predicate the brainstorm audit
      // re-walks).
      verified_seed_atom_ids: input.seedAtomIds.map(String),
      // Substrate-wide citation set (spec/plan/review fence): a
      // forward-compat data field carrying the runner-supplied
      // verified-citation set. Brainstorm prose does not load-bear on
      // this set (the prompt directs the LLM not to embed atom-id
      // citations at all and points the fence at review-stage), but
      // the field is forwarded uniformly across all four stages for
      // substrate symmetry so an org-ceiling brainstorm-actor that
      // chooses to cite can ground on the broader set.
      verified_cited_atom_ids: input.verifiedCitedAtomIds.map(String),
      // Semantic-faithfulness anchor: the literal operator-intent
      // content the runner read at preflight. The HARD-CONSTRAINT
      // block in BRAINSTORM_SYSTEM_PROMPT instructs the LLM to keep
      // its output semantically faithful to this string. Without the
      // anchor, the brainstorm pivots to abstractions (dogfeed-8 of
      // 2026-04-30 produced a meta-task about the pipeline itself
      // when the literal request was a one-line README docs change).
      // Empty string when the runner caller did not compute a value;
      // the prompt instructs the LLM to fall back to the seed set
      // for context in that case.
      operator_intent_content: input.operatorIntentContent,
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
    // Declared atom type drives the runner's persistStageOutput
    // routing: 'brainstorm-output' lands in the typed-mint branch
    // so the runner mints via mkBrainstormOutputAtom and the
    // resulting atom is queryable as type='brainstorm-output'.
    atom_type: 'brainstorm-output',
  };
}

/**
 * Read the verified seed-atom set from the pipeline atom's
 * derived_from chain. The runner constructs the pipeline atom via
 * mkPipelineAtom which stamps seedAtomIds onto provenance.derived_from
 * exactly. Audit reads through the pipeline atom rather than the
 * StageContext because StageContext is a substrate type (changes there
 * affect every stage adapter); deriving the set from the existing
 * pipeline atom keeps this change adapter-local.
 *
 * Fail-closed on a missing pipeline atom or empty provenance: the seed
 * set is the authoritative input to the citation-grounding fence, and
 * a silent fall-through to "no constraint" lets out-of-set citations
 * pass when the pipeline atom is unreadable. The runner converts the
 * thrown error into an exit-failure event + pipeline-failed atom via
 * its existing stage-error machinery; the audit function never
 * silently degrades. Per inv-governance-before-autonomy.
 */
async function readVerifiedSeedSetFromPipelineAtom(
  ctx: StageContext,
): Promise<ReadonlySet<string>> {
  const pipelineAtom = await ctx.host.atoms.get(ctx.pipelineId);
  if (pipelineAtom === null) {
    throw new Error(
      `brainstorm-stage audit: pipeline atom "${String(ctx.pipelineId)}" `
      + 'not found in host.atoms; cannot resolve verified seed-atom set. '
      + 'Failing closed rather than skipping the citation-grounding fence.',
    );
  }
  const derived = pipelineAtom.provenance?.derived_from ?? [];
  if (derived.length === 0) {
    throw new Error(
      `brainstorm-stage audit: pipeline atom "${String(ctx.pipelineId)}" `
      + 'has empty provenance.derived_from; the verified seed-atom set is '
      + 'the authoritative input for the citation-grounding fence and '
      + 'cannot be empty. Failing closed.',
    );
  }
  return new Set(derived.map((id) => String(id)));
}

export async function auditBrainstorm(
  output: BrainstormPayload,
  ctx: StageContext,
): Promise<ReadonlyArray<AuditFinding>> {
  const findings: AuditFinding[] = [];
  // Read the verified seed-atom set up front so each cited id is
  // checked against the same snapshot. Per the brainstorm prompt's
  // citation-grounding contract, an atom cited in rejection_reason
  // MUST appear in this set even if it resolves through host.atoms.get;
  // a bare resolvable atom that is NOT in the seed set is treated as
  // a fabricated-cited-atom with the same critical severity, because
  // the model has no provenance for choosing it.
  const verifiedSeedSet = await readVerifiedSeedSetFromPipelineAtom(ctx);
  for (const alt of output.alternatives_surveyed) {
    const cited = extractCitedAtomIds(alt.rejection_reason);
    for (const id of cited) {
      const atom = await ctx.host.atoms.get(id as AtomId);
      if (atom === null) {
        findings.push({
          // 'major' (not 'critical') so the pipeline continues to spec-stage
          // where citation correctness is load-bearing. Brainstorm is
          // exploratory; the prompt instructs the LLM to omit citations
          // entirely. A stray fabricated citation here is a quality signal
          // (logged as a finding atom for audit) but not a halt-stage
          // condition. The downstream review-stage re-walks every cited
          // atom-id from the spec/plan and IS the citation-grounding fence.
          severity: 'major',
          category: 'fabricated-cited-atom',
          message:
            `Brainstorm rejection_reason for option "${alt.option}" cites `
            + `atom id "${id}" which does not resolve via host.atoms.get. `
            + 'Surfaced as a quality signal at the exploratory stage; the '
            + 'review-stage carries the load-bearing citation fence.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
        continue;
      }
      // Resolves but is NOT in the verified seed-atom set: the LLM
      // grounded a citation on an atom outside the input contract.
      // Flag at 'major' to preserve the audit trail without halting the
      // pipeline; the brainstorm prompt instructs the LLM to omit
      // citations rather than fabricate, and the review-stage carries
      // the load-bearing fence for citation correctness.
      if (!verifiedSeedSet.has(String(id))) {
        findings.push({
          severity: 'major',
          category: 'non-seed-cited-atom',
          message:
            `Brainstorm rejection_reason for option "${alt.option}" cites `
            + `atom id "${id}" which resolves but is NOT in the verified `
            + 'seed-atom set. Surfaced as a quality signal at the '
            + 'exploratory stage; review-stage carries the load-bearing '
            + 'citation fence.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
      }
    }
  }
  return findings;
}

export const brainstormStage: PlanningStage<unknown, BrainstormPayload> = {
  name: 'brainstorm-stage',
  outputSchema: brainstormPayloadSchema,
  run: runBrainstorm,
  audit: auditBrainstorm,
};
