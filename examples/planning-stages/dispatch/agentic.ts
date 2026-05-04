/**
 * Agentic dispatch-stage adapter.
 *
 * Sibling of the single-shot reference adapter at index.ts. Runs the
 * dispatch stage as a dispatched agent-loop session bundled with the
 * vendored `dispatch-discipline` skill markdown so the agent operates
 * under the chain-verification mandate before the substrate hands off
 * to runDispatchTick. The same `dispatchRecordPayloadSchema` zod
 * (re-exported from index.ts) shapes the stage output, so the runner's
 * persistStageOutput path is unchanged: this adapter emits a payload
 * shape-identical to the single-shot adapter and lands in the typed
 * `dispatch-record` mint branch.
 *
 * Composition
 * -----------
 * - skill bundle: resolved via skill-bundle-resolver.ts (plugin cache
 *   first, vendored fallback) and embedded in the prompt.
 * - canon binding: handled by runStageAgentLoop -- the canon-bound
 *   pipeline-stage-event lands before the agent dispatches.
 * - tool policy: per-principal pol-llm-tool-policy-plan-dispatcher
 *   (Read+Grep+Glob, no writes) loaded automatically by the helper.
 * - workspace: caller supplies the workspace provider; the dispatch
 *   stage is read-only at the LLM layer (the agent verifies the
 *   chain; mutating dispatch is the substrate's runDispatchTick call
 *   that follows the verification verdict).
 * - audit: re-uses the single-shot adapter's auditDispatch so the
 *   runner's halt-on-critical machinery applies uniformly across
 *   single-shot and agentic paths. The agentic adapter's canon-audit
 *   checkpoint is supplemental; the substrate-mediated audit() the
 *   runner invokes after run() is the load-bearing gate.
 *
 * Two-phase shape
 * ---------------
 * The agent's job is chain VERIFICATION, not dispatch itself. The LLM
 * walks the upstream plan + spec + brainstorm citation chain plus the
 * verified sub-actor allowlist + envelope match, and emits a verdict
 * ('approved' | 'rejected' with reason). The adapter then either:
 *
 *   - verdict='approved': hands off to runDispatchTick (the existing
 *     substrate dispatcher), assembles a 'completed' DispatchRecordPayload
 *     from the tick's counts. The dispatcher (not the agent) is the
 *     single source of truth for plan claim + invoke + escalation;
 *     duplicating dispatch in the LLM would conflict with the
 *     existing claim-before-mutate machinery.
 *   - verdict='rejected': returns a 'gated' DispatchRecordPayload with
 *     the reason. The substrate audit then converts this to a critical
 *     finding so the runner halts, identical to the single-shot gate.
 *
 * The verification verdict schema is internal to this module; the
 * stage's outward-facing shape is dispatchRecordPayloadSchema, the
 * same as the single-shot adapter.
 *
 * The adapter is built via a factory that takes the substrate
 * primitives (AgentLoopAdapter + WorkspaceProvider + BlobStore +
 * Redactor) plus the SubActorRegistry the dispatch handoff routes
 * through. Different deployments compose different concrete adapters
 * without changing this module.
 */

import { z } from 'zod';
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
// Value import via the package's `imports` map; mirrors the rationale
// in dispatch/index.ts (the relative '../../../src/...' path resolves
// to a non-existent dist/src/ at runtime; the '#runtime/actor-message'
// alias routes types vs default appropriately).
import {
  runDispatchTick,
  type SubActorRegistry,
} from '#runtime/actor-message';
import { runStageAgentLoop } from '../lib/run-stage-agent-loop.js';
import { resolveSkillBundle } from '../lib/skill-bundle-resolver.js';
import {
  auditDispatch,
  buildPipelineScopedPlanFilter,
  dispatchRecordPayloadSchema,
  type DispatchRecordPayload,
} from './index.js';

/** Default principal for the dispatch stage. */
const DISPATCH_PRINCIPAL: PrincipalId = 'plan-dispatcher' as PrincipalId;

/** Maximum length for the verdict reason field; bounds runaway emissions. */
const MAX_REASON = 4096;

/**
 * Reject any directive-markup token the LLM might smuggle into the
 * verdict reason to re-prompt a downstream consumer. Same posture as
 * the single-shot adapter's INJECTION_TOKEN refine.
 */
const INJECTION_TOKEN = '<system-reminder>';

/**
 * Internal verification verdict shape the agent emits. The LLM does
 * NOT emit a DispatchRecordPayload directly because the agent is not
 * authorised to claim 'completed' status (only runDispatchTick is).
 * The adapter parses this verdict, then either invokes runDispatchTick
 * (verdict='approved') or returns a 'gated' DispatchRecordPayload
 * (verdict='rejected').
 */
const verificationVerdictSchema = z.object({
  verdict: z.enum(['approved', 'rejected']),
  reason: z
    .string()
    .min(1)
    .max(MAX_REASON)
    .refine((s) => !s.includes(INJECTION_TOKEN), {
      message:
        'reason contains directive markup that could re-prompt a downstream consumer',
    }),
});

type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;

export interface AgenticDispatchStageConfig {
  readonly agentLoop: AgentLoopAdapter;
  readonly workspaceProvider: WorkspaceProvider;
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;
  /**
   * SubActorRegistry the dispatch handoff routes through when the
   * agent's verdict is 'approved'. The runtime registry is the
   * substrate seam between the pipeline and concrete sub-actor
   * invokers; the runner does not see the registry directly.
   */
  readonly registry: SubActorRegistry;
  /** Replay tier for the agent-loop session. Defaults to 'best-effort'. */
  readonly replayTier?: ReplayTier;
  /** Blob threshold in bytes (already clamped by the caller). */
  readonly blobThreshold?: number;
  /** Base ref for the workspace acquire. Defaults to 'main'. */
  readonly baseRef?: string;
  /** Override the plan-dispatcher principal id (rarely needed). */
  readonly principal?: PrincipalId;
  /** Skip the canon-audit checkpoint (defaults to running it). */
  readonly disableCanonAudit?: boolean;
}

function buildDispatchPrompt(opts: {
  readonly skillBundle: string;
  readonly stageInput: StageInput<unknown>;
  readonly canonAtomIds: ReadonlyArray<string>;
  readonly stagePrincipal: PrincipalId;
}): string {
  const { skillBundle, stageInput, canonAtomIds, stagePrincipal } = opts;
  const seedAtomIds = stageInput.seedAtomIds.map(String).join(', ') || '(none)';
  const verifiedCited = stageInput.verifiedCitedAtomIds.map(String).join(', ') || '(none)';
  const verifiedSubActors =
    stageInput.verifiedSubActorPrincipalIds.map(String).join(', ') || '(none)';
  const priorOutput =
    stageInput.priorOutput === null || stageInput.priorOutput === undefined
      ? '(no upstream review-report; cannot verify the chain; emit verdict=rejected with reason)'
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
    // under. Hardcoding 'plan-dispatcher' would desync the prompt from the
    // resolved identity at the helper's principal resolution.
    `- principal: ${String(stagePrincipal)}`,
    `- seed atom ids: ${seedAtomIds}`,
    `- canon directives applicable: ${canonAtomIds.length} (you have read access via Read on .lag/atoms/)`,
    `- verified citation set (every plan citation NOT in this set is a fabrication and rejects the chain): ${verifiedCited}`,
    `- verified sub-actor set (every plan delegation NOT in this set is a fence violation and rejects the chain): ${verifiedSubActors}`,
    '',
    '## Operator-intent (literal text; for context only)',
    '',
    stageInput.operatorIntentContent.length > 0
      ? stageInput.operatorIntentContent
      : '(no anchor available; verify citations against the verified set only)',
    '',
    '## Upstream review-report (the artifact gating this stage)',
    '',
    priorOutput,
    '',
    '## Your turn',
    '',
    'Verify the upstream chain (plan + spec + brainstorm + review-report)',
    'before the substrate hands off to runDispatchTick. Use Read, Grep,',
    'and Glob to walk every cited atom-id in the plan + spec + brainstorm',
    'atoms (.lag/atoms/<id>.json), confirm each resolves on disk, and',
    'confirm each plan delegation.sub_actor_principal_id is in the',
    'verified sub-actor set. Reject the chain (verdict=rejected with',
    'reason) when ANY of the following holds: review-report.audit_status',
    'is not clean AND no pipeline-resume atom for review-stage is in',
    'seedAtomIds; a plan cites an atom-id outside the verified set; a',
    'plan delegates to a principal-id outside the verified sub-actor',
    'set; the envelope match (confidence + blast_radius + sub_actor) is',
    'broken. Approve the chain (verdict=approved with reason naming the',
    'specific evidence walked) only when every check passes. Your',
    'final-turn text content MUST be a single JSON object matching:',
    '',
    '{',
    '  "verdict": "approved" | "rejected",',
    '  "reason": "<one sentence naming the specific evidence walked'
    + ' (approved) or the specific failure mode (rejected)>"',
    '}',
    '',
    'No prose outside the JSON.',
  ].join('\n');
}

function buildDispatchCanonAuditPrompt(opts: {
  readonly producedOutput: VerificationVerdict;
  readonly stageInput: StageInput<unknown>;
  readonly canonAtomIds: ReadonlyArray<string>;
}): string {
  const verifiedCited =
    opts.stageInput.verifiedCitedAtomIds.map(String).join(', ') || '(none)';
  const verifiedSubActors =
    opts.stageInput.verifiedSubActorPrincipalIds.map(String).join(', ') || '(none)';
  return [
    'You are a canon-compliance auditor for a deep planning pipeline',
    'dispatch-stage verification run. The dispatch-stage agent already',
    'emitted a verdict on the upstream chain; your job is to verify the',
    'verdict was well-grounded.',
    '',
    'Verdict criteria:',
    '- approved: the dispatch verdict cites specific evidence (atom-ids',
    '  or paths) it walked; if verdict=approved the reason names which',
    '  citations + sub-actor allowlist entries it confirmed; if verdict',
    '  =rejected the reason names the specific failure mode (fabricated',
    '  citation, unauthorised sub-actor, broken envelope, non-clean',
    '  review-report).',
    '- issues-found: the verdict is bare ("looks good", "all checks',
    '  pass") without naming the specific evidence walked; the reason',
    '  cites an atom-id outside the verified set; the rejection cites',
    '  a failure mode that does not match any verifiable evidence.',
    '',
    'Operator-intent (literal):',
    opts.stageInput.operatorIntentContent || '(none)',
    '',
    'Verified citation set:',
    verifiedCited,
    '',
    'Verified sub-actor set:',
    verifiedSubActors,
    '',
    'Dispatch verdict:',
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

export function buildAgenticDispatchStage(
  config: AgenticDispatchStageConfig,
): PlanningStage<unknown, DispatchRecordPayload> {
  const stagePrincipal = config.principal ?? DISPATCH_PRINCIPAL;

  async function run(
    input: StageInput<unknown>,
  ): Promise<StageOutput<DispatchRecordPayload>> {
    // Start the wall-clock timer BEFORE the skill resolution so the
    // returned duration_ms covers the full stage run (skill resolve +
    // agent-loop + canon-audit + the approved-path runDispatchTick
    // handoff). The runStageAgentLoop helper's result.durationMs only
    // measures the agent-loop slice; using it here would understate
    // agentic dispatch latency relative to the single-shot adapter at
    // dispatch/index.ts which times the whole stage.
    const t0 = Date.now();
    const skillBundle = await resolveSkillBundle('dispatch-discipline');
    // Compose the helper input as a literal so exactOptionalPropertyTypes
    // narrows on the canonAuditPromptBuilder branch (the option-key is
    // either present or omitted; never present-and-undefined). The
    // ternary spreads either an empty object or the property, which TS
    // accepts without the explicit-undefined collision.
    const result = await runStageAgentLoop<VerificationVerdict>({
      stageInput: input,
      stageName: 'dispatch-stage',
      stagePrincipal,
      skillBundle,
      promptBuilder: ({ skillBundle: sb, stageInput, canonAtomIds, stagePrincipal: sp }) =>
        buildDispatchPrompt({
          skillBundle: sb,
          stageInput,
          canonAtomIds: canonAtomIds.map(String),
          stagePrincipal: sp,
        }),
      outputSchema: verificationVerdictSchema,
      agentLoop: config.agentLoop,
      workspaceProvider: config.workspaceProvider,
      blobStore: config.blobStore,
      redactor: config.redactor,
      replayTier: config.replayTier ?? 'best-effort',
      blobThreshold: config.blobThreshold ?? 4096,
      baseRef: config.baseRef ?? 'main',
      ...(config.disableCanonAudit
        ? {}
        : {
            canonAuditPromptBuilder: ({
              producedOutput,
              stageInput,
              canonAtomIds,
            }: {
              producedOutput: VerificationVerdict;
              stageInput: StageInput<unknown>;
              canonAtomIds: ReadonlyArray<string>;
            }) =>
              buildDispatchCanonAuditPrompt({
                producedOutput,
                stageInput,
                canonAtomIds: canonAtomIds.map(String),
              }),
          }),
    });

    // Translate the agent's verification verdict into the substrate-
    // visible DispatchRecordPayload. Rejection short-circuits to the
    // 'gated' shape so the runner halts via auditDispatch's critical
    // finding; approval routes through runDispatchTick so the
    // claim-before-mutate machinery + escalation actor-message writes
    // + low-stakes auto-approve flow all apply unchanged.
    if (result.value.verdict === 'rejected') {
      return {
        value: {
          dispatch_status: 'gated',
          scanned: 0,
          dispatched: 0,
          failed: 0,
          cost_usd: result.costUsd,
          gating_reason: result.value.reason,
        },
        cost_usd: result.costUsd,
        duration_ms: Date.now() - t0,
        atom_type: 'dispatch-record',
      };
    }

    // verdict='approved': hand off to runDispatchTick via the shared
    // pipeline-scoped planFilter helper (extracted in dispatch/index.ts
    // per dev-extract-at-n-2). The single-shot and agentic adapters
    // both use the same filter shape; a per-call-site copy would drift.
    const planFilter = buildPipelineScopedPlanFilter(String(input.pipelineId));
    const tick = await runDispatchTick(input.host, config.registry, {
      planFilter,
    });
    return {
      value: {
        dispatch_status: 'completed',
        scanned: tick.scanned,
        dispatched: tick.dispatched,
        failed: tick.failed,
        cost_usd: result.costUsd,
      },
      cost_usd: result.costUsd,
      duration_ms: Date.now() - t0,
      atom_type: 'dispatch-record',
    };
  }

  return {
    name: 'dispatch-stage',
    outputSchema: dispatchRecordPayloadSchema,
    run,
    // Re-use the single-shot adapter's audit so the gated-finding
    // emission applies uniformly across single-shot and agentic paths.
    // The agentic adapter's canon-audit checkpoint above is
    // supplemental, not a replacement; the substrate-mediated audit()
    // that the runner invokes after run() is still the load-bearing
    // gate the runner's halt-on-critical machinery consumes.
    audit: auditDispatch,
  };
}
