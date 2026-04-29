/**
 * Reference dispatch-stage adapter.
 *
 * Fifth and terminal reference stage shipped under
 * examples/planning-stages/. The adapter exports a value implementing
 * PlanningStage<TIn, DispatchRecordPayload>; concrete prompts, schemas,
 * and gating heuristics live HERE (in examples/), not in the src/
 * pipeline runner. The runner walks any ReadonlyArray<PlanningStage>
 * the same way regardless of which stage adapters compose.
 *
 * Capabilities
 * ------------
 * - run(): hands off to the existing runDispatchTick rather than
 *   reimplementing dispatch. The pipeline composes with what is already
 *   shipped: claim-before-mutate, escalation actor-message writes on
 *   sub-actor failure, and the existing low-stakes auto-approve
 *   machinery all apply unchanged.
 * - Gate: the dispatch tick runs ONLY when the upstream review-report
 *   is all-clean OR a pipeline-resume atom for the review-stage is
 *   present in seedAtomIds. Default-deny when neither path holds.
 * - outputSchema: zod-validated. Captures dispatch_status
 *   ('completed' | 'gated'), the dispatch counts, an optional
 *   gating_reason, and cost_usd. Rejects negative cost (signed-numeric
 *   prompt-injection guard), rejects negative counts, rejects directive
 *   markup smuggled into the gating reason.
 * - audit(): emits a critical finding when dispatch_status is 'gated'
 *   so the runner halts. The runner's halt-on-critical machinery is
 *   the single source of truth across stage adapters; the dispatch
 *   stage does not implement its own halt path.
 *
 * Dependency injection
 * --------------------
 * The adapter is a factory taking a SubActorRegistry: the runtime
 * registry is the substrate seam between the pipeline and concrete
 * sub-actor invokers. The runner does not see the registry directly;
 * it consumes the resulting PlanningStage value the same way it
 * consumes any other stage. Callers register sub-actor invokers at
 * bootstrap time and pass the same registry into the dispatch-stage
 * factory.
 *
 * Compromise containment
 * ----------------------
 * - A caller that constructs the stage with no registered invoker for
 *   a plan's delegation target falls through runDispatchTick's
 *   ValidationError path, which writes an escalation actor-message
 *   and marks the plan 'failed'. The dispatch-stage itself does not
 *   silently swallow that failure.
 * - A review-report payload outside the schema is caught at the
 *   runner's outputSchema.safeParse before reaching this stage as
 *   priorOutput; this stage trusts the runner's pre-flight.
 * - A pipeline-resume atom forged by a non-allowed principal is
 *   rejected at the resume entrypoint (the resume entrypoint validates
 *   the signer against the per-stage HIL policy's allowed_resumers
 *   list before persisting); reaching this stage with a present
 *   resume atom implies the resume entrypoint already validated the
 *   signer.
 */

import { z } from 'zod';
import type {
  AuditFinding,
  PlanningStage,
  StageContext,
  StageInput,
  StageOutput,
} from '../../../src/runtime/planning-pipeline/index.js';
import type { Atom, AtomId } from '../../../src/types.js';
import {
  runDispatchTick,
  type SubActorRegistry,
} from '../../../src/runtime/actor-message/index.js';

/** Maximum length for the gating_reason field; bounds runaway emissions. */
const MAX_REASON = 4096;

/**
 * Reject any directive-markup token an LLM (or a malformed upstream
 * review-stage) might smuggle into the gating reason to re-prompt a
 * downstream consumer. Conservative: a literal occurrence of the
 * string is sufficient signal for v1.
 */
const INJECTION_TOKEN = '<system-reminder>';

export const dispatchRecordPayloadSchema = z.object({
  dispatch_status: z.enum(['completed', 'gated']),
  scanned: z.number().int().nonnegative().finite(),
  dispatched: z.number().int().nonnegative().finite(),
  failed: z.number().int().nonnegative().finite(),
  cost_usd: z.number().nonnegative().finite(),
  gating_reason: z
    .string()
    .min(1)
    .max(MAX_REASON)
    .refine((s) => !s.includes(INJECTION_TOKEN), {
      message:
        'gating_reason contains directive markup that could re-prompt a downstream consumer',
    })
    .optional(),
});

export type DispatchRecordPayload = z.infer<
  typeof dispatchRecordPayloadSchema
>;

/**
 * Shape this stage consumes from priorOutput. Mirrors the upstream
 * review-stage's ReviewReportPayload structurally; declared here as a
 * structural type so the dispatch-stage does not depend on the
 * review-stage module.
 */
type ReviewReportLike = {
  readonly audit_status?: unknown;
};

function isReviewReportClean(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as ReviewReportLike;
  return candidate.audit_status === 'clean';
}

/**
 * Walk seedAtomIds for a pipeline-resume atom whose metadata
 * stage_name matches 'review-stage' and pipeline_id matches the
 * current run. The resume entrypoint is responsible for validating
 * the signer against the per-stage HIL policy's allowed_resumers list
 * before persisting the atom; reaching this stage with such an atom
 * present implies the entrypoint already approved.
 */
async function findReviewStageResume(
  input: StageInput<unknown>,
): Promise<boolean> {
  for (const atomId of input.seedAtomIds) {
    const atom = await input.host.atoms.get(atomId);
    if (atom === null) continue;
    if (atom.type !== 'pipeline-resume') continue;
    const meta = atom.metadata as Record<string, unknown> | undefined;
    if (meta === undefined) continue;
    if (meta.stage_name !== 'review-stage') continue;
    if (meta.pipeline_id !== input.pipelineId) continue;
    return true;
  }
  return false;
}

export function createDispatchStage(
  registry: SubActorRegistry,
): PlanningStage<unknown, DispatchRecordPayload> {
  async function runDispatch(
    input: StageInput<unknown>,
  ): Promise<StageOutput<DispatchRecordPayload>> {
    const t0 = Date.now();
    const reviewClean = isReviewReportClean(input.priorOutput);
    const resumePresent = reviewClean
      ? false
      : await findReviewStageResume(input);

    if (!reviewClean && !resumePresent) {
      // Default-deny per the substrate-level governance posture: a
      // non-clean review-report without an operator-acked resume
      // atom MUST NOT trigger dispatch. Emit a 'gated' record; the
      // audit() method below converts that into a critical finding
      // so the runner halts uniformly across stages.
      return {
        value: {
          dispatch_status: 'gated',
          scanned: 0,
          dispatched: 0,
          failed: 0,
          cost_usd: 0,
          gating_reason:
            'Upstream review-stage report is not clean and no '
            + 'pipeline-resume atom for review-stage was present in '
            + 'seedAtomIds. Default-deny posture; dispatch will not '
            + 'run until the review-report clears or an authorised '
            + 'resumer signs a pipeline-resume atom.',
        },
        cost_usd: 0,
        duration_ms: Date.now() - t0,
        atom_type: 'dispatch-record',
      };
    }

    // Hand off to the existing runDispatchTick with a pipeline-scoped
    // planFilter so the tick only claims approved plans whose
    // provenance chain traces back to the current pipeline atom.
    // Without this filter the tick is global: a pipeline that reaches
    // dispatch-stage would claim approved plans from unrelated
    // pipelines, replaying their dispatch with the wrong correlation.
    // The filter walks derived_from on the plan; plans authored by
    // the upstream plan-stage in this pipeline carry pipelineId in
    // their derived_from chain.
    const currentPipelineId = String(input.pipelineId);
    const planFilter = (plan: Atom): boolean => {
      const derived = plan.provenance?.derived_from ?? [];
      for (const id of derived) {
        if (String(id) === currentPipelineId) return true;
      }
      return false;
    };
    const tick = await runDispatchTick(input.host, registry, { planFilter });
    return {
      value: {
        dispatch_status: 'completed',
        scanned: tick.scanned,
        dispatched: tick.dispatched,
        failed: tick.failed,
        cost_usd: 0,
      },
      cost_usd: 0,
      duration_ms: Date.now() - t0,
      atom_type: 'dispatch-record',
    };
  }

  async function auditDispatch(
    output: DispatchRecordPayload,
    _ctx: StageContext,
  ): Promise<ReadonlyArray<AuditFinding>> {
    if (output.dispatch_status !== 'gated') return [];
    return [
      {
        severity: 'critical' as const,
        category: 'dispatch-gated',
        message:
          output.gating_reason
          ?? 'Dispatch stage gated; upstream review-report is not clean and '
            + 'no operator-acked pipeline-resume atom is present.',
        cited_atom_ids: [] as ReadonlyArray<AtomId>,
        cited_paths: [],
      },
    ];
  }

  return {
    name: 'dispatch-stage',
    outputSchema: dispatchRecordPayloadSchema,
    run: runDispatch,
    audit: auditDispatch,
  };
}
