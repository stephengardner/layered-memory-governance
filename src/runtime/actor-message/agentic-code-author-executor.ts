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
 *   4. On `result.kind === 'completed'` with a `commitSha`, create a
 *      PR via the existing `GhClient`.
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
 *   - agentic/adapter-threw             -> adapter threw rather than returning a structured result
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
 */

import type { PrincipalId } from '../../substrate/types.js';
import type { Host } from '../../substrate/interface.js';
import type { GhClient } from '../../external/github/index.js';
import type { AgentLoopAdapter } from '../../substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../substrate/workspace-provider.js';
import type { BlobStore } from '../../substrate/blob-store.js';
import type { Redactor } from '../../substrate/redactor.js';
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
  // The skeleton captures `config` for closure-shape parity with the
  // Task 3 implementation; the body is replaced wholesale next.
  void config;
  return {
    async execute(_inputs): Promise<CodeAuthorExecutorResult> {
      return {
        kind: 'error',
        stage: 'agentic/not-implemented',
        reason: 'AgenticCodeAuthorExecutor skeleton is not yet wired to the substrate seams (Task 3 of the PR2 plan).',
      };
    },
  };
}
