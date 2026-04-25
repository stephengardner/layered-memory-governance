/**
 * Executor factory for the virtual-org example.
 *
 * Composes `buildDiffBasedCodeAuthorExecutor` (the concrete chain of
 * drafter + git-ops + pr-creation) with `runCodeAuthor` (the
 * governance-invariant invoker) and returns a function shaped like
 * the `CodeAuthorFn` the agent-sdk executor seam consumes.
 *
 * The diff-based executor is built once at factory time so the
 * subprocess-adjacent configuration (repoDir, gitIdentity, model,
 * ghClient) is captured up front; every invocation reuses the same
 * executor with a fresh host + payload.
 */

import { buildDiffBasedCodeAuthorExecutor } from '../../runtime/actor-message/diff-based-code-author-executor.js';
import { runCodeAuthor } from '../../runtime/actor-message/code-author-invoker.js';
import type { CodeAuthorFn } from '../../integrations/agent-sdk/executor.js';
import type { GhClient } from '../../external/github/index.js';
import type { Host } from '../../substrate/interface.js';

import type { GitIdentity } from './host-builder.js';

export interface ExecutorFactoryOptions {
  readonly host: Host;
  readonly ghClient: GhClient;
  readonly owner: string;
  readonly repo: string;
  readonly repoDir: string;
  readonly gitIdentity: GitIdentity;
  readonly model: string;
  /** Base branch for PRs + default-branch for git ops. Defaults to `main`. */
  readonly baseBranch?: string;
  /** Remote name passed to git-ops. Defaults to `origin`. */
  readonly remote?: string;
  /** Draft PRs when unset (safer default). */
  readonly draft?: boolean;
}

export function createVirtualOrgCodeAuthorFn(
  opts: ExecutorFactoryOptions,
): CodeAuthorFn {
  const executor = buildDiffBasedCodeAuthorExecutor({
    host: opts.host,
    ghClient: opts.ghClient,
    owner: opts.owner,
    repo: opts.repo,
    repoDir: opts.repoDir,
    gitIdentity: opts.gitIdentity,
    model: opts.model,
    ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    ...(opts.remote !== undefined ? { remote: opts.remote } : {}),
    ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
  });

  return async (host, payload, correlationId, options) => {
    return runCodeAuthor(host, payload, correlationId, {
      ...(options ?? {}),
      executor,
    });
  };
}
