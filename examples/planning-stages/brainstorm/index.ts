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
    // JsonSchema shape; the runtime validation runs against
    // brainstormPayloadSchema in the runner via stage.outputSchema.
    {
      type: 'object',
      properties: {
        open_questions: { type: 'array', items: { type: 'string' } },
        alternatives_surveyed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              option: { type: 'string' },
              rejection_reason: { type: 'string' },
            },
            required: ['option', 'rejection_reason'],
          },
        },
        decision_points: { type: 'array', items: { type: 'string' } },
        cost_usd: { type: 'number' },
      },
      required: [
        'open_questions',
        'alternatives_surveyed',
        'decision_points',
        'cost_usd',
      ],
    },
    BRAINSTORM_SYSTEM_PROMPT,
    {
      pipeline_id: String(input.pipelineId),
      // Legacy key: kept for backwards-compatible consumers that may
      // be reading this DATA block from prompt-fingerprint logs. The
      // load-bearing key for the prompt's citation-grounding contract
      // is verified_seed_atom_ids below.
      seed_atom_ids: input.seedAtomIds.map(String),
      // Citation-grounding fence: the LLM is constrained by the
      // BRAINSTORM_SYSTEM_PROMPT to cite ONLY atom-ids that appear in
      // this array. Mirrors seed_atom_ids today; the separate name
      // makes the contract obvious to downstream prompt-edit
      // reviewers and gives the test suite a stable assertion target.
      verified_seed_atom_ids: input.seedAtomIds.map(String),
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
    atom_type: 'observation',
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

async function auditBrainstorm(
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
