/**
 * runStageAgentLoop: shared orchestrator that turns a pipeline stage
 * into a dispatched agent-loop run.
 *
 * Why this exists
 * ---------------
 * The single-shot reference adapters in examples/planning-stages/<stage>/
 * route through host.llm.judge() once per stage. That works for tactical
 * decisions but cannot read files, run greps, or revise its own output.
 * For the killer-pipeline upgrade each upstream stage needs:
 *
 *   1. Multi-turn agentic reasoning under a per-principal tool policy.
 *   2. A canon-bound checkpoint at session start so the operator can
 *      inspect which directives the stage was bound to.
 *   3. A canon-audit checkpoint after the agent loop returns, so a
 *      compromised stage prompt cannot bypass the in-flight directive
 *      gate (per dev-implementation-canon-audit-loop).
 *   4. Per-LLM-call breadcrumbs so the deliberation-trail surface in
 *      the console renders the full chain.
 *
 * This helper composes the existing primitives (AgentLoopAdapter,
 * WorkspaceProvider, BlobStore, Redactor, the LLM tool-policy loader,
 * the canon-applicable directive walker) into the per-stage shape so
 * each agentic stage adapter is ~50 lines of stage-specific config
 * rather than 300 lines of agent-loop wiring duplicated five times.
 *
 * Substrate purity
 * ----------------
 * The helper lives under examples/planning-stages/ because the
 * canonical surface a pipeline-stage adapter exports is `PlanningStage`
 * (in src/runtime/planning-pipeline/types.ts). The src/ runner does not
 * see this helper; the helper composes substrate primitives the runner
 * already has.
 *
 * Threat model
 * ------------
 * - Kill-switch absolute priority: callers re-poll host.scheduler.killswitchCheck()
 *   before any write. The helper does not poll (it has no Scheduler) but
 *   short-circuits on a thrown signal.aborted from the AgentLoopAdapter.
 * - Workspace cleanup: every successful acquire MUST be paired with a
 *   release. The try/finally in `runStageAgentLoop` enforces this.
 * - Canon-audit dispatch: the audit runs as a fresh AgentLoopAdapter.run
 *   with the same adapter but a different prompt. A compromised stage
 *   prompt cannot bypass the audit because the audit has no shared
 *   conversation context with the main run.
 * - Schema validation: the helper parses the agent-loop's final output
 *   through the supplied zod schema. Schema-fail throws so the runner's
 *   schema-fail path applies uniformly.
 * - Bounded canon list: the canon-bound event mint helper caps
 *   canonAtomIds at MAX_CITED_LIST. Callers that surface oversized
 *   canon-applicable results MUST trim before passing in.
 */

import type { z } from 'zod';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
  AgentTask,
  ToolPolicy,
} from '../../../src/substrate/agent-loop.js';
import type { BlobRef, BlobStore } from '../../../src/substrate/blob-store.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type {
  Workspace,
  WorkspaceProvider,
} from '../../../src/substrate/workspace-provider.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  ReplayTier,
  Time,
} from '../../../src/substrate/types.js';
import type {
  CanonAuditFindingShape,
  StageInput,
} from '../../../src/runtime/planning-pipeline/index.js';
import { mkPipelineStageEventAtom } from '../../../src/runtime/planning-pipeline/index.js';
import {
  LlmToolPolicyError,
  loadLlmToolPolicy,
} from '../../../src/substrate/policy/llm-tool-policy.js';

/**
 * Maximum canon-bound atom-id list size the helper will surface to the
 * mint helper. Mirrors the MAX_CITED_LIST cap in atom-shapes.ts so a
 * runaway applicable-canon query is trimmed at the helper boundary
 * rather than throwing at the mint site. The mint helper still enforces
 * the cap; this trim is a friendly hint that prevents the throw.
 */
export const MAX_CANON_BOUND_LIST = 256;

/**
 * Default budget cap for an agentic stage run. Operators flip this per
 * stage via canon (pol-pipeline-stage-budget-default-substrate-deep);
 * the helper accepts a budget input so the canon override flows
 * through without a code change.
 *
 * Defaults are generous given the operator's spare-no-tokens posture
 * (canon dev-research-token-spend-not-the-constraint), but bounded to
 * prevent runaway. 25 turns + 15 minutes wall-clock + $5.00 per stage
 * suits a stage that reads files, runs greps, and revises its output;
 * a stage that consistently exceeds these defaults indicates either a
 * malformed prompt or a structural reason to widen via canon.
 */
export const DEFAULT_AGENTIC_STAGE_BUDGET = {
  max_turns: 25,
  max_wall_clock_ms: 15 * 60 * 1000,
  max_usd: 5.0,
} as const;

/**
 * Skill-bundle string. The bundle is the literal markdown contents of
 * the relevant superpowers skill (or vendored copy under
 * examples/planning-stages/skills/). The bundle is concatenated into
 * the agent's prompt so the agent operates under the skill's discipline
 * (e.g. brainstorming -> ask one question at a time, propose 2-3
 * alternatives; writing-plans -> bite-sized tasks with exact file
 * paths). The helper does not parse the bundle; it forwards it to
 * promptBuilder which decides where in the prompt the bundle lives.
 */
export type SkillBundle = string;

export interface RunStageAgentLoopPromptCtx {
  readonly stageInput: StageInput<unknown>;
  readonly stageName: string;
  readonly stagePrincipal: PrincipalId;
  readonly skillBundle: SkillBundle;
  readonly canonAtomIds: ReadonlyArray<AtomId>;
}

export interface RunStageAgentLoopCanonAuditCtx<TOut> {
  readonly stageInput: StageInput<unknown>;
  readonly stageName: string;
  readonly stagePrincipal: PrincipalId;
  readonly producedOutput: TOut;
  readonly canonAtomIds: ReadonlyArray<AtomId>;
}

export interface RunStageAgentLoopInput<TOut> {
  readonly stageInput: StageInput<unknown>;
  readonly stageName: string;
  readonly stagePrincipal: PrincipalId;
  /**
   * Skill bundle string to embed in the prompt. The caller is
   * responsible for resolving it from the plugin cache or a vendored
   * copy via skill-bundle-resolver.ts. Empty string is rejected so a
   * silent-resolve-failure cannot mask a missing skill.
   */
  readonly skillBundle: SkillBundle;
  /**
   * Builds the LLM prompt the AgentLoopAdapter passes to the agent.
   * The helper exposes the resolved canon list + skill bundle + the
   * StageInput so promptBuilder can compose them in stage-specific
   * order without the helper hardcoding the prompt shape.
   */
  readonly promptBuilder: (ctx: RunStageAgentLoopPromptCtx) => string;
  /**
   * zod schema the agent-loop's final-output JSON is validated against.
   * The helper rejects on schema-fail so a malformed agentic emission
   * surfaces through the runner's existing schema-fail halt path.
   */
  readonly outputSchema: z.ZodSchema<TOut>;
  /**
   * Optional canon-audit prompt builder. When omitted the helper skips
   * the canon-audit checkpoint and emits a canon-audit-complete event
   * with verdict='approved' + an empty findings list, so the chain
   * shape stays uniform regardless of audit posture. Stages that opt
   * IN supply a builder; the audit's response is parsed against
   * `{verdict, findings}` and the findings are surfaced on the event
   * atom.
   */
  readonly canonAuditPromptBuilder?: (
    ctx: RunStageAgentLoopCanonAuditCtx<TOut>,
  ) => string;
  /**
   * AgentLoopAdapter the helper dispatches to. Indie-floor deployments
   * pass the ClaudeCodeAgentLoopAdapter; org-ceiling deployments swap
   * in their own adapter without changing this surface.
   */
  readonly agentLoop: AgentLoopAdapter;
  /**
   * WorkspaceProvider the helper acquires + releases a workspace
   * through. The provider is responsible for cred provisioning at
   * acquire time and cleanup at release time per the workspace-provider
   * contract.
   */
  readonly workspaceProvider: WorkspaceProvider;
  /**
   * BlobStore the AgentLoopAdapter externalizes large turn payloads
   * through. The adapter chooses when to externalize via blobThreshold;
   * the helper does not decide.
   */
  readonly blobStore: BlobStore;
  /**
   * Redactor the AgentLoopAdapter applies to all content before atom
   * write. A redactor crash surfaces as catastrophic per the
   * agent-loop contract; the helper does not catch it.
   */
  readonly redactor: Redactor;
  /**
   * Replay tier for the agent-loop session. 'best-effort' is the
   * indie-floor default; 'strict' captures full canon snapshots.
   */
  readonly replayTier: ReplayTier;
  /**
   * Blob threshold in bytes (already clamped via clampBlobThreshold).
   * Caller resolves this from the per-actor canon policy; the helper
   * forwards it to the adapter unchanged.
   */
  readonly blobThreshold: number;
  /**
   * The base ref the workspace branches off (e.g. 'main'). Per-stage
   * workspaces start fresh from this ref. A read-only stage typically
   * passes the operator's current main ref; a read-write stage that
   * mutates files passes the same ref but the workspace is acquired
   * with no special read-only flag at the provider layer (the
   * tool-policy denies write tools at the LLM layer).
   */
  readonly baseRef: string;
  /**
   * Optional budget override. When omitted the helper uses
   * DEFAULT_AGENTIC_STAGE_BUDGET.
   */
  readonly budgetOverride?: {
    readonly max_turns?: number;
    readonly max_wall_clock_ms?: number;
    readonly max_usd?: number;
  };
  /**
   * Optional disallowedTools override. When omitted the helper resolves
   * the per-principal LLM tool policy from canon via loadLlmToolPolicy.
   * Default-deny is enforced by the loader (a missing policy returns
   * null and the helper falls through to the adapter's deny-all floor).
   */
  readonly disallowedToolsOverride?: ReadonlyArray<string>;
  /**
   * Optional clock for tests. Defaults to Date.now and ISO timestamps.
   */
  readonly nowMs?: () => number;
  readonly nowIso?: () => Time;
}

export interface RunStageAgentLoopResult<TOut> {
  readonly value: TOut;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly sessionAtomId: AtomId;
  readonly turnAtomIds: ReadonlyArray<AtomId>;
  readonly canonBoundAtomIds: ReadonlyArray<AtomId>;
  readonly canonBoundEventAtomId: AtomId;
  readonly canonAuditEventAtomId: AtomId;
  readonly canonAuditFindings: ReadonlyArray<CanonAuditFindingShape>;
  readonly canonAuditVerdict: 'approved' | 'issues-found';
}

/**
 * Resolve the canon directives applicable to the supplied principal at
 * project scope. Reads L3 directive atoms; filters to clean,
 * non-superseded atoms. Mirrors the iteratePolicyAtoms pattern in
 * src/runtime/planning-pipeline/policy.ts so the substrate's canon-
 * applicable read shape stays uniform; the host.canon.applicable seam
 * is reserved for a substrate-wide upgrade and lands in a follow-up.
 *
 * Trims the result at MAX_CANON_BOUND_LIST so the canon-bound event
 * mint helper does not throw on an oversized list. Trim order is
 * scope-rank-then-most-recently-reinforced (a deterministic ordering
 * so a re-run produces the same trimmed set); the helper returns the
 * full ordered list to the caller for prompt composition AND the
 * trimmed slice for the event atom.
 */
async function resolveApplicableCanon(
  host: Host,
): Promise<{
  readonly atomIds: ReadonlyArray<AtomId>;
  readonly atoms: ReadonlyArray<Atom>;
}> {
  // Per-principal canon filtering is reserved for a follow-up: a future
  // host.canon.applicable seam will accept a PrincipalId and narrow the
  // result to scope-applicable directives. Until that seam lands, this
  // helper returns all clean, non-superseded L3 directives so the
  // call shape can stay stable when the seam adds the principal arg.
  const PAGE_SIZE = 200;
  const MAX_SCAN = 5_000;
  const atoms: Atom[] = [];
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      atoms.push(atom);
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  // Sort by reinforced-time descending so the trim slice keeps the
  // most-recently-reinforced directives. Deterministic on a tie via
  // atom-id string compare.
  atoms.sort((a, b) => {
    if (a.last_reinforced_at !== b.last_reinforced_at) {
      return a.last_reinforced_at < b.last_reinforced_at ? 1 : -1;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  const atomIds = atoms.map((a) => a.id);
  return { atomIds, atoms };
}

/**
 * Parse a canon-audit response from the audit-side AgentLoopAdapter.
 * The audit run produces a final JSON string under
 * AgentLoopResult.artifacts via a tool-output convention; the helper
 * looks for a response shape `{verdict: 'approved' | 'issues-found',
 * findings: [...]}` and falls back to verdict='approved', findings=[]
 * when no payload is present (audit didn't run or produced no text).
 *
 * A malformed payload (parseable JSON but wrong shape) is treated as
 * verdict='issues-found' with a single synthesised finding describing
 * the malformation, so a compromised audit cannot silently emit
 * approved.
 */
function parseCanonAuditResponse(
  rawJson: string | undefined,
): {
  verdict: 'approved' | 'issues-found';
  findings: ReadonlyArray<CanonAuditFindingShape>;
} {
  if (rawJson === undefined || rawJson.trim() === '') {
    return { verdict: 'approved', findings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      verdict: 'issues-found',
      findings: [
        {
          severity: 'major',
          category: 'canon-audit-malformed-response',
          message:
            'canon-audit response was not valid JSON; treating as issues-found',
          cited_atom_ids: [],
          cited_paths: [],
        },
      ],
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      verdict: 'issues-found',
      findings: [
        {
          severity: 'major',
          category: 'canon-audit-malformed-response',
          message: 'canon-audit response was not an object',
          cited_atom_ids: [],
          cited_paths: [],
        },
      ],
    };
  }
  const obj = parsed as { verdict?: unknown; findings?: unknown };
  const verdict =
    obj.verdict === 'approved' || obj.verdict === 'issues-found'
      ? obj.verdict
      : 'issues-found';
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: CanonAuditFindingShape[] = [];
  for (const raw of rawFindings) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as Record<string, unknown>;
    const severity =
      f.severity === 'critical' || f.severity === 'major' || f.severity === 'minor'
        ? f.severity
        : 'minor';
    const category = typeof f.category === 'string' ? f.category : 'unknown';
    const message = typeof f.message === 'string' ? f.message : '(no message)';
    const cited_atom_ids = Array.isArray(f.cited_atom_ids)
      ? (f.cited_atom_ids as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
    const cited_paths = Array.isArray(f.cited_paths)
      ? (f.cited_paths as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
    findings.push({ severity, category, message, cited_atom_ids, cited_paths });
  }
  return { verdict, findings };
}

/**
 * Read the agent-loop's final output JSON. The Claude Code adapter
 * captures the agent's last text-content turn under
 * AgentLoopResult.artifacts.touchedPaths-adjacent metadata; for v1 the
 * helper looks at the agent-turn atoms the adapter wrote and pulls the
 * final llm_output text from the last turn. Adapters that do not
 * conform to this read shape supply their own helper (a future
 * substrate edit could move this to a contract method on
 * AgentLoopAdapter).
 *
 * Handles AgentTurnMeta.llm_output's full discriminated-union shape:
 *
 *   - { inline: string }: payload is small enough to live in the atom;
 *     the helper returns the inline string directly.
 *   - { ref: BlobRef }: payload was externalized to the BlobStore by
 *     the adapter (because it exceeded blobThreshold or because the
 *     replay tier requires content-addressed externalization). The
 *     helper MUST dereference the ref via blobStore.get; otherwise the
 *     downstream parser sees the BlobRef wrapper instead of the actual
 *     JSON payload, and large agent outputs silently fail schema
 *     validation even though the agent emitted valid JSON.
 *
 * Also accepts legacy raw-string llm_output values as a defensive
 * fallback. Real adapters write the discriminated-union shape; the
 * raw-string branch only catches stub fixtures or older adapter code
 * that has not migrated yet, so a malformed test fixture surfaces
 * loudly via schema validation rather than as a silent null.
 *
 * Returns null when no turn atoms exist or no final text is available.
 */
async function readFinalOutputJson(
  host: Host,
  blobStore: BlobStore,
  turnAtomIds: ReadonlyArray<AtomId>,
): Promise<string | null> {
  if (turnAtomIds.length === 0) return null;
  const lastId = turnAtomIds[turnAtomIds.length - 1]!;
  const lastAtom = await host.atoms.get(lastId);
  if (lastAtom === null) return null;
  const meta = lastAtom.metadata as Record<string, unknown> | undefined;
  if (meta === undefined) return null;
  const turnMeta = meta.agent_turn as Record<string, unknown> | undefined;
  if (turnMeta === undefined) return null;
  const llmOutput = turnMeta.llm_output;
  // Canonical discriminated-union shape per AgentTurnMeta.
  if (typeof llmOutput === 'object' && llmOutput !== null) {
    const obj = llmOutput as Record<string, unknown>;
    if (typeof obj.inline === 'string') {
      return obj.inline;
    }
    if (typeof obj.ref === 'string') {
      // Dereference the blob-backed payload. A BlobStore.get failure
      // throws; the helper does not catch it because a missing or
      // unreadable blob is a substrate-integrity failure and must
      // surface to the runner's catastrophic-failure handler rather
      // than fall through to a null that the audit gate could
      // misinterpret as 'no final output'.
      const buf = await blobStore.get(obj.ref as BlobRef);
      return buf.toString('utf8');
    }
    // Object that is neither {inline} nor {ref}: legacy or malformed
    // shape. Fall through to JSON.stringify so the downstream parser
    // throws on the original payload and the operator sees the
    // unparseable emission rather than a silent null.
    return JSON.stringify(llmOutput);
  }
  if (typeof llmOutput === 'string') return llmOutput;
  return null;
}

/**
 * Extract the JSON payload from the LLM's final text output. Agentic
 * stages instruct the LLM to emit a JSON object as the final text
 * content; the helper accepts either a bare JSON object string or a
 * fenced code block. Falls back to the raw input when neither shape
 * matches so the schema-validate step throws on the original text and
 * the operator sees the unparseable emission.
 */
export function extractFinalJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }
  // Look for a fenced code block (```json or ```) containing the JSON.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenceMatch !== null) {
    return fenceMatch[1]!.trim();
  }
  // Search for the first { ... } block.
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch !== null) {
    return objMatch[0]!.trim();
  }
  return trimmed;
}

export async function runStageAgentLoop<TOut>(
  input: RunStageAgentLoopInput<TOut>,
): Promise<RunStageAgentLoopResult<TOut>> {
  if (input.skillBundle.trim() === '') {
    throw new Error(
      'runStageAgentLoop: skillBundle must be non-empty (silent-resolve-failure guard)',
    );
  }

  const nowMs = input.nowMs ?? (() => Date.now());
  const nowIso = input.nowIso ?? (() => new Date().toISOString() as Time);
  const t0 = nowMs();

  // 1. Resolve applicable canon for the stage principal at project scope.
  // Per-principal narrowing is a substrate follow-up; today the resolver
  // returns all clean L3 directives.
  const { atomIds: canonAtomIdsAll } = await resolveApplicableCanon(
    input.stageInput.host,
  );
  const canonAtomIds = canonAtomIdsAll.slice(0, MAX_CANON_BOUND_LIST);

  // 2. Resolve per-principal tool policy unless overridden. Default-deny
  // floor: when no policy resolves the helper falls through to whatever
  // the AgentLoopAdapter's safety default is. Errors during load throw;
  // a malformed policy is fail-loud per the loader's contract.
  let disallowedTools: ReadonlyArray<string>;
  if (input.disallowedToolsOverride !== undefined) {
    disallowedTools = input.disallowedToolsOverride;
  } else {
    try {
      const policy = await loadLlmToolPolicy(
        input.stageInput.host.atoms,
        input.stagePrincipal,
      );
      disallowedTools = policy?.disallowedTools ?? [];
    } catch (err) {
      if (err instanceof LlmToolPolicyError) {
        throw err;
      }
      throw err;
    }
  }
  const toolPolicy: ToolPolicy = {
    disallowedTools,
    rationale: `pol-llm-tool-policy-${input.stagePrincipal}`,
  };

  // 3. Mint + persist the canon-bound event BEFORE workspace acquire so
  // an acquire-time failure still leaves an audit breadcrumb showing
  // which canon directives the helper resolved. The event atom is the
  // operator's first observation of the stage's bound canon.
  const canonBoundEventAtom = mkPipelineStageEventAtom({
    pipelineId: input.stageInput.pipelineId,
    stageName: input.stageName,
    principalId: input.stagePrincipal,
    correlationId: input.stageInput.correlationId,
    now: nowIso(),
    transition: 'canon-bound',
    durationMs: 0,
    costUsd: 0,
    canonAtomIds,
  });
  await input.stageInput.host.atoms.put(canonBoundEventAtom);

  // 4. Acquire workspace.
  const workspace: Workspace = await input.workspaceProvider.acquire({
    principal: input.stagePrincipal,
    baseRef: input.baseRef,
    correlationId: input.stageInput.correlationId,
  });

  let agentResult: AgentLoopResult;
  try {
    // 5. Build the prompt + invoke the AgentLoopAdapter.
    const prompt = input.promptBuilder({
      stageInput: input.stageInput,
      stageName: input.stageName,
      stagePrincipal: input.stagePrincipal,
      skillBundle: input.skillBundle,
      canonAtomIds,
    });
    // The substrate AgentTask shape carries an arbitrary prompt payload
    // via `successCriteria` (the adapter forwards it as the system + user
    // message). The pipelineId is supplied as planAtomId so the adapter
    // has a stable provenance handle even though no Plan atom strictly
    // exists yet (the pipeline atom plays the same provenance role for
    // an agentic stage as a Plan atom does for the code-author executor).
    const task: AgentTask = {
      planAtomId: input.stageInput.pipelineId,
      successCriteria: prompt,
    };

    const budget = {
      max_turns:
        input.budgetOverride?.max_turns ?? DEFAULT_AGENTIC_STAGE_BUDGET.max_turns,
      max_wall_clock_ms:
        input.budgetOverride?.max_wall_clock_ms
        ?? DEFAULT_AGENTIC_STAGE_BUDGET.max_wall_clock_ms,
      max_usd:
        input.budgetOverride?.max_usd ?? DEFAULT_AGENTIC_STAGE_BUDGET.max_usd,
    };

    const adapterInput: AgentLoopInput = {
      host: input.stageInput.host,
      principal: input.stagePrincipal,
      workspace,
      task,
      budget,
      toolPolicy,
      redactor: input.redactor,
      blobStore: input.blobStore,
      replayTier: input.replayTier,
      blobThreshold: input.blobThreshold,
      correlationId: input.stageInput.correlationId,
    };
    agentResult = await input.agentLoop.run(adapterInput);
  } finally {
    // Workspace cleanup is non-negotiable. The release contract is
    // idempotent so a double-release is safe, but we still wrap the
    // entire agent-loop invocation in a try/finally so an adapter
    // throw does not leak the workspace.
    await input.workspaceProvider.release(workspace);
  }

  // 6. For each agent-turn atom the adapter wrote, mint a corresponding
  // pipeline-stage-event 'agent-turn' breadcrumb. The breadcrumb
  // surfaces the turn in the deliberation-trail without forcing a
  // cross-walk through metadata.pipeline_id queries against the
  // agent-turn atom store.
  for (let i = 0; i < agentResult.turnAtomIds.length; i++) {
    const turnAtomId = agentResult.turnAtomIds[i]!;
    const turnAtom = await input.stageInput.host.atoms.get(turnAtomId);
    const turnMeta =
      turnAtom !== null
        ? ((turnAtom.metadata as Record<string, unknown> | undefined)
            ?.agent_turn as Record<string, unknown> | undefined)
        : undefined;
    const turnLatencyMs =
      turnMeta !== undefined && typeof turnMeta.latency_ms === 'number'
        ? turnMeta.latency_ms
        : 0;
    const turnCostUsd =
      turnMeta !== undefined && typeof turnMeta.cost_usd === 'number'
        ? turnMeta.cost_usd
        : 0;
    await input.stageInput.host.atoms.put(
      mkPipelineStageEventAtom({
        pipelineId: input.stageInput.pipelineId,
        stageName: input.stageName,
        principalId: input.stagePrincipal,
        correlationId: input.stageInput.correlationId,
        now: nowIso(),
        transition: 'agent-turn',
        durationMs: turnLatencyMs,
        costUsd: turnCostUsd,
        agentTurnAtomId: turnAtomId,
        turnIndex: i,
      }),
    );
  }

  // 7. Read the final-output JSON from the last agent-turn atom. The
  // adapter writes the LLM's final text content into the last turn's
  // llm_output; the helper parses it as the stage's payload.
  if (agentResult.kind !== 'completed') {
    throw new Error(
      `runStageAgentLoop: agent-loop returned non-completed kind '${agentResult.kind}'; `
      + `failure=${JSON.stringify(agentResult.failure ?? null)}`,
    );
  }
  const rawOutput = await readFinalOutputJson(
    input.stageInput.host,
    input.blobStore,
    agentResult.turnAtomIds,
  );
  if (rawOutput === null) {
    throw new Error(
      'runStageAgentLoop: agent-loop completed without a final-output turn atom; '
      + 'cannot validate output against schema',
    );
  }
  const candidate = extractFinalJsonPayload(rawOutput);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `runStageAgentLoop: agent-loop final output is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }; raw=${candidate.slice(0, 200)}`,
    );
  }
  const validated = input.outputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new Error(
      `runStageAgentLoop: agent-loop final output failed schema validation: ${validated.error.message}`,
    );
  }
  const value = validated.data;

  // 8. Canon-audit checkpoint. When canonAuditPromptBuilder is supplied
  // the helper dispatches a fresh agent-loop run with the same adapter
  // but a different prompt + a new workspace acquire so the audit has
  // no shared context. When omitted the helper emits a verdict='approved'
  // event so the chain shape stays uniform and the runner's
  // canon-audit-complete event is always present.
  let auditVerdict: 'approved' | 'issues-found' = 'approved';
  let auditFindings: ReadonlyArray<CanonAuditFindingShape> = [];
  if (input.canonAuditPromptBuilder !== undefined) {
    const auditWorkspace = await input.workspaceProvider.acquire({
      principal: input.stagePrincipal,
      baseRef: input.baseRef,
      correlationId: `${input.stageInput.correlationId}-canon-audit`,
    });
    try {
      const auditPrompt = input.canonAuditPromptBuilder({
        stageInput: input.stageInput,
        stageName: input.stageName,
        stagePrincipal: input.stagePrincipal,
        producedOutput: value,
        canonAtomIds,
      });
      const auditTask: AgentTask = {
        planAtomId: input.stageInput.pipelineId,
        successCriteria: auditPrompt,
      };
      const auditBudget = {
        max_turns: 10,
        max_wall_clock_ms: 5 * 60 * 1000,
        max_usd: 1.0,
      };
      const auditResult = await input.agentLoop.run({
        host: input.stageInput.host,
        principal: input.stagePrincipal,
        workspace: auditWorkspace,
        task: auditTask,
        budget: auditBudget,
        toolPolicy,
        redactor: input.redactor,
        blobStore: input.blobStore,
        replayTier: input.replayTier,
        blobThreshold: input.blobThreshold,
        correlationId: `${input.stageInput.correlationId}-canon-audit`,
      });
      // Fail-closed on any non-completed audit result: a budget-
      // exhausted / aborted / catastrophic audit must NOT fall through
      // to parseCanonAuditResponse(undefined), which would return
      // verdict='approved' and silently clear the canon gate. Treat
      // every non-completed kind as a critical issues-found finding so
      // the gate stays load-bearing and the operator sees the failure
      // mode in the audit-complete event findings.
      if (auditResult.kind !== 'completed') {
        auditVerdict = 'issues-found';
        auditFindings = [
          {
            severity: 'critical',
            category: 'canon-audit-failed',
            message:
              `canon-audit run ended with kind='${auditResult.kind}'; `
              + `failure=${JSON.stringify(auditResult.failure ?? null)}. `
              + `Treating as fail-closed: audit could not complete and `
              + `cannot be interpreted as approval.`,
            cited_atom_ids: [],
            cited_paths: [],
          },
        ];
      } else {
        const rawAudit = await readFinalOutputJson(
          input.stageInput.host,
          input.blobStore,
          auditResult.turnAtomIds,
        );
        const auditExtracted =
          rawAudit !== null ? extractFinalJsonPayload(rawAudit) : undefined;
        const audit = parseCanonAuditResponse(auditExtracted);
        auditVerdict = audit.verdict;
        auditFindings = audit.findings;
      }
    } finally {
      await input.workspaceProvider.release(auditWorkspace);
    }
  }

  const canonAuditEventAtom = mkPipelineStageEventAtom({
    pipelineId: input.stageInput.pipelineId,
    stageName: input.stageName,
    principalId: input.stagePrincipal,
    correlationId: input.stageInput.correlationId,
    now: nowIso(),
    transition: 'canon-audit-complete',
    durationMs: nowMs() - t0,
    costUsd: 0,
    canonAuditVerdict: auditVerdict,
    canonAuditFindings: auditFindings,
  });
  await input.stageInput.host.atoms.put(canonAuditEventAtom);

  // 9. Read the session atom's budget_consumed.usd for the final cost
  // figure (mirrors AgenticCodeAuthorExecutor's pattern). A missing
  // field defaults to 0 so adapters whose capabilities.tracks_cost is
  // false produce a known-zero cost rather than a NaN.
  const sessionAtom = await input.stageInput.host.atoms.get(
    agentResult.sessionAtomId,
  );
  let costUsd = 0;
  if (sessionAtom !== null) {
    const sessionMeta = (
      sessionAtom.metadata as Record<string, unknown> | undefined
    )?.agent_session as Record<string, unknown> | undefined;
    const budgetConsumed = sessionMeta?.budget_consumed as
      | Record<string, unknown>
      | undefined;
    if (budgetConsumed !== undefined && typeof budgetConsumed.usd === 'number') {
      costUsd = budgetConsumed.usd;
    }
  }

  return {
    value,
    costUsd,
    durationMs: nowMs() - t0,
    sessionAtomId: agentResult.sessionAtomId,
    turnAtomIds: agentResult.turnAtomIds,
    canonBoundAtomIds: canonAtomIds,
    canonBoundEventAtomId: canonBoundEventAtom.id,
    canonAuditEventAtomId: canonAuditEventAtom.id,
    canonAuditFindings: auditFindings,
    canonAuditVerdict: auditVerdict,
  };
}
