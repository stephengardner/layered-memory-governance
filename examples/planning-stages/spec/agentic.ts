/**
 * Agentic spec-stage adapter.
 *
 * Sibling of the single-shot reference adapter at index.ts. Runs the
 * spec stage as a dispatched agent-loop session bundled with the
 * vendored `writing-clearly` skill markdown so the agent operates
 * under the skill's discipline instead of producing a single-shot
 * paraphrase. The same `specPayloadSchema` zod (re-exported from
 * index.ts) validates the agent's final output, so the runner's
 * persistStageOutput path is unchanged: this adapter emits a payload
 * shape-identical to the single-shot adapter and lands in the typed
 * `spec-output` mint branch.
 *
 * Composition
 * -----------
 * - skill bundle: resolved via skill-bundle-resolver.ts (plugin cache
 *   first, vendored fallback) and embedded in the prompt.
 * - canon binding: handled by runStageAgentLoop -- the canon-bound
 *   pipeline-stage-event lands before the agent dispatches.
 * - tool policy: per-principal pol-llm-tool-policy-spec-author
 *   (Read+Grep+Glob, no writes) loaded automatically by the helper.
 * - workspace: caller supplies the workspace provider; spec-stage is
 *   read-only in posture so a read-only workspace flag (when supported
 *   by the provider) tightens the surface further.
 * - audit: a fresh canon-audit AgentLoopAdapter run with a
 *   citation-and-discipline audit prompt; verdict + findings land on
 *   the canon-audit-complete event.
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
  specPayloadSchema,
  type SpecPayload,
  auditSpec,
} from './index.js';

/** Default principal for the spec stage. */
const SPEC_PRINCIPAL: PrincipalId = 'spec-author' as PrincipalId;

export interface AgenticSpecStageConfig {
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
  /** Override the spec-author principal id (rarely needed). */
  readonly principal?: PrincipalId;
  /** Skip the canon-audit checkpoint (defaults to running it). */
  readonly disableCanonAudit?: boolean;
}

function buildSpecPrompt(opts: {
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
      ? '(no upstream output; ground in seed atom set + operator-intent only)'
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
    // under. Hardcoding 'spec-author' would desync the prompt from the
    // resolved identity at the helper's principal resolution.
    `- principal: ${String(stagePrincipal)}`,
    `- seed atom ids: ${seedAtomIds}`,
    `- canon directives applicable: ${canonAtomIds.length} (you have read access via Read on .lag/atoms/)`,
    `- verified citation set (cite ONLY from these ids; OMIT rather than guess if an id is missing): ${verifiedCited}`,
    '',
    '## Operator-intent (literal text; do NOT abstract)',
    '',
    stageInput.operatorIntentContent.length > 0
      ? stageInput.operatorIntentContent
      : '(no anchor available; ground in seed atom set instead)',
    '',
    '## Upstream brainstorm output (context, not a re-mandate)',
    '',
    priorOutput,
    '',
    '## Your turn',
    '',
    'Synthesize the brainstorm output into a prose-shaped specification',
    'anchored on the literal operator-intent. Use Read, Grep, and Glob',
    'to verify every cited path resolves on disk and every cited atom-id',
    'is in the verified citation set above. Your final-turn text content',
    'MUST be a single JSON object matching the SpecPayload schema. No',
    'prose outside the JSON.',
  ].join('\n');
}

function buildSpecCanonAuditPrompt(opts: {
  readonly producedOutput: SpecPayload;
  readonly stageInput: StageInput<unknown>;
  readonly canonAtomIds: ReadonlyArray<string>;
}): string {
  return [
    'You are a canon-compliance auditor for a deep planning pipeline.',
    'You audit the spec-stage output below against the operator-intent',
    'and the applicable canon directives.',
    '',
    'Verdict criteria:',
    '- approved: output is semantically faithful to the operator-intent;',
    '  goal is concrete and not a meta-task; cited_paths resolve;',
    '  cited_atom_ids are in the verified set; alternatives_rejected',
    '  records substantively different options with real trade-offs.',
    '- issues-found: any of the above is violated. List findings with',
    '  severity (critical | major | minor), category, message.',
    '',
    'Operator-intent (literal):',
    opts.stageInput.operatorIntentContent || '(none)',
    '',
    'Spec output:',
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

export function buildAgenticSpecStage(
  config: AgenticSpecStageConfig,
): PlanningStage<unknown, SpecPayload> {
  const stagePrincipal = config.principal ?? SPEC_PRINCIPAL;

  async function run(
    input: StageInput<unknown>,
  ): Promise<StageOutput<SpecPayload>> {
    const skillBundle = await resolveSkillBundle('writing-clearly');
    // Compose the helper input as a literal so exactOptionalPropertyTypes
    // narrows on the canonAuditPromptBuilder branch (the option-key is
    // either present or omitted; never present-and-undefined). The
    // ternary spreads either an empty object or the property, which TS
    // accepts without the explicit-undefined collision.
    const result = await runStageAgentLoop<SpecPayload>({
      stageInput: input,
      stageName: 'spec-stage',
      stagePrincipal,
      skillBundle,
      promptBuilder: ({ skillBundle: sb, stageInput, canonAtomIds, stagePrincipal: sp }) =>
        buildSpecPrompt({
          skillBundle: sb,
          stageInput,
          canonAtomIds: canonAtomIds.map(String),
          stagePrincipal: sp,
        }),
      outputSchema: specPayloadSchema,
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
              producedOutput: SpecPayload;
              stageInput: StageInput<unknown>;
              canonAtomIds: ReadonlyArray<string>;
            }) =>
              buildSpecCanonAuditPrompt({
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
      atom_type: 'spec-output',
    };
  }

  return {
    name: 'spec-stage',
    outputSchema: specPayloadSchema,
    run,
    // Re-use the single-shot adapter's audit so the citation-closure
    // checks (cite-set membership + resolvable atom-id + reachable
    // path) apply uniformly across single-shot and agentic paths. The
    // agentic adapter's canon-audit checkpoint above is supplemental,
    // not a replacement; the substrate-mediated audit() that the
    // runner invokes after run() is still the load-bearing gate.
    audit: auditSpec,
  };
}
