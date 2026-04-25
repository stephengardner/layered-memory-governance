/**
 * Reference WorkspaceProvider: git-worktree-backed.
 *
 * Acquires a workspace at `<repoDir>/.worktrees/agentic/<sanitized-corr-id>`,
 * creates a branch `agentic/<sanitized-corr-id>` checked out at the
 * requested baseRef, and (optionally) copies bot creds for specified
 * roles into the worktree's `.lag/apps/`. Release runs
 * `git worktree remove --force`.
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
 * `release()` runs `git worktree remove --force <path>` and treats
 * "not a working tree" stderr as success (idempotent: safe to call
 * twice). Note: `git worktree remove` does not delete the underlying
 * branch, and `git worktree prune` only removes administrative
 * metadata for vanished worktrees - it does NOT delete branches
 * either. Operators who want to clean up `agentic/<id>` branches
 * after release should run
 * `git for-each-ref --format='%(refname:short)' refs/heads/agentic/ | xargs -n1 git branch -D`
 * (after confirming none have unmerged work).
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
      await this.exec('git', ['-C', this.opts.repoDir, 'worktree', 'remove', '--force', path], { reject: false });
      throw err;
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
      if (/not a working tree|is not a working tree|No such file/i.test(stderr)) {
        return;
      }
      throw new Error(`GitWorktreeProvider: worktree remove failed: ${stderr}`);
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
