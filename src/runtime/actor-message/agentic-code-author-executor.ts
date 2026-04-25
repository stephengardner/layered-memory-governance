/**
 * Agentic CodeAuthorExecutor: composes the agentic-actor-loop substrate
 * (AgentLoopAdapter + WorkspaceProvider + BlobStore + Redactor + the
 * two policy resolvers) into a CodeAuthorExecutor implementation.
 *
 * For each invocation:
 *   1. Resolve the per-principal-or-per-actor-type replay-tier and
 *      blob-threshold policies.
 *   2. Acquire an isolated workspace via `WorkspaceProvider.acquire()`.
 *   3. Run the agent loop via `AgentLoopAdapter.run()`. The adapter
 *      writes session + turn atoms; the executor does not mint atoms
 *      itself.
 *   4. On `result.kind === 'completed'` with a `commitSha` + branchName,
 *      create a PR via the existing `GhClient`.
 *   5. Map any non-completed result onto a `CodeAuthorExecutorFailure`
 *      keyed by the underlying `FailureKind`.
 *   6. Always release the workspace (try/finally).
 *
 * Stage map (failure paths):
 *   - agentic/policy-resolution         -> policy parser threw
 *   - agentic/workspace-acquire         -> WorkspaceProvider.acquire threw
 *   - agentic/agent-loop/transient      -> adapter returned failure.kind = 'transient'
 *   - agentic/agent-loop/structural     -> adapter returned failure.kind = 'structural'
 *   - agentic/agent-loop/catastrophic   -> adapter returned failure.kind = 'catastrophic'
 *   - agentic/agent-loop/unknown        -> adapter returned 'error' without a structured failure
 *   - agentic/budget-exhausted          -> adapter returned 'budget-exhausted' without a failure
 *   - agentic/budget-exhausted/<kind>   -> adapter returned 'budget-exhausted' with a failure
 *   - agentic/aborted                   -> adapter returned 'aborted' without a failure
 *   - agentic/aborted/<kind>            -> adapter returned 'aborted' with a failure
 *   - agentic/no-artifacts              -> adapter returned 'completed' without commitSha + branchName
 *   - agentic/pr-creation               -> GhClient PR-create threw
 *   - agentic/adapter-threw/<kind>      -> adapter threw rather than returning a structured result
 *
 * Threat model
 * ------------
 * - The executor does NOT spawn the LLM itself; it composes whatever
 *   AgentLoopAdapter the operator wires. Vendor lock-in is avoided.
 * - The workspace inherits whatever credentials the WorkspaceProvider
 *   provisioned. Cred scope is the provider's responsibility.
 * - The `AgentLoopResult.artifacts.commitSha` is adapter-supplied; a
 *   misbehaving adapter could fabricate a SHA. PR2 ships the seam
 *   without a verification step; a future hardening pass enforces
 *   commit-existence verification before PR creation.
 * - Workspace cleanup-on-error is non-negotiable: the try/finally in
 *   execute() ALWAYS calls release(), even if the adapter throws.
 *   Tests pin this; a leak here would burn disk + leave bot creds
 *   orphaned in temp dirs.
 * - Policy resolution failures (a malformed policy atom) propagate as
 *   `agentic/policy-resolution` rather than silently fall back to the
 *   default tier/threshold. A malformed policy is a deployment error
 *   worth surfacing.
 */

import type { Atom, AtomId, FailureKind, PrincipalId, ReplayTier } from '../../substrate/types.js';
import type { Host } from '../../substrate/interface.js';
import type { GhClient } from '../../external/github/index.js';
import type { CodeAuthorFence } from '../actors/code-author/fence.js';
import type {
  AgentLoopAdapter,
  AgentLoopResult,
  AgentTask,
} from '../../substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider } from '../../substrate/workspace-provider.js';
import type { BlobStore } from '../../substrate/blob-store.js';
import type { Redactor } from '../../substrate/redactor.js';
import { defaultBudgetCap, type BudgetCap } from '../../substrate/agent-budget.js';
import { loadReplayTier } from '../../substrate/policy/replay-tier.js';
import { loadBlobThreshold } from '../../substrate/policy/blob-threshold.js';
import { createDraftPr, renderPrBody, PrCreationError } from '../actors/code-author/pr-creation.js';
import type {
  CodeAuthorExecutor,
  CodeAuthorExecutorResult,
} from './code-author-invoker.js';

export interface AgenticExecutorConfig {
  /**
   * Substrate host the executor reads policies from + signs atoms via.
   * Captured at factory-construction time (mirrors the
   * DiffBasedExecutorConfig.host shape). The
   * CodeAuthorExecutor.execute() contract takes no `host` input;
   * tests that need cross-host scenarios construct multiple executor
   * instances rather than threading host through inputs.
   */
  readonly host: Host;
  /** The executor's own principal id. Drives policy resolution + atom signing. */
  readonly principal: PrincipalId;
  /**
   * Actor-type label (the substrate-vocabulary string) the policy
   * resolvers use to look up per-actor-type policies. Misspelling here
   * silently picks a different policy bucket.
   */
  readonly actorType: string;
  readonly agentLoop: AgentLoopAdapter;
  readonly workspaceProvider: WorkspaceProvider;
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;
  readonly ghClient: GhClient;
  readonly owner: string;
  readonly repo: string;
  /** Base ref the workspace is created off (e.g. 'main'). */
  readonly baseRef: string;
  readonly model: string;
  /** Draft PR by default; operator can flip per deployment. */
  readonly draft?: boolean;
}

export function buildAgenticCodeAuthorExecutor(
  config: AgenticExecutorConfig,
): CodeAuthorExecutor {
  const draft = config.draft ?? true;

  return {
    async execute(inputs): Promise<CodeAuthorExecutorResult> {
      const { plan, fence, correlationId, observationAtomId, signal } = inputs;
      const { host } = config;

      // 1. Resolve policies (fail-loud on malformed; default on missing).
      let replayTier: ReplayTier;
      let blobThreshold: number;
      try {
        replayTier = await loadReplayTier(host.atoms, config.principal, config.actorType);
        blobThreshold = await loadBlobThreshold(host.atoms, config.principal, config.actorType);
      } catch (err) {
        return { kind: 'error', stage: 'agentic/policy-resolution', reason: errorMessage(err) };
      }

      // 2. Acquire workspace.
      let workspace: Workspace;
      try {
        workspace = await config.workspaceProvider.acquire({
          principal: config.principal,
          baseRef: config.baseRef,
          correlationId,
        });
      } catch (err) {
        return { kind: 'error', stage: 'agentic/workspace-acquire', reason: errorMessage(err) };
      }

      try {
        // 3. Run the agent loop.
        let agentResult: AgentLoopResult;
        try {
          agentResult = await config.agentLoop.run({
            host,
            principal: config.principal,
            workspace,
            task: extractAgentTask(plan),
            budget: deriveBudget(fence),
            // PR2 wires the substrate composition with an empty
            // disallowed-tools list. Per-principal LLM tool policy is
            // a separate substrate concern resolved in a follow-up
            // (the resolver landed in PR1 but is not yet threaded
            // through this seam).
            toolPolicy: { disallowedTools: [] },
            redactor: config.redactor,
            blobStore: config.blobStore,
            replayTier,
            blobThreshold,
            correlationId,
            ...(signal !== undefined ? { signal } : {}),
          });
        } catch (err) {
          // Adapter threw rather than returning a structured failure.
          // Use the adapter-supplied classifier to keep the failure
          // taxonomy uniform with structured failure paths.
          return mapAgentLoopThrow(err, config.agentLoop.capabilities.classify_failure);
        }

        // 4. Map non-completed kinds.
        if (agentResult.kind !== 'completed') {
          return mapAgentLoopResult(agentResult);
        }

        const commitSha = agentResult.artifacts?.commitSha;
        const branchName = agentResult.artifacts?.branchName;
        if (commitSha === undefined || branchName === undefined) {
          return {
            kind: 'error',
            stage: 'agentic/no-artifacts',
            reason: 'agent loop completed but did not return commitSha + branchName',
          };
        }

        // 5. Create PR via existing GhClient.
        try {
          const pr = await createPrViaGhClient({
            config,
            plan,
            observationAtomId,
            commitSha,
            branchName,
            touchedPaths: agentResult.artifacts?.touchedPaths ?? [],
            draft,
          });
          return {
            kind: 'dispatched',
            prNumber: pr.number,
            prHtmlUrl: pr.htmlUrl,
            commitSha,
            branchName,
            // Adapter-tracked cost is opt-in. Default 0 when adapter
            // does not report; future cost wiring threads through
            // capabilities.tracks_cost + a session-meta read.
            totalCostUsd: 0,
            modelUsed: config.model,
            confidence: 1,
            touchedPaths: agentResult.artifacts?.touchedPaths ?? [],
          };
        } catch (err) {
          return { kind: 'error', stage: 'agentic/pr-creation', reason: errorMessage(err) };
        }
      } finally {
        // 6. Always release the workspace, even on throw. Swallow any
        // release error -- a release failure must not mask the
        // upstream success/error result.
        await config.workspaceProvider.release(workspace).catch(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the AgentTask the AgentLoopAdapter consumes from a plan atom.
 * Resolution mirrors the diff-based path so a plan that worked there
 * works here without metadata changes:
 *   - target_paths: structured `metadata.target_paths` first, then a
 *     prose-level fallback.
 *   - success_criteria: structured `metadata.success_criteria` string
 *     when present.
 *   - question_prompt: structured `metadata.question_prompt` string
 *     when present (the originating Question's literal prompt).
 */
function extractAgentTask(plan: Atom): AgentTask {
  const meta = plan.metadata as Record<string, unknown>;
  const declared = extractStringArray(meta, 'target_paths');
  const targetPaths = declared.length > 0
    ? declared
    : extractTargetPathsFromProse(String(plan.content));
  const successCriteria = typeof meta['success_criteria'] === 'string'
    ? (meta['success_criteria'] as string)
    : undefined;
  const questionPrompt = typeof meta['question_prompt'] === 'string'
    ? (meta['question_prompt'] as string)
    : undefined;
  return {
    planAtomId: plan.id,
    ...(questionPrompt !== undefined ? { questionPrompt } : {}),
    ...(successCriteria !== undefined ? { successCriteria } : {}),
    ...(targetPaths.length > 0 ? { targetPaths } : {}),
  };
}

/**
 * Translate the per-PR cost cap from the fence into an agent-loop
 * BudgetCap. `max_turns` and `max_wall_clock_ms` come from the
 * substrate default; `max_usd` from the fence. Adapters whose
 * `capabilities.tracks_cost === false` ignore the USD cap.
 */
function deriveBudget(fence: CodeAuthorFence): BudgetCap {
  const base = defaultBudgetCap();
  return {
    max_turns: base.max_turns,
    max_wall_clock_ms: base.max_wall_clock_ms,
    max_usd: fence.perPrCostCap.max_usd_per_pr,
  };
}

/**
 * Map an `AgentLoopResult` whose `kind !== 'completed'` to a
 * `CodeAuthorExecutorFailure`. Stage strings are the dashboard
 * contract; the table is exhaustive across all
 * (kind x failure?.kind) combinations except the unreachable
 * `'completed'` cell which the caller short-circuits.
 */
function mapAgentLoopResult(result: AgentLoopResult): CodeAuthorExecutorResult {
  const failure = result.failure;
  switch (result.kind) {
    case 'budget-exhausted':
      if (failure === undefined) {
        return {
          kind: 'error',
          stage: 'agentic/budget-exhausted',
          reason: 'agent loop hit budget cap',
        };
      }
      return {
        kind: 'error',
        stage: `agentic/budget-exhausted/${failure.kind}`,
        reason: failure.reason,
      };
    case 'aborted':
      if (failure === undefined) {
        return {
          kind: 'error',
          stage: 'agentic/aborted',
          reason: 'agent loop aborted via signal',
        };
      }
      return {
        kind: 'error',
        stage: `agentic/aborted/${failure.kind}`,
        reason: failure.reason,
      };
    case 'error':
      if (failure === undefined) {
        return {
          kind: 'error',
          stage: 'agentic/agent-loop/unknown',
          reason: 'agent loop failed without structured FailureRecord',
        };
      }
      return {
        kind: 'error',
        stage: `agentic/agent-loop/${failure.kind}`,
        reason: failure.reason,
      };
    case 'completed':
      // Caller short-circuits this branch before calling here. Treat
      // a completed result reaching the mapper as an unreachable bug.
      return {
        kind: 'error',
        stage: 'agentic/agent-loop/unknown',
        reason: 'mapAgentLoopResult called with kind=completed (unreachable)',
      };
  }
}

/**
 * Convert a thrown adapter error into the same failure shape the
 * structured-result path produces. Uses the adapter-supplied
 * classifier (capabilities.classify_failure) so adapter-specific
 * error shapes get the right taxonomy without leaking adapter
 * internals into the substrate.
 */
function mapAgentLoopThrow(
  err: unknown,
  classifier: (e: unknown) => FailureKind,
): CodeAuthorExecutorResult {
  const kind = classifier(err);
  return {
    kind: 'error',
    stage: `agentic/adapter-threw/${kind}`,
    reason: errorMessage(err),
  };
}

interface CreatePrInput {
  readonly config: AgenticExecutorConfig;
  readonly plan: Atom;
  readonly observationAtomId: AtomId;
  readonly commitSha: string;
  readonly branchName: string;
  readonly touchedPaths: ReadonlyArray<string>;
  readonly draft: boolean;
}

/**
 * Thin wrapper around the existing PR-creation primitive. Reuses
 * `renderPrBody` so the body shape is identical between agentic +
 * diff-based paths. Drafter-specific fields (notes, confidence, cost,
 * model) come from the agentic path's adapter result; today the
 * adapter does not return drafter-style notes, so we synthesize a
 * short stand-in. Future cost-tracking work wires real numbers
 * through `AgentSessionMeta.budget_consumed`.
 */
async function createPrViaGhClient(
  input: CreatePrInput,
): Promise<{ readonly number: number; readonly htmlUrl: string }> {
  const { config, plan, observationAtomId, commitSha, branchName, touchedPaths, draft } = input;
  const planId = String(plan.id);
  const meta = plan.metadata as Record<string, unknown>;
  const planTitle = typeof meta['title'] === 'string' && (meta['title'] as string).length > 0
    ? (meta['title'] as string)
    : `plan ${planId}`;
  const title = `code-author: ${planTitle}`;
  const body = renderPrBody({
    planId,
    planContent: String(plan.content),
    draftNotes: 'Agentic loop produced this change in an isolated workspace.',
    draftConfidence: 1,
    observationAtomId: String(observationAtomId),
    commitSha,
    costUsd: 0,
    modelUsed: config.model,
    touchedPaths,
  });
  try {
    const pr = await createDraftPr({
      client: config.ghClient,
      owner: config.owner,
      repo: config.repo,
      title,
      head: branchName,
      base: config.baseRef,
      body,
      draft,
    });
    return { number: pr.number, htmlUrl: pr.htmlUrl };
  } catch (err) {
    if (err instanceof PrCreationError) {
      // Preserve the typed-error message + stage in the surfaced
      // string so the upstream wrapper can see the gh-client cause.
      throw new Error(`${err.message} (stage=${err.stage})`);
    }
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractStringArray(
  meta: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

/**
 * Heuristic path extractor over prose plan content. Mirrors the
 * diff-based path's resolver so an agentic-path consumer interprets
 * the same plan identically.
 *
 * The extension allowlist is deliberately narrow so prose like
 * `example.com` or version strings (`1.2.3`) does not get misread as
 * a file path. Per-segment `..` / `.` guards block traversal
 * fragments; a defense-in-depth path-scope check belongs at the
 * workspace boundary, not here.
 */
function extractTargetPathsFromProse(prose: string): string[] {
  const extAllowlist = 'md|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|css|scss|html|sh|py|go|rs|java|kt|rb|ex|exs';
  // First segment may contain `.` so dotted top-level filenames
  // (`README.md`, `tsconfig.json`) match. Path segments are
  // zero-or-more so prose like "update README.md" extracts the
  // top-level path; the prior `+` form silently dropped it. Mirrors
  // the diff-based variant byte-for-byte.
  const pathRe = new RegExp(
    `(?<![A-Za-z0-9_\\/.])([A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\\/[A-Za-z0-9_.-]+)*\\.(?:${extAllowlist}))\\b`,
    'g',
  );
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(prose)) !== null) {
    const p = stripDiffPathPrefix(m[1]!);
    if (hasTraversalSegment(p)) continue;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function stripDiffPathPrefix(p: string): string {
  const isDiffPrefix = p.startsWith('a/') || p.startsWith('b/');
  if (!isDiffPrefix) return p;
  const stripped = p.slice(2);
  return stripped.includes('/') ? stripped : p;
}

function hasTraversalSegment(p: string): boolean {
  for (const seg of p.split('/')) {
    if (seg === '..' || seg === '.') return true;
  }
  return false;
}
