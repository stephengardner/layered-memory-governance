/**
 * Reference review-stage adapter.
 *
 * Fourth reference stage shipped under examples/planning-stages/. The
 * adapter exports a value implementing PlanningStage<PlanPayload,
 * ReviewReportPayload>; concrete prompts, schemas, and citation-
 * verification heuristics live HERE (in examples/), not in the src/
 * pipeline runner. The runner walks any ReadonlyArray<PlanningStage>
 * the same way regardless of which stage adapters compose.
 *
 * Capabilities
 * ------------
 * - run(): substrate-level fix for the drafter-citation-verification
 *   failure mode. Walks the upstream plan's derived_from and
 *   principles_applied atom-id lists and any upstream spec atom's
 *   cited_paths, verifying each resolves. Path verification uses a
 *   workspace-side byte-cap helper (per-file 64KB, per-audit 1MB) with
 *   a sha256 streaming-hash fallback for files exceeding the per-file
 *   cap; the runaway-large-path failure mode (an LLM-emitted huge
 *   path list) is bounded by the per-audit total cap. Findings are
 *   captured on the report payload; the runner's halt-on-critical
 *   machinery applies via audit() below.
 * - outputSchema: zod-validated. Captures audit_status ('clean' |
 *   'findings'), the findings list, total bytes accounted for, and
 *   cost_usd. Rejects negative cost (signed-numeric prompt-injection
 *   guard), rejects directive markup smuggled into a finding message,
 *   and caps list lengths to bound runaway emissions.
 * - audit(): re-emits any critical findings produced during run() so
 *   the runner's halt-on-critical machinery applies uniformly. This
 *   keeps the runner's pipeline-audit-finding atom flow + halt logic
 *   the single source of truth across stage adapters; the review
 *   stage does not implement its own halt path.
 *
 * Auditor-actor wiring
 * --------------------
 * The org-ceiling consumer registers a real pipeline-auditor sub-actor
 * (LLM-driven, read-only Read+Grep+Glob) via the existing
 * SubActorRegistry seam and a custom review-stage adapter that
 * dispatches to it. The indie-floor reference adapter does the
 * verification in-process via host.atoms.get + the workspace-side
 * byte-cap helper, which covers the substrate-level confabulation
 * failure mode without paying for a separate sub-actor invocation per
 * planning pass. Both shapes implement the same PlanningStage
 * interface; the runner does not branch.
 *
 * Compromise containment
 * ----------------------
 * - A review-author that emits a payload outside the schema fails at
 *   the runner (not here): the runner runs outputSchema.safeParse
 *   before treating the value as valid.
 * - A review-author that misses a fabricated atom or path is caught
 *   by audit() re-emitting the findings; the runner halts on critical.
 * - A review-author that smuggles directive markup into a finding
 *   message is rejected by outputSchema before audit even runs.
 * - List-size caps bound the audit walk so an LLM-emitted runaway
 *   list cannot stall the auditor; the per-audit total byte cap
 *   bounds the cited-paths walk so a runaway-large path list cannot
 *   exhaust the auditor's read budget.
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
import { AuditByteBudget } from './byte-cap.js';

/** Maximum entries per list field; mirrors MAX_CITED_LIST in atom-shapes. */
const MAX_LIST = 256;

/** Maximum length for a finding message; bounds runaway LLM emissions. */
const MAX_MSG = 4096;

/** Maximum length for a category label. */
const MAX_CATEGORY = 200;

/**
 * Reject any directive-markup token an LLM might smuggle into a
 * finding message to re-prompt a downstream stage. Conservative: a
 * literal occurrence of the string is sufficient signal for v1.
 */
const INJECTION_TOKEN = '<system-reminder>';

const findingSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor']),
  category: z.string().min(1).max(MAX_CATEGORY),
  message: z
    .string()
    .min(1)
    .max(MAX_MSG)
    .refine((s) => !s.includes(INJECTION_TOKEN), {
      message:
        'finding message contains directive markup that could re-prompt a downstream stage',
    }),
  cited_atom_ids: z.array(z.string().min(1)).max(MAX_LIST),
  cited_paths: z.array(z.string().min(1)).max(MAX_LIST),
});

export const reviewReportPayloadSchema = z.object({
  audit_status: z.enum(['clean', 'findings']),
  findings: z.array(findingSchema).max(MAX_LIST),
  total_bytes_read: z.number().nonnegative().finite(),
  cost_usd: z.number().nonnegative().finite(),
});

export type ReviewReportPayload = z.infer<typeof reviewReportPayloadSchema>;

/**
 * Plan payload shape this stage consumes. Mirrors the upstream plan-
 * stage's PlanPayload structurally; declared here as a structural type
 * so the review-stage does not depend on the plan-stage module.
 */
type PlanLike = {
  readonly title?: unknown;
  readonly derived_from?: ReadonlyArray<string>;
  readonly principles_applied?: ReadonlyArray<string>;
};

type PlanPayloadLike = {
  readonly plans?: ReadonlyArray<PlanLike>;
};

function asAtomIdArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asPlanLikeArray(value: unknown): ReadonlyArray<PlanLike> {
  if (typeof value !== 'object' || value === null) return [];
  const candidate = value as PlanPayloadLike;
  if (!Array.isArray(candidate.plans)) return [];
  return candidate.plans;
}

/**
 * Pull cited_paths off an upstream spec atom's metadata. The spec-
 * stage stores cited_paths via the atom-shape builder under
 * metadata.cited_paths (per atom-shapes.ts), so the review-stage
 * walks that exact field rather than parsing the spec body for
 * path-shaped tokens.
 */
function extractSpecCitedPaths(
  metadata: Record<string, unknown> | undefined,
): ReadonlyArray<string> {
  if (metadata === undefined) return [];
  const paths = metadata.cited_paths;
  if (!Array.isArray(paths)) return [];
  return paths
    .filter((v): v is string => typeof v === 'string')
    .slice(0, MAX_LIST);
}

async function runReview(
  input: StageInput<unknown>,
): Promise<StageOutput<ReviewReportPayload>> {
  const t0 = Date.now();
  const findings: AuditFinding[] = [];
  const plans = asPlanLikeArray(input.priorOutput);

  // Walk every plan's derived_from and principles_applied. A
  // fabricated atom-id is the substrate-level failure mode this stage
  // exists to catch. The reference (indie-floor) review-stage walks
  // host.atoms.get only; the verifiedCitedAtomIds set on
  // StageInput is forwarded by the runner for org-ceiling LLM-driven
  // review-stage adapters that compose into this same PlanningStage
  // shape and may use the set as a positive grounding contract for
  // their own LLM call (mirroring the spec-stage and plan-stage
  // patterns). The reference adapter does not consume the field so
  // that an absent or empty set never widens the citation fence past
  // resolvability; the runner's halt-on-critical-finding plus the
  // existing fabricated-cited-atom check is the load-bearing fence
  // for the indie-floor path.
  for (const plan of plans) {
    const planLabel =
      typeof plan.title === 'string' && plan.title.length > 0
        ? plan.title
        : '(unnamed-plan)';
    for (const id of asAtomIdArray(plan.derived_from)) {
      const atom = await input.host.atoms.get(id as AtomId);
      if (atom === null) {
        findings.push({
          severity: 'critical',
          category: 'fabricated-cited-atom',
          message:
            `Plan "${planLabel}" cites atom id "${id}" in derived_from `
            + 'which does not resolve via host.atoms.get. The review stage '
            + 'is the substrate-level fix for the drafter-citation-'
            + 'verification failure mode.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
      }
    }
    for (const id of asAtomIdArray(plan.principles_applied)) {
      const atom = await input.host.atoms.get(id as AtomId);
      if (atom === null) {
        findings.push({
          severity: 'critical',
          category: 'fabricated-cited-atom',
          message:
            `Plan "${planLabel}" cites atom id "${id}" in `
            + 'principles_applied which does not resolve via '
            + 'host.atoms.get. The review stage is the substrate-level '
            + 'fix for the drafter-citation-verification failure mode.',
          cited_atom_ids: [id as AtomId],
          cited_paths: [],
        });
      }
    }
  }

  // Walk the upstream spec atom's cited_paths. The spec-stage already
  // audits its own paths, but defense-in-depth: a spec atom seeded from
  // outside the canonical pipeline (resume-from-stage, recovery flow)
  // may carry cited_paths the spec-stage's audit did not see. The
  // workspace-side byte-cap helper bounds the read budget.
  const budget = new AuditByteBudget();
  for (const seedId of input.seedAtomIds) {
    const atom = await input.host.atoms.get(seedId);
    if (atom === null) continue;
    if (atom.type !== 'observation' && atom.type !== 'spec') continue;
    const citedPaths = extractSpecCitedPaths(atom.metadata);
    for (const path of citedPaths) {
      const outcome = await budget.probe(path);
      switch (outcome.kind) {
        case 'reachable':
        case 'reachable-via-hash':
          // Path resolves; no finding. Hash-comparison fallback covers
          // files exceeding the per-file byte cap so the audit budget
          // is bounded.
          break;
        case 'unreachable':
          findings.push({
            severity: 'critical',
            category: 'unreachable-cited-path',
            message:
              `Upstream spec cites path "${path}" which is not reachable `
              + 'on disk. The review stage is the substrate-level fix for '
              + 'the drafter-citation-verification failure mode.',
            cited_atom_ids: [seedId],
            cited_paths: [path],
          });
          break;
        case 'budget-exceeded':
          // Per-audit total cap reached; record a major finding so
          // the operator sees the truncation but do not halt the
          // pipeline (an LLM emitting a runaway list is an LLM-tier
          // problem, not a confabulation failure).
          findings.push({
            severity: 'major',
            category: 'audit-budget-exceeded',
            message:
              `Audit budget exceeded after ${budget.totalBytesRead} bytes; `
              + 'remaining cited_paths in upstream spec were not verified. '
              + 'A runaway-large cited_paths list in the spec is the likely '
              + 'cause; expect a follow-up bounded re-emission.',
            cited_atom_ids: [seedId],
            cited_paths: [path],
          });
          break;
      }
      if (outcome.kind === 'budget-exceeded') break;
    }
    if (budget.totalBytesRead >= budget.perAuditCapBytes) break;
  }

  const audit_status: 'clean' | 'findings' =
    findings.length === 0 ? 'clean' : 'findings';
  // Convert AuditFinding (readonly arrays per the substrate type) to
  // the schema-inferred report-finding shape (mutable arrays per the
  // zod inference), copying the array slots so the substrate's
  // readonly contract is preserved on the source AuditFinding values.
  const reportFindings = findings.map((f) => ({
    severity: f.severity,
    category: f.category,
    message: f.message,
    cited_atom_ids: [...f.cited_atom_ids],
    cited_paths: [...f.cited_paths],
  }));
  return {
    value: {
      audit_status,
      findings: reportFindings,
      total_bytes_read: budget.totalBytesRead,
      cost_usd: 0,
    },
    cost_usd: 0,
    duration_ms: Date.now() - t0,
    atom_type: 'review-report',
  };
}

export async function auditReview(
  output: ReviewReportPayload,
  _ctx: StageContext,
): Promise<ReadonlyArray<AuditFinding>> {
  // Re-emit any critical findings collected during run() so the
  // runner's halt-on-critical + pipeline-audit-finding atom flow
  // applies uniformly. Major and minor findings are reported but do
  // not halt the pipeline; a 'major' audit-budget-exceeded surfaces
  // the truncation without forcing a stage-failure recovery.
  return output.findings.map((f) => ({
    severity: f.severity,
    category: f.category,
    message: f.message,
    // Schema stores cited_atom_ids as plain string[] (it does not
    // know AtomId branding); cast through unknown to the branded
    // ReadonlyArray<AtomId> the AuditFinding contract demands.
    cited_atom_ids: f.cited_atom_ids as unknown as ReadonlyArray<AtomId>,
    cited_paths: f.cited_paths,
  }));
}

export const reviewStage: PlanningStage<unknown, ReviewReportPayload> = {
  name: 'review-stage',
  outputSchema: reviewReportPayloadSchema,
  run: runReview,
  audit: auditReview,
};
