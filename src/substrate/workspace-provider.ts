/**
 * WorkspaceProvider: isolated workspace seam for the agentic actor loop.
 *
 * Why this exists
 * ---------------
 * The agent loop runs an LLM-driven sub-agent that mutates files. The
 * mutation must be isolated from the primary working tree so:
 *  (1) concurrent runs do not race on the same files;
 *  (2) a crashed run leaves no half-applied state in the primary;
 *  (3) credentials provisioned for one principal do not leak into
 *      another principal's workspace.
 *
 * Threat model
 * ------------
 * - The workspace path is filesystem-visible; do not embed secrets in
 *   it. The default adapter uses correlation_id + a short nonce.
 * - Workspaces MAY contain bot credentials copied from a parent. The
 *   provider is responsible for cred provisioning at acquire time and
 *   cleanup at release time; fresh worktrees start with no creds, so
 *   the copy step is the integration point.
 * - Process-local isolation (same OS user, same disk) is the typical
 *   default. Stronger isolation (docker, k8s) is an opt-in swap; the
 *   seam is unchanged regardless of impl.
 * - Cleanup-on-error: `release()` MUST succeed even after an agent
 *   crash. Adapter implementations should not assume the workspace
 *   is in a sane state.
 *
 * Contract
 * --------
 * - `acquire()` resolved => caller MUST eventually call `release()`.
 *   Failure to release leaks workspace state.
 * - `acquire()` rejected => nothing to clean up.
 * - `release()` is idempotent (safe to call multiple times).
 * - `Workspace.path` is absolute.
 */

import type { PrincipalId } from './types.js';

export interface WorkspaceProvider {
  acquire(input: AcquireInput): Promise<Workspace>;
  release(workspace: Workspace): Promise<void>;
}

export interface AcquireInput {
  /** Whose work is this for? Drives cred copying / isolation. */
  readonly principal: PrincipalId;
  /** Base ref the workspace branches from (e.g. 'main'). */
  readonly baseRef: string;
  /** Dispatch correlation id; ties the workspace to the chain. */
  readonly correlationId: string;
  /**
   * Optional: existing branch (local or remote) to check out in the
   * acquired workspace. When set, the provider checks out this branch
   * directly (e.g., `git worktree add <path> <branch>`) so commits go
   * on it; `baseRef` becomes the comparison baseline for diff
   * operations rather than the parent of a new branch. When unset,
   * the provider creates a new branch off `baseRef` (the existing
   * default).
   *
   * Providers that do not support checking out an existing branch MUST
   * throw with a recognizable error rather than silently fall through
   * to baseRef behavior; that would let a caller think it got the
   * pinned branch when it did not.
   */
  readonly checkoutBranch?: string;
}

export interface Workspace {
  /** Provider-internal id; surfaced for logs + atom workspace_id. */
  readonly id: string;
  /** Absolute path on the filesystem where the agent operates. */
  readonly path: string;
  /** Base ref the workspace was created from. */
  readonly baseRef: string;
}
