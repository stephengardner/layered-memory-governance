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

Citation grounding (HARD CONSTRAINT):
- The DATA block contains a "verified seed atom set" under
  data.verified_seed_atom_ids. This array is the ONLY authoritative
  list of atom-ids you have been shown.
- When you cite an atom inside an alternative's rejection_reason, you
  MUST cite ONLY ids that appear in data.verified_seed_atom_ids.
- Citations use the explicit prefix "atom:" (e.g.
  "atom:dev-no-claude-attribution"), NOT bare hyphenated tokens, so
  the post-stage auditor can distinguish citations from prose.
- If you cannot ground a claim in an id from the verified seed atom
  set, OMIT the citation rather than guess. A rejection_reason
  without a citation is preferable to a fabricated atom-id.

Self-check (REQUIRED before emitting):
- Walk every atom-id appearing in your output (rejection_reason
  fields, decision_points, open_questions). For each, verify the id
  appears literally in data.verified_seed_atom_ids. If it does not,
  rewrite the field to omit the citation before emitting.`;

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
 * pipeline atom keeps this change adapter-local. Returns an empty set
 * when the pipeline atom is unreadable so the auditor degrades to its
 * resolvability-only behaviour rather than failing closed on a
 * read error.
 */
async function readVerifiedSeedSetFromPipelineAtom(
  ctx: StageContext,
): Promise<ReadonlySet<string>> {
  const pipelineAtom = await ctx.host.atoms.get(ctx.pipelineId);
  if (pipelineAtom === null) return new Set<string>();
  const derived = pipelineAtom.provenance?.derived_from ?? [];
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
          severity: 'critical',
          category: 'fabricated-cited-atom',
          message:
            `Brainstorm rejection_reason for option "${alt.option}" cites `
            + `atom id "${id}" which does not resolve via host.atoms.get. `
            + 'Mitigates the drafter-citation-verification failure mode at '
            + 'the substrate level.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
        continue;
      }
      // Resolves but is NOT in the verified seed-atom set: the LLM
      // grounded a citation on an atom outside the input contract.
      // Flag with the same critical severity so the runner halts;
      // the prompt explicitly tells the LLM to cite ONLY ids from
      // verified_seed_atom_ids.
      if (verifiedSeedSet.size > 0 && !verifiedSeedSet.has(String(id))) {
        findings.push({
          severity: 'critical',
          category: 'non-seed-cited-atom',
          message:
            `Brainstorm rejection_reason for option "${alt.option}" cites `
            + `atom id "${id}" which resolves but is NOT in the verified `
            + 'seed-atom set passed via the pipeline atom. The brainstorm '
            + 'prompt restricts citations to the seed set; an out-of-set '
            + 'citation is treated as ungrounded and halts the stage.',
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
