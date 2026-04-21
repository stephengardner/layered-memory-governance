/**
 * Git operations primitive: apply a unified diff to a fresh
 * branch and push to a remote.
 *
 * Pure mechanism. Given a diff + repoDir + branchName +
 * commitMessage + identity + stagePaths, run the git-ops state
 * machine and return the produced branch + commit handles.
 * Composable with any caller that has a diff to ship.
 *
 * Contract
 * --------
 * `applyDraftBranch({ diff, repoDir, branchName, commitMessage,
 *                     authorIdentity, remote })` promises:
 *   1. Fetch the remote baseline to ensure the branch branches off
 *      the current default branch head (first iteration targets
 *      `main`; configurable via `baseBranch`).
 *   2. Check the worktree is clean. A dirty worktree is a refusal
 *      reason -- the executor MUST NOT fold unrelated uncommitted
 *      changes into the draft.
 *   3. Create + switch to the declared branch off the baseline.
 *   4. Apply the diff via `git apply --check` (dry-run) THEN `git
 *      apply` (real). The two-step check-then-apply catches
 *      malformed diffs before mutating the worktree.
 *   5. Stage the explicit `stagePaths` (no `git add -A`) so a stray
 *      file elsewhere in the tree never gets committed.
 *   6. Commit under the caller-supplied `authorIdentity`.
 *   7. Push the branch to `remote` (default `origin`). A push
 *      failure does NOT roll back the branch; caller handles
 *      retry and any cleanup.
 *
 * Fail-closed posture
 * -------------------
 * Every refusal path throws `GitOpsError` with a typed `reason`:
 *   - `dirty-worktree`       worktree has uncommitted changes
 *   - `diff-apply-failed`    `git apply --check` rejected the diff
 *   - `branch-create-failed` could not create the target branch
 *   - `commit-failed`        no changes staged, or git commit rejected
 *   - `push-failed`          remote push returned non-zero
 *   - `unexpected`           anything else (permissions, missing
 *                            git binary, timeout, etc.)
 *
 * Each error carries `stage`, `stdout`, `stderr`, `exitCode` where
 * available so the caller can surface a precise observation atom
 * for audit.
 *
 * Explicit non-goals
 * ------------------
 * - No PR creation. The caller opens the PR via its own GitHub
 *   client after this function returns.
 * - No signed-commit verification. Signing / identity policy is
 *   the caller's responsibility; this module only plumbs
 *   `authorIdentity` through `-c user.name` / `-c user.email`
 *   per invocation.
 * - No conflict-resolution retry. A diff that no longer applies
 *   against `baseBranch` HEAD fails loud; retry is a caller
 *   decision.
 */

import { execa } from 'execa';

// Shape of what execa yields when `reject: false` is set; we inline
// the properties we consume so a future execa type rename does not
// break the build.
interface ExecResult {
  readonly stdout: string | Buffer | undefined;
  readonly stderr: string | Buffer | undefined;
  readonly exitCode: number | null | undefined;
}

// Coerce a possibly-undefined string-or-Buffer to a clean string.
// Using `String(undefined)` here would yield the literal
// 'undefined', which would flow into GitOpsError.stdout/stderr and
// then into observation atoms for audit -- making empty output
// indistinguishable from the string "undefined." Helper produces
// '' for missing values and utf-8-decodes buffers.
function toStr(v: string | Buffer | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return v.toString('utf8');
}

export type GitOpsErrorReason =
  | 'dirty-worktree'
  | 'diff-apply-failed'
  | 'branch-create-failed'
  | 'commit-failed'
  | 'push-failed'
  | 'unexpected';

export class GitOpsError extends Error {
  constructor(
    message: string,
    public readonly reason: GitOpsErrorReason,
    public readonly stage: string,
    public readonly stdout = '',
    public readonly stderr = '',
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'GitOpsError';
  }
}

/**
 * Minimal git identity for a commit. Matches the `git -c
 * user.name=... -c user.email=...` override surface so the
 * identity is per-call rather than globally configured -- the
 * framework must not mutate the operator's git config.
 */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface ApplyDraftBranchInputs {
  /** Unified diff from draftCodeChange. MUST include headers. */
  readonly diff: string;
  /**
   * Absolute path to the worktree root. Every git invocation runs
   * with cwd=repoDir so there is no global-config leak.
   */
  readonly repoDir: string;
  /**
   * Fresh branch name created off `baseBranch`. Caller chooses the
   * naming scheme (e.g., `code-author/plan-<id>-<nonce>`). If the
   * branch already exists locally, applyDraftBranch refuses with
   * branch-create-failed.
   */
  readonly branchName: string;
  /** Defaults to `main`; configurable for repos that use `master` / other. */
  readonly baseBranch?: string;
  /** Commit message body; first line becomes the subject. */
  readonly commitMessage: string;
  /** Author + committer identity for this commit. */
  readonly authorIdentity: GitIdentity;
  /**
   * Paths to stage for commit. Must match `DraftResult.touchedPaths`
   * (or a caller-validated subset). Explicit allowlist guards
   * against accidentally committing a stray file elsewhere in the
   * tree; an empty list is a refusal (commit-failed).
   */
  readonly stagePaths: ReadonlyArray<string>;
  /** Remote name for push. Defaults to `origin`. */
  readonly remote?: string;
  /**
   * Environment passed to git invocations. Primary use: setting
   * GH_TOKEN or GIT_ASKPASS-backed credentials for the remote push
   * under an App installation token. Inherits the parent env by
   * default so operator-configured git tools continue to work.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Abort signal for kill-switch propagation. */
  readonly signal?: AbortSignal;
  /**
   * Optional execa override for tests. Takes (bin, args, options)
   * and returns the execa result shape; defaults to real execa.
   */
  readonly execImpl?: typeof execa;
}

export interface ApplyDraftBranchResult {
  readonly branchName: string;
  /** Full SHA of the commit that was pushed. */
  readonly commitSha: string;
  /** Short SHA (7 chars) for convenience in observation atoms. */
  readonly commitShaShort: string;
  /** Paths actually committed (same as input stagePaths on success). */
  readonly committedPaths: ReadonlyArray<string>;
}

/**
 * Apply a unified diff on a fresh branch and push to remote.
 * Every step is sequential; a failure at step N does NOT clean up
 * steps 1..N-1. The caller decides whether to garbage-collect the
 * branch, close any attached PR, and/or record a revocation record
 * on failure.
 */
export async function applyDraftBranch(
  inputs: ApplyDraftBranchInputs,
): Promise<ApplyDraftBranchResult> {
  const exec = inputs.execImpl ?? execa;
  const remote = inputs.remote ?? 'origin';
  const baseBranch = inputs.baseBranch ?? 'main';
  const env = inputs.env ?? process.env;

  const run = async (
    args: ReadonlyArray<string>,
    opts: { readonly input?: string } = {},
  ): Promise<ExecResult> => {
    return (await exec('git', ['-c', `user.name=${inputs.authorIdentity.name}`, '-c', `user.email=${inputs.authorIdentity.email}`, ...args], {
      cwd: inputs.repoDir,
      env,
      reject: false,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(inputs.signal ? { cancelSignal: inputs.signal } : {}),
    })) as unknown as ExecResult;
  };

  // 1. Worktree must be clean. `status --porcelain` prints one
  //    line per modified/untracked file; empty stdout = clean.
  {
    const status = await run(['status', '--porcelain']);
    if (status.exitCode !== 0) {
      throw new GitOpsError(
        `git status failed: ${status.stderr}`,
        'unexpected',
        'status',
        toStr(status.stdout),
        toStr(status.stderr),
        status.exitCode,
      );
    }
    if (toStr(status.stdout).trim().length > 0) {
      throw new GitOpsError(
        `worktree is dirty: ${toStr(status.stdout).slice(0, 500)}`,
        'dirty-worktree',
        'status',
        toStr(status.stdout),
        toStr(status.stderr),
        status.exitCode,
      );
    }
  }

  // 2. Fetch the baseline + check out a fresh branch off it. We do
  //    NOT try to detect a branch-already-exists race; the `-b`
  //    flag refuses and we translate that into branch-create-failed.
  {
    const fetch = await run(['fetch', remote, baseBranch, '--quiet']);
    if (fetch.exitCode !== 0) {
      throw new GitOpsError(
        `git fetch ${remote} ${baseBranch} failed: ${fetch.stderr}`,
        'unexpected',
        'fetch',
        toStr(fetch.stdout),
        toStr(fetch.stderr),
        fetch.exitCode,
      );
    }
    const checkout = await run(['checkout', '-b', inputs.branchName, `${remote}/${baseBranch}`]);
    if (checkout.exitCode !== 0) {
      throw new GitOpsError(
        `git checkout -b ${inputs.branchName} failed: ${checkout.stderr}`,
        'branch-create-failed',
        'checkout',
        toStr(checkout.stdout),
        toStr(checkout.stderr),
        checkout.exitCode,
      );
    }
  }

  // 3. Diff check + apply. Two-step so a malformed diff is caught
  //    before the worktree is mutated.
  {
    const check = await run(['apply', '--check'], { input: inputs.diff });
    if (check.exitCode !== 0) {
      throw new GitOpsError(
        `git apply --check rejected the diff: ${check.stderr}`,
        'diff-apply-failed',
        'apply-check',
        toStr(check.stdout),
        toStr(check.stderr),
        check.exitCode,
      );
    }
    const apply = await run(['apply'], { input: inputs.diff });
    if (apply.exitCode !== 0) {
      throw new GitOpsError(
        `git apply failed after successful --check: ${apply.stderr}`,
        'diff-apply-failed',
        'apply',
        toStr(apply.stdout),
        toStr(apply.stderr),
        apply.exitCode,
      );
    }
  }

  // 4. Stage exactly the paths the caller declared. An empty list
  //    is a refusal: committing nothing + pushing an empty branch
  //    would be a silent no-op the caller would not expect.
  if (inputs.stagePaths.length === 0) {
    throw new GitOpsError(
      'stagePaths is empty; refusing to produce a commit with no staged changes',
      'commit-failed',
      'stage',
    );
  }
  {
    const add = await run(['add', '--', ...inputs.stagePaths]);
    if (add.exitCode !== 0) {
      throw new GitOpsError(
        `git add failed: ${add.stderr}`,
        'commit-failed',
        'stage',
        toStr(add.stdout),
        toStr(add.stderr),
        add.exitCode,
      );
    }
  }

  // 5. Commit under the caller-supplied identity. A commit that
  //    produces no changes (because the diff was a no-op) exits
  //    non-zero here; we translate to commit-failed with the exit
  //    output so the caller can distinguish "LLM produced an empty
  //    diff" from "git refused."
  {
    const commit = await run(['commit', '-m', inputs.commitMessage]);
    if (commit.exitCode !== 0) {
      throw new GitOpsError(
        `git commit failed: ${commit.stderr || commit.stdout}`,
        'commit-failed',
        'commit',
        toStr(commit.stdout),
        toStr(commit.stderr),
        commit.exitCode,
      );
    }
  }

  // 6. Capture the commit SHA before push so the caller can cite
  //    it in observation atoms even if push fails.
  let commitSha = '';
  {
    const rev = await run(['rev-parse', 'HEAD']);
    if (rev.exitCode !== 0) {
      throw new GitOpsError(
        `git rev-parse HEAD failed: ${rev.stderr}`,
        'unexpected',
        'rev-parse',
        toStr(rev.stdout),
        toStr(rev.stderr),
        rev.exitCode,
      );
    }
    commitSha = toStr(rev.stdout).trim();
  }

  // 7. Push with `--set-upstream` so the local branch tracks the
  //    remote ref for any subsequent git operations.
  {
    const push = await run(['push', '--set-upstream', remote, inputs.branchName]);
    if (push.exitCode !== 0) {
      throw new GitOpsError(
        `git push failed: ${push.stderr}`,
        'push-failed',
        'push',
        toStr(push.stdout),
        toStr(push.stderr),
        push.exitCode,
      );
    }
  }

  return Object.freeze({
    branchName: inputs.branchName,
    commitSha,
    commitShaShort: commitSha.slice(0, 7),
    committedPaths: Object.freeze(inputs.stagePaths.slice()),
  });
}
