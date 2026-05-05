/**
 * Reference WorkspaceProvider: git-worktree-backed.
 *
 * Acquires a workspace at `<repoDir>/.worktrees/agentic/<sanitized-corr-id>`,
 * creates a branch `agentic/<sanitized-corr-id>` checked out at the
 * requested baseRef, and (optionally) copies bot creds for specified
 * roles into the worktree's `.lag/apps/`. Release runs
 * `git worktree remove --force` and, when acquire created the branch
 * itself, also runs `git branch -D` against that branch so the next
 * acquire with the same correlation-id prefix does not collide on
 * `fatal: a branch named '...' already exists`.
 *
 * Threat model
 * ------------
 * - `repoDir` MUST be a real git repo. The constructor does no
 *   filesystem validation; the first `acquire()` fails with a clear
 *   message if not.
 * - `correlationId` is sanitized (path-traversal segments stripped,
 *   non-`[A-Za-z0-9._-]` chars replaced with `-`, `..` substrings
 *   collapsed to `_`, length clipped to 80) before becoming a
 *   filesystem path component or branch name.
 * - Cred copying is opt-in per role. Only listed roles are copied.
 *   Fresh worktrees start with no creds; copying is the integration
 *   point so an agent running in the workspace can still use
 *   `gh-as` / `git-as` against the same App identity.
 * - Process-local isolation only. Stronger isolation (docker, k8s)
 *   is an opt-in swap; this adapter is the indie default.
 *
 * Release semantics
 * -----------------
 * `release()` runs `git worktree remove --force <path>`, treating
 * "not a working tree" / "No such file" stderr as success
 * (idempotent: safe to call twice).
 *
 * After the worktree is removed, the provider deletes the local
 * branch via `git branch -D <branch>` IFF acquire created the branch
 * itself (the legacy default path with no `checkoutBranch` input).
 * This closes the substrate gap where a dispatch pipeline that fails
 * BEFORE the executor pushes leaves an orphan `agentic/<id>` branch
 * behind, so a subsequent pipeline with the same plan-id prefix
 * collides at workspace-acquire time.
 *
 * The provider tracks branches it created in an in-memory map keyed
 * by `Workspace.id`; a `release()` whose workspace was acquired by a
 * DIFFERENT provider instance (process restart, fresh executor)
 * cannot identify the branch and therefore does not delete it. This
 * is bounded leakage (one orphan per process restart, not per
 * pipeline run) and is acceptable indie-floor posture.
 *
 * `checkoutBranch` flows are NOT cleaned up: the branch was supplied
 * by the caller (typically a PR HEAD), it pre-existed the acquire,
 * and deleting it would break callers that expect the branch to
 * survive the workspace-release boundary (e.g. PrFixActor preserving
 * the PR HEAD branch across iterations).
 *
 * Branch deletion failure (e.g. "branch not found" from a concurrent
 * cleanup, or "checked out elsewhere" if the worktree-remove step
 * partially succeeded) is swallowed: the worktree is gone, the
 * acquire path is unblocked, and the residual branch can be removed
 * manually if it matters.
 */

import { execa, type execa as ExecaType } from 'execa';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkspaceProvider,
  Workspace,
  AcquireInput,
} from '../../../src/substrate/workspace-provider.js';

export interface GitWorktreeProviderOptions {
  readonly repoDir: string;
  /** Bot identities whose creds are copied into the workspace's `.lag/apps/`. */
  readonly copyCredsForRoles: ReadonlyArray<string>;
  /** Base directory for worktrees. Defaults to `<repoDir>/.worktrees/agentic`. */
  readonly worktreesRoot?: string;
  /**
   * Optional execa override. Defaults to the real `execa` from the
   * `execa` package. Tests inject a stub that records argv so the
   * `-b`-vs-no-`-b` worktree-add semantics can be pinned as a
   * regression-guard.
   */
  readonly execImpl?: typeof ExecaType;
}

export class GitWorktreeProvider implements WorkspaceProvider {
  private readonly worktreesRoot: string;
  private readonly exec: typeof ExecaType;
  /**
   * Map of `workspace.id` -> branch name the provider CREATED at
   * acquire time. Populated only on the legacy default acquire path
   * (no `checkoutBranch` input); empty for `checkoutBranch` flows so
   * release() leaves caller-supplied branches alone.
   *
   * Lives in-process; a fresh provider instance has no entries and
   * therefore cannot clean up branches a previous instance created.
   * See `Release semantics` in the file-level JSDoc for the leak
   * envelope.
   */
  private readonly createdBranches = new Map<string, string>();

  constructor(private readonly opts: GitWorktreeProviderOptions) {
    this.worktreesRoot = opts.worktreesRoot ?? join(opts.repoDir, '.worktrees', 'agentic');
    this.exec = opts.execImpl ?? execa;
  }

  async acquire(input: AcquireInput): Promise<Workspace> {
    // Validate baseRef exists. This stays an upfront gate even when
    // `checkoutBranch` is set: baseRef is the comparison baseline for
    // diff/PR-against-base operations regardless of which branch we
    // actually check out.
    const r = await this.exec('git', ['-C', this.opts.repoDir, 'rev-parse', '--verify', `${input.baseRef}^{commit}`], { reject: false });
    if (r.exitCode !== 0) {
      throw new Error(`GitWorktreeProvider: baseRef '${input.baseRef}' not found in repo`);
    }
    const id = sanitizeId(input.correlationId);
    const path = join(this.worktreesRoot, id);
    await mkdir(this.worktreesRoot, { recursive: true });

    // Two acquire paths:
    //   - `input.checkoutBranch` present: existing branch (local or
    //     remote); `git worktree add <path> <branch>` WITHOUT `-b` so
    //     commits land on the checked-out branch (fix-actor flow).
    //   - `input.checkoutBranch` absent: legacy default; create a new
    //     branch `agentic/<id>` off `baseRef` (code-author flow).
    let createdBranch: string | undefined;
    if (input.checkoutBranch !== undefined && input.checkoutBranch.length > 0) {
      // Defense-in-depth branch-name validation. `execa` array form
      // already prevents shell injection; this guard rejects
      // path-traversal-shaped branch names that could otherwise escape
      // the worktrees root via git's ref-resolution rules.
      if (input.checkoutBranch.includes('..')) {
        throw new Error(`GitWorktreeProvider: checkoutBranch must not contain '..': ${input.checkoutBranch}`);
      }
      // Best-effort fetch so a remote-only branch resolves before
      // `worktree add`. Failure is non-fatal: a fully-local branch
      // (e.g. test fixtures with no `origin`) still resolves directly.
      await this.exec('git', ['-C', this.opts.repoDir, 'fetch', 'origin', input.checkoutBranch], { reject: false });
      const create = await this.exec('git', ['-C', this.opts.repoDir, 'worktree', 'add', path, input.checkoutBranch], { reject: false });
      if (create.exitCode !== 0) {
        throw new Error(`GitWorktreeProvider: worktree add for checkoutBranch '${input.checkoutBranch}' failed: ${create.stderr}`);
      }
    } else {
      const branch = `agentic/${id}`;
      const create = await this.exec('git', ['-C', this.opts.repoDir, 'worktree', 'add', '-b', branch, path, input.baseRef], { reject: false });
      if (create.exitCode !== 0) {
        throw new Error(`GitWorktreeProvider: worktree add failed: ${create.stderr}`);
      }
      createdBranch = branch;
    }
    // Cred-copy is wrapped: if any mkdir/copyFile throws, the worktree
    // we just created would otherwise leak to disk + leave a dangling
    // branch. Tear it down and re-throw so the caller sees the
    // original error and acquire() is atomic (succeeds with creds, or
    // fails with no side effects). Runs unchanged for both acquire
    // paths above.
    try {
      // Copy bot creds.
      for (const role of this.opts.copyCredsForRoles) {
        const src = join(this.opts.repoDir, '.lag', 'apps', `${role}.json`);
        try {
          await stat(src);
        } catch {
          continue; // role not provisioned in this repo; skip silently.
        }
        const dst = join(path, '.lag', 'apps', `${role}.json`);
        await mkdir(join(path, '.lag', 'apps'), { recursive: true });
        await copyFile(src, dst);
        // Also copy the `.pem` if present (App private key for token mint).
        const srcKey = join(this.opts.repoDir, '.lag', 'apps', 'keys', `${role}.pem`);
        const dstKey = join(path, '.lag', 'apps', 'keys', `${role}.pem`);
        try {
          await stat(srcKey);
          await mkdir(join(path, '.lag', 'apps', 'keys'), { recursive: true });
          await copyFile(srcKey, dstKey);
        } catch {
          // No key for this role; omit silently (some roles use OAuth).
        }
      }
    } catch (err) {
      // Best-effort cleanup; reject:false so a tear-down failure can't
      // shadow the original cred-copy error. Operators see the real
      // cause; orphaned worktrees surface via `git worktree prune`.
      // Branch we just created is also dropped here so a retry with
      // the same correlation-id is not blocked by a leftover ref.
      await this.exec('git', ['-C', this.opts.repoDir, 'worktree', 'remove', '--force', path], { reject: false });
      if (createdBranch !== undefined) {
        await this.exec('git', ['-C', this.opts.repoDir, 'branch', '-D', createdBranch], { reject: false });
      }
      throw err;
    }
    if (createdBranch !== undefined) {
      this.createdBranches.set(id, createdBranch);
    }
    return { id, path, baseRef: input.baseRef };
  }

  async release(workspace: Workspace): Promise<void> {
    // Idempotent: if the worktree is already gone, swallow.
    const r = await this.exec('git', ['-C', this.opts.repoDir, 'worktree', 'remove', '--force', workspace.path], { reject: false });
    if (r.exitCode !== 0) {
      const stderr = r.stderr ?? '';
      // Git's "not a working tree" / "is not a working tree" wording
      // varies across versions; match either for idempotence.
      if (!/not a working tree|is not a working tree|No such file/i.test(stderr)) {
        throw new Error(`GitWorktreeProvider: worktree remove failed: ${stderr}`);
      }
      // Worktree is already gone (prior release, manual cleanup, or
      // crash). Fall through to branch cleanup so the second leak path
      // closes too.
    }
    // Drop the branch the provider created at acquire time, if any.
    // Map miss => either a `checkoutBranch` flow (caller owns the
    // branch) or a release crossing provider instances; either way,
    // do not touch the branch. Map hit => delete it so a subsequent
    // acquire with the same correlation-id prefix is unblocked.
    const createdBranch = this.createdBranches.get(workspace.id);
    if (createdBranch !== undefined) {
      this.createdBranches.delete(workspace.id);
      // `-D` (force) is intentional: the branch may carry commits
      // that were never pushed (the executor failed before push) or
      // commits that were pushed and now live on `origin/<branch>`.
      // `-d` would refuse the unmerged-locally case and re-create the
      // exact symptom this fix targets. Failure is swallowed: a
      // stuck branch is recoverable manually; surfacing here would
      // mask the upstream success/error result.
      await this.exec('git', ['-C', this.opts.repoDir, 'branch', '-D', createdBranch], { reject: false });
    }
  }
}

function sanitizeId(raw: string): string {
  // Strip path-traversal segments AND any embedded '..' substring.
  // Splitting on /\\ and removing '.' / '..' / empty segments handles
  // `../foo`, `..\foo`, and lone '.' inputs; the subsequent `..` -> '_'
  // replace handles `....` and any embedded '..' that survives segment
  // splitting (defense in depth).
  const noTraversal = raw
    .split(/[/\\]/)
    .filter((seg) => seg !== '..' && seg !== '.' && seg.length > 0)
    .join('-');
  const safe = noTraversal
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '_'); // collapse any '..' or '...' run to '_'
  const clipped = safe.slice(0, 80);
  if (clipped.length === 0 || /^[._]+$/.test(clipped)) {
    // Pathological input (empty, '..', '.', '/', etc.); fall back to a
    // deterministic-but-unique id so the workspace path is non-empty
    // and not '.'. Caller still sees a reachable workspace; the id
    // surfaces in logs for postmortem traceability.
    return `corr-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }
  return clipped;
}
