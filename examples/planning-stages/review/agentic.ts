/**
 * Agentic review-stage adapter.
 *
 * Sibling of the single-shot reference adapter at index.ts. Runs the
 * review stage as a dispatched agent-loop session bundled with the
 * vendored `review-discipline` skill markdown so the agent operates
 * under the citation-and-discipline auditor mandate. The same
 * `reviewReportPayloadSchema` zod (re-exported from index.ts) validates
 * the agent's final output, so the runner's persistStageOutput path is
 * unchanged: this adapter emits a payload shape-identical to the
 * single-shot adapter and lands in the typed `review-report` mint
 * branch.
 *
 * Composition
 * -----------
 * - skill bundle: resolved via skill-bundle-resolver.ts (plugin cache
 *   first, vendored fallback) and embedded in the prompt.
 * - canon binding: handled by runStageAgentLoop -- the canon-bound
 *   pipeline-stage-event lands before the agent dispatches.
 * - tool policy: per-principal pol-llm-tool-policy-pipeline-auditor
 *   (Read+Grep+Glob, no writes) loaded automatically by the helper.
 * - workspace: caller supplies the workspace provider; review is
 *   read-only in posture so a read-only workspace flag (when supported
 *   by the provider) tightens the surface further.
 * - audit: re-uses the single-shot adapter's auditReview so the
 *   runner's halt-on-critical machinery applies uniformly across
 *   single-shot and agentic paths.
 *
 * Why disableCanonAudit defaults to true here
 * -------------------------------------------
 * The review-stage IS the auditor. Its primary run() walks every cited
 * atom-id and path looking for fabrication and unreachability; that
 * walk is structurally identical to a canon-audit checkpoint that
 * would otherwise re-walk the same evidence chain on the SAME stage's
 * output. Running both would burn tokens on a redundant audit pass
 * with no incremental signal, since the canon-audit auditor would
 * have access to the same atom store and workspace as the primary run.
 *
 * Per dev-implementation-canon-audit-loop the canon-audit checkpoint
 * exists to catch the IN-FLIGHT compromise of a non-auditor stage's
 * prompt. The review-stage agent-loop's prompt is itself the audit
 * mandate; a compromised audit-prompt would surface as missing
 * fabrication findings, not as a structural change in the audit
 * shape, which a canon-audit pass would not catch any more reliably
 * than the substrate-mediated audit() that the runner already invokes
 * after run(). The trade-off is surfaced explicitly here rather than
 * silently skipped.
 *
 * The default can be flipped via `disableCanonAudit: false` for
 * deployments that want the redundant pass for defense-in-depth (e.g.
 * a deployment running the review stage under a low-trust principal
 * whose audit-mandate prompt should be re-verified). The runner's
 * halt-on-critical machinery applies uniformly either way; the
 * canon-audit-complete event still emits with verdict='approved' and
 * empty findings when disabled, so the chain shape stays uniform.
 *
 * The adapter is built via a factory that takes the substrate
 * primitives (AgentLoopAdapter + WorkspaceProvider + BlobStore +
 * Redactor) so different deployments compose different concrete
 * adapters without changing this module.
 */

import type { AgentLoopAdapter } from '../../../src/substrate/agent-loop.js';
import type { BlobStore } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { WorkspaceProvider } from '../../../src/substrate/workspace-provider.js';
import type {
  PlanningStage,
  StageInput,
  StageOutput,
} from '../../../src/runtime/planning-pipeline/index.js';
import type {
  PrincipalId,
  ReplayTier,
} from '../../../src/substrate/types.js';
import { runStageAgentLoop } from '../lib/run-stage-agent-loop.js';
import { resolveSkillBundle } from '../lib/skill-bundle-resolver.js';
import {
  reviewReportPayloadSchema,
  auditReview,
  type ReviewReportPayload,
} from './index.js';

/** Default principal for the review stage (auditor identity). */
const REVIEW_PRINCIPAL: PrincipalId = 'pipeline-auditor' as PrincipalId;

export interface AgenticReviewStageConfig {
  readonly agentLoop: AgentLoopAdapter;
  readonly workspaceProvider: WorkspaceProvider;
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;
  /** Replay tier for the agent-loop session. Defaults to 'best-effort'. */
  readonly replayTier?: ReplayTier;
  /** Blob threshold in bytes (already clamped by the caller). */
  readonly blobThreshold?: number;
  /** Base ref for the workspace acquire. Defaults to 'main'. */
  readonly baseRef?: string;
  /** Override the pipeline-auditor principal id (rarely needed). */
  readonly principal?: PrincipalId;
  /**
   * Run the canon-audit checkpoint. Defaults to false because the
   * review-stage IS the auditor; running canon-audit on top would be a
   * redundant pass over the same evidence chain. Deployments that want
   * the defense-in-depth pass set this to false explicitly.
   *
   * The flag inversion vs other agentic stages (brainstorm + spec +
   * plan default to running canon-audit) is intentional: the other
   * stages are NOT auditors, so a compromised stage prompt could ship
   * a fabricated output that only an external audit would catch. The
   * review-stage's primary mandate is the audit, so re-auditing adds
   * no signal.
   */
  readonly disableCanonAudit?: boolean;
}

function buildReviewPrompt(opts: {
  readonly skillBundle: string;
  readonly stageInput: StageInput<unknown>;
  readonly canonAtomIds: ReadonlyArray<string>;
  readonly stagePrincipal: PrincipalId;
}): string {
  const { skillBundle, stageInput, canonAtomIds, stagePrincipal } = opts;
  const seedAtomIds = stageInput.seedAtomIds.map(String).join(', ') || '(none)';
  const verifiedCited = stageInput.verifiedCitedAtomIds.map(String).join(', ') || '(none)';
  const priorOutput =
    stageInput.priorOutput === null || stageInput.priorOutput === undefined
      ? '(no upstream plan output; cannot audit; emit clean status)'
      : JSON.stringify(stageInput.priorOutput, null, 2);
  return [
    skillBundle,
    '',
    '---',
    '',
    '## Stage context',
    '',
    `- pipeline_id: ${String(stageInput.pipelineId)}`,
    `- correlation_id: ${stageInput.correlationId}`,
    // Use the resolved principal so an override via config.principal stays
    // in sync with the canon/tool-policy identity the actor actually runs
    // under. Hardcoding 'pipeline-auditor' would desync the prompt from
    // the resolved identity at the helper's principal resolution.
    `- principal: ${String(stagePrincipal)}`,
    `- seed atom ids: ${seedAtomIds}`,
    `- canon directives applicable: ${canonAtomIds.length} (you have read access via Read on .lag/atoms/)`,
    `- verified citation set (for grounding context; the audit fence is resolvability via Read on .lag/atoms/<id>.json, not membership in this set): ${verifiedCited}`,
    '',
    '## Operator-intent (literal text; for context only)',
    '',
    stageInput.operatorIntentContent.length > 0
      ? stageInput.operatorIntentContent
      : '(no anchor available; audit citations against the resolvability fence only)',
    '',
    '## Upstream plan output (the artifact you audit)',
    '',
    priorOutput,
    '',
    '## Your turn',
    '',
    'Audit the plan output above for citation closure and substrate',
    'discipline. Use Read, Grep, and Glob to verify every cited atom-id',
    'in plan.derived_from and plan.principles_applied resolves on disk',
    'via .lag/atoms/<id>.json, and every cited path in any upstream',
    'spec atom resolves via the workspace. Your final-turn text content',
    'MUST be a single JSON object matching the ReviewReportPayload',
    'schema. No prose outside the JSON.',
  ].join('\n');
}

/**
 * Optional canon-audit prompt builder for the review stage. Only used
 * when `disableCanonAudit: false` is supplied. Audits whether the
 * review's findings list is itself well-formed: are findings tied to
 * concrete atom-ids/paths, do they cite specific evidence, do they
 * avoid bare assertions without citations? This is the meta-audit that
 * defense-in-depth deployments turn on; the default-skip path treats
 * the primary audit as load-bearing.
 */
function buildReviewCanonAuditPrompt(opts: {
  readonly producedOutput: ReviewReportPayload;
  readonly stageInput: StageInput<unknown>;
  readonly canonAtomIds: ReadonlyArray<string>;
}): string {
  return [
    'You are a meta-auditor for a deep planning pipeline review-stage',
    'run. The review-stage already audited an upstream plan; your job',
    'is to verify the audit itself was well-formed (findings tied to',
    'concrete atom-ids/paths, no bare assertions without evidence).',
    '',
    'Verdict criteria:',
    '- approved: every finding cites at least one concrete atom-id or',
    '  path; severity assignments match the violation class (critical',
    '  for fabrication/unreachability, major for budget-exceeded,',
    '  minor for stylistic); audit_status matches the findings list.',
    '- issues-found: any of the above is violated. List meta-findings',
    '  with severity (critical | major | minor), category, message.',
    '',
    'Operator-intent (literal):',
    opts.stageInput.operatorIntentContent || '(none)',
    '',
    'Review output:',
    JSON.stringify(opts.producedOutput, null, 2),
    '',
    `Applicable canon (${opts.canonAtomIds.length} directive ids; you can`,
    'Read .lag/atoms/<id>.json to inspect):',
    opts.canonAtomIds.slice(0, 20).join('\n'),
    '',
    'Emit ONE JSON object as your final-turn text content matching:',
    '{',
    '  "verdict": "approved" | "issues-found",',
    '  "findings": [',
    '    {',
    '      "severity": "critical" | "major" | "minor",',
    '      "category": "<short>",',
    '      "message": "<sentence>",',
    '      "cited_atom_ids": [...],',
    '      "cited_paths": [...]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function buildAgenticReviewStage(
  config: AgenticReviewStageConfig,
): PlanningStage<unknown, ReviewReportPayload> {
  const stagePrincipal = config.principal ?? REVIEW_PRINCIPAL;
  // Default to skipping canon-audit because the review-stage IS the
  // auditor; see the rationale in the module-level comment.
  const skipCanonAudit = config.disableCanonAudit ?? true;

  async function run(
    input: StageInput<unknown>,
  ): Promise<StageOutput<ReviewReportPayload>> {
    const skillBundle = await resolveSkillBundle('review-discipline');
    // Compose the helper input as a literal so exactOptionalPropertyTypes
    // narrows on the canonAuditPromptBuilder branch (the option-key is
    // either present or omitted; never present-and-undefined). The
    // ternary spreads either an empty object or the property, which TS
    // accepts without the explicit-undefined collision.
    const result = await runStageAgentLoop<ReviewReportPayload>({
      stageInput: input,
      stageName: 'review-stage',
      stagePrincipal,
      skillBundle,
      promptBuilder: ({ skillBundle: sb, stageInput, canonAtomIds, stagePrincipal: sp }) =>
        buildReviewPrompt({
          skillBundle: sb,
          stageInput,
          canonAtomIds: canonAtomIds.map(String),
          stagePrincipal: sp,
        }),
      outputSchema: reviewReportPayloadSchema,
      agentLoop: config.agentLoop,
      workspaceProvider: config.workspaceProvider,
      blobStore: config.blobStore,
      redactor: config.redactor,
      replayTier: config.replayTier ?? 'best-effort',
      blobThreshold: config.blobThreshold ?? 4096,
      baseRef: config.baseRef ?? 'main',
      ...(skipCanonAudit
        ? {}
        : {
            canonAuditPromptBuilder: ({
              producedOutput,
              stageInput,
              canonAtomIds,
            }: {
              producedOutput: ReviewReportPayload;
              stageInput: StageInput<unknown>;
              canonAtomIds: ReadonlyArray<string>;
            }) =>
              buildReviewCanonAuditPrompt({
                producedOutput,
                stageInput,
                canonAtomIds: canonAtomIds.map(String),
              }),
          }),
    });
    return {
      value: result.value,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
      atom_type: 'review-report',
      // Forward the helper-resolved canon-at-runtime stamp onto the
      // stage-output atom's metadata via the runner's shallow-merge.
      // Without this, the Console's canon-at-runtime projection has to
      // re-resolve via a static stage-mapping table that may not match
      // the principal_id the runner persists onto stage atoms.
      extraMetadata: result.stageOutputExtraMetadata,
    };
  }

  return {
    name: 'review-stage',
    outputSchema: reviewReportPayloadSchema,
    run,
    // Re-use the single-shot adapter's audit so the halt-on-critical
    // machinery applies uniformly across single-shot and agentic paths.
    // The single-shot adapter walks the in-process audit; the agentic
    // adapter's findings come from the LLM emission. Both produce a
    // ReviewReportPayload, and auditReview re-emits the findings list
    // unchanged so the runner's halt path is the single source of truth.
    audit: auditReview,
  };
}
