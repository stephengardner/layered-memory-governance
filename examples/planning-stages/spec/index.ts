/**
 * Reference spec-stage adapter.
 *
 * Second reference stage shipped under examples/planning-stages/. The
 * adapter exports a value implementing PlanningStage<TIn, SpecPayload>;
 * concrete prompts, schemas, and citation-verification heuristics live
 * HERE (in examples/), not in the src/ pipeline runner. The runner
 * walks any ReadonlyArray<PlanningStage> the same way regardless of
 * which stage adapters compose.
 *
 * Capabilities
 * ------------
 * - run(): mechanism scaffold. Routes through host.llm.judge with a
 *   spec-author system prompt and the SpecPayload zod schema. The
 *   per-principal disallowedTools deny-list is resolved by the caller
 *   from the per-principal LLM tool-policy atom and forwarded via
 *   LlmOptions; no deny-list is hardcoded in this module.
 * - outputSchema: zod-validated. Rejects negative cost (signed-numeric
 *   prompt-injection guard), rejects empty goal, rejects directive
 *   markup smuggled into the body, and caps list lengths to bound
 *   runaway emissions.
 * - audit(): walks every cited atom id via host.atoms.get and every
 *   cited path via fs.access; emits a 'critical' finding when an id
 *   does not resolve or a path is unreachable. Total bytes touched per
 *   audit run is bounded by per-list caps from the schema and a
 *   per-audit byte cap on file reads when read content is examined
 *   (this v1 only checks reachability via fs.access; future iterations
 *   may extend to substring-grep with a hard byte cap).
 *
 * Compromise containment
 * ----------------------
 * - A spec-author that emits a payload outside the schema fails at
 *   the runner (not here): the runner runs outputSchema.safeParse
 *   before treating the value as valid.
 * - A spec-author that fabricates a cited atom id or path falls
 *   through audit() as a 'critical' finding; the runner halts the
 *   stage.
 * - A spec-author that smuggles directive markup into body is
 *   rejected by outputSchema regex check before audit even runs.
 * - List-size caps bound the audit walk so an LLM-emitted runaway
 *   list cannot stall the auditor.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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

/**
 * Maximum body length. Spec body is prose-shaped and may be longer than
 * a typical field, but is still bounded so a runaway emission cannot
 * exhaust the audit pass or downstream consumers.
 */
const MAX_BODY = 64 * 1024;

/**
 * Reject any directive-markup token an LLM might smuggle into the body
 * to re-prompt a downstream stage. Conservative: a literal occurrence
 * of the string is sufficient signal for v1; future iterations may
 * extend to a wider markup taxonomy.
 */
const INJECTION_TOKEN = '<system-reminder>';

const alternativeSchema = z.object({
  option: z.string().min(1).max(MAX_STR),
  reason: z.string().min(1).max(MAX_STR),
});

export const specPayloadSchema = z.object({
  goal: z.string().min(1).max(MAX_STR),
  body: z
    .string()
    .min(1)
    .max(MAX_BODY)
    .refine((s) => !s.includes(INJECTION_TOKEN), {
      message: 'body contains directive markup that could re-prompt a downstream stage',
    }),
  cited_paths: z.array(z.string().min(1).max(MAX_STR)).max(MAX_LIST),
  cited_atom_ids: z.array(z.string().min(1).max(MAX_STR)).max(MAX_LIST),
  alternatives_rejected: z.array(alternativeSchema).max(MAX_LIST),
  cost_usd: z.number().nonnegative().finite(),
});

export type SpecPayload = z.infer<typeof specPayloadSchema>;

/**
 * Spec system prompt.
 *
 * Exported so the contract-tests can assert on the citation-grounding
 * language. Mirrors the brainstorm-stage HARD-CONSTRAINT pattern: the
 * LLM may cite ONLY atom-ids that appear in the verified set passed
 * via the templated DATA block (data.verified_cited_atom_ids). The
 * verified set is computed by the runner from the seed atoms plus the
 * canon atoms applicable at the planning principal's scope; the spec-
 * stage prompt does not enumerate the set itself, it only constrains
 * the LLM to cite from it. Without this fence, a model that sees only
 * "cite verifiable ids" will confabulate plausible-but-invented ids
 * (the dogfeed of 2026-04-30 surfaced this on plan-stage; spec-stage
 * is the same shape and gets the same fence so the pattern is uniform
 * across the pipeline).
 */
export const SPEC_SYSTEM_PROMPT = `You are the spec stage of a deep-planning pipeline.
Synthesize the brainstorm-stage output into a prose-shaped specification:
state the goal, describe the design with citations to verifiable atom
ids and repository paths, and capture the alternatives you rejected.

HARD CONSTRAINT on atom-id citations: the cited_atom_ids array, and
any atom-id citation embedded in body or alternatives_rejected, MUST
contain ONLY atom-ids that appear in data.verified_cited_atom_ids.
If an atom-id you would cite is not in that set, OMIT the citation
rather than guess. Inventing or paraphrasing an atom-id outside the
verified set produces a critical audit finding and halts the stage.

Cite paths that exist in the repository on disk; an unreachable path
also halts the stage. Emit ONLY a payload that matches the provided
schema; no prose outside the schema fields.`;

async function runSpec(
  input: StageInput<unknown>,
): Promise<StageOutput<SpecPayload>> {
  // Mechanism scaffold: route through host.llm.judge. The caller is
  // responsible for resolving per-principal disallowedTools from the
  // per-principal LLM tool-policy atom and forwarding via LlmOptions;
  // this module does not hardcode tool-policy.
  const result = await input.host.llm.judge<SpecPayload>(
    // JsonSchema shape; the runtime validation runs against
    // specPayloadSchema in the runner via stage.outputSchema.
    {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        body: { type: 'string' },
        cited_paths: { type: 'array', items: { type: 'string' } },
        cited_atom_ids: { type: 'array', items: { type: 'string' } },
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
        cost_usd: { type: 'number' },
      },
      required: [
        'goal',
        'body',
        'cited_paths',
        'cited_atom_ids',
        'alternatives_rejected',
        'cost_usd',
      ],
    },
    SPEC_SYSTEM_PROMPT,
    {
      pipeline_id: String(input.pipelineId),
      seed_atom_ids: input.seedAtomIds.map(String),
      // Citation-grounding fence: the LLM is constrained by the
      // SPEC_SYSTEM_PROMPT to cite ONLY atom-ids that appear in this
      // array. Computed by the runner's caller (runDeepPipeline) from
      // the seed atoms plus the canon atoms applicable at the planning
      // principal's scope, and forwarded through the runner via
      // RunPipelineOptions.verifiedCitedAtomIds. Empty array means the
      // caller did not compute a set; the prompt still instructs the
      // LLM to cite only from this set, so an empty set effectively
      // forbids atom-id citations entirely. The post-stage auditor
      // continues to verify each citation against host.atoms.get and
      // emits a critical finding on fabrication.
      verified_cited_atom_ids: input.verifiedCitedAtomIds.map(String),
      correlation_id: input.correlationId,
      // Forward the upstream brainstorm-stage payload so the spec
      // synthesises against the open_questions, alternatives_surveyed,
      // and decision_points it produced. Without this, the model
      // sees only correlation metadata and synthesises in a vacuum.
      brainstorm_output: input.priorOutput ?? null,
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
    // routing: 'spec-output' lands in the typed-mint branch so the
    // runner mints via mkSpecOutputAtom and the resulting atom is
    // queryable as type='spec-output'. The legacy 'spec' atom type
    // (a looser-shaped sibling of 'plan') stays available for
    // adapters that want a prose-shaped spec atom; the deep-pipeline
    // spec-stage uses 'spec-output' for the queryable stage-output
    // contract.
    atom_type: 'spec-output',
  };
}

/**
 * Verify a cited path is reachable on disk AND resolves inside the
 * repository root (default: process.cwd()). Absolute paths and relative
 * paths that escape via `..` or symlink-traversal are rejected as
 * out-of-scope. The check resolves symlinks via fs.realpath on both
 * sides before computing the relative path, so a symlink inside the
 * repo pointing to /etc/passwd is correctly rejected. Read permission
 * is verified explicitly via fs.access(R_OK).
 */
async function pathExistsInRepo(p: string, repoRoot: string): Promise<boolean> {
  // Reject absolute paths outright; spec citations are repo-relative by
  // contract.
  if (isAbsolute(p)) return false;
  const lexical = resolve(repoRoot, p);
  // Lexical relative check first as a cheap pre-filter; the realpath
  // round-trip below is the authoritative boundary check.
  const lexicalRel = relative(repoRoot, lexical);
  if (lexicalRel === '' || lexicalRel.startsWith('..')) return false;
  try {
    const [rootReal, candidateReal] = await Promise.all([
      fs.realpath(repoRoot),
      fs.realpath(lexical),
    ]);
    const rel = relative(rootReal, candidateReal);
    if (rel === '' || rel.startsWith('..')) return false;
    await fs.access(candidateReal, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atom-id citation regex used to extract inline `atom:<id>` tokens
 * from prose fields (body, alternatives_rejected). Mirrors the
 * brainstorm-stage regex so the auditor catches the same shape of
 * citation regardless of which prose field the LLM smuggles it into.
 * Bounded hyphen-count keeps regex cost linear on adversarial input.
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

async function auditSpec(
  output: SpecPayload,
  ctx: StageContext,
): Promise<ReadonlyArray<AuditFinding>> {
  const findings: AuditFinding[] = [];
  const repoRoot = process.cwd();
  // Build the verified-citation set view once. Empty => closure-of-
  // citations check is skipped (legacy callers including direct
  // audit() invocations from tests rely on resolvability-only).
  const verifiedSet = new Set(ctx.verifiedCitedAtomIds.map(String));
  const enforceVerifiedSet = verifiedSet.size > 0;
  // Collect every cited atom-id from BOTH the structured field and
  // the prose fields where the LLM might smuggle a citation past the
  // structured fence. The HARD-CONSTRAINT block in SPEC_SYSTEM_PROMPT
  // explicitly bans inline atom-ids in body and alternatives_rejected,
  // so the audit must walk those fields too; otherwise the prompt
  // contract is unenforceable. Each prose field contributes its
  // extracted ids tagged with its source-field label so a finding
  // points the operator at the right slot.
  type SpecCitedAtom = {
    readonly id: string;
    readonly field:
      | 'cited_atom_ids'
      | 'body'
      | 'alternatives_rejected';
  };
  const allCitedAtoms: SpecCitedAtom[] = [];
  for (const id of output.cited_atom_ids) {
    allCitedAtoms.push({ id, field: 'cited_atom_ids' });
  }
  for (const id of extractCitedAtomIds(output.body)) {
    allCitedAtoms.push({ id, field: 'body' });
  }
  for (const alt of output.alternatives_rejected) {
    for (const id of extractCitedAtomIds(alt.option)) {
      allCitedAtoms.push({ id, field: 'alternatives_rejected' });
    }
    for (const id of extractCitedAtomIds(alt.reason)) {
      allCitedAtoms.push({ id, field: 'alternatives_rejected' });
    }
  }
  // Verify every collected atom-id is authoritative: present,
  // untainted, and not superseded. A non-authoritative citation is
  // treated as equivalent to a fabricated id because the LLM cited a
  // state that does not hold under arbitration.
  for (const cited of allCitedAtoms) {
    const atom = await ctx.host.atoms.get(cited.id as AtomId);
    let reason: string | null = null;
    if (atom === null) {
      reason = 'does not resolve via host.atoms.get';
    } else if (atom.taint !== 'clean') {
      reason = 'resolves to an atom whose taint is not clean';
    } else if (atom.superseded_by.length > 0) {
      reason = 'resolves to an atom that has been superseded';
    }
    if (reason !== null) {
      findings.push({
        severity: 'critical',
        category: 'fabricated-cited-atom',
        message:
          `Spec cites atom id "${cited.id}" in ${cited.field} which `
          + `${reason}. Mitigates the drafter-citation-verification `
          + 'failure mode at the substrate level.',
        cited_atom_ids: [cited.id as AtomId],
        cited_paths: [],
      });
      continue;
    }
    // Closure-of-citations: a cited id that resolves but is NOT in
    // the verified set means the LLM grounded a citation outside the
    // input contract. Treat as a critical finding identical to
    // fabrication so the prompt's HARD-CONSTRAINT becomes
    // audit-enforceable rather than prompt-only.
    if (enforceVerifiedSet && !verifiedSet.has(cited.id)) {
      findings.push({
        severity: 'critical',
        category: 'non-verified-cited-atom',
        message:
          `Spec cites atom id "${cited.id}" in ${cited.field} which `
          + 'resolves but is NOT in the verified citation set. The spec-'
          + 'stage citation fence enforces the closure-of-citations '
          + 'property at the audit layer, not just the prompt layer.',
        cited_atom_ids: [cited.id as AtomId],
        cited_paths: [],
      });
    }
  }
  // Verify every cited path is reachable on disk inside the repo root.
  // An unreachable or out-of-scope path is a 'critical' finding; the
  // runner halts the stage.
  for (const p of output.cited_paths) {
    if (!(await pathExistsInRepo(p, repoRoot))) {
      findings.push({
        severity: 'critical',
        category: 'unreachable-cited-path',
        message:
          `Spec cites path "${p}" which is not reachable inside the repo `
          + 'root via fs.access. Mitigates the drafter-citation-verification '
          + 'failure mode at the substrate level.',
        cited_atom_ids: [],
        cited_paths: [p],
      });
    }
  }
  return findings;
}

export const specStage: PlanningStage<unknown, SpecPayload> = {
  name: 'spec-stage',
  outputSchema: specPayloadSchema,
  run: runSpec,
  audit: auditSpec,
};
