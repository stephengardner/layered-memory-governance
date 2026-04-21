/**
 * Unit tests for applyDraftBranch.
 *
 * Exercises the git-ops state machine via an injected execa stub
 * (no real git subprocess required). Tests assert:
 *   - happy path: clean worktree -> fetch -> checkout -b -> apply
 *     --check -> apply -> add -> commit -> rev-parse -> push
 *   - dirty worktree (status stdout non-empty) -> dirty-worktree
 *   - fetch failure -> unexpected (stage=fetch)
 *   - checkout -b failure -> branch-create-failed
 *   - apply --check rejects -> diff-apply-failed (stage=apply-check)
 *   - apply fails after --check passed -> diff-apply-failed (stage=apply)
 *   - empty stagePaths -> commit-failed (before touching the tree)
 *   - git commit failure -> commit-failed (stage=commit)
 *   - push failure -> push-failed
 *   - identity is passed via -c user.name/-c user.email to every
 *     git invocation (no global config leak)
 *   - AbortSignal is forwarded as cancelSignal
 */

import { describe, expect, it, vi } from 'vitest';
import { applyDraftBranch, GitOpsError } from '../../../../src/runtime/actors/code-author/git-ops.js';

interface StubCall {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly input: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cancelSignal: AbortSignal | undefined;
}

interface StubReply {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

function stubExeca(replies: ReadonlyArray<StubReply>) {
  const calls: StubCall[] = [];
  let i = 0;
  const impl = (async (bin: string, args: ReadonlyArray<string>, options: Record<string, unknown>) => {
    calls.push({
      bin,
      args: args.slice(),
      cwd: options['cwd'] as string | undefined,
      input: options['input'] as string | undefined,
      env: options['env'] as NodeJS.ProcessEnv | undefined,
      cancelSignal: options['cancelSignal'] as AbortSignal | undefined,
    });
    const r = replies[i++];
    if (!r) throw new Error(`stubExeca: no reply registered for call #${i}; args=${args.join(' ')}`);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  }) as unknown as Parameters<typeof applyDraftBranch>[0]['execImpl'];
  return { impl, calls };
}

const DEFAULT_INPUTS = {
  diff: [
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,1 +1,1 @@',
    '-# LAG',
    '+# LAG!',
    '',
  ].join('\n'),
  repoDir: '/tmp/repo-stub',
  branchName: 'code-author/plan-test-1-abc',
  commitMessage: 'code-author: test commit',
  authorIdentity: { name: 'Code Author', email: 'code-author@example.com' },
  stagePaths: ['README.md'],
};

describe('applyDraftBranch', () => {
  it('happy path: status clean -> fetch -> checkout -> apply-check -> apply -> add -> commit -> rev-parse -> push', async () => {
    const { impl, calls } = stubExeca([
      { exitCode: 0 },                                        // status
      { exitCode: 0 },                                        // fetch
      { exitCode: 0 },                                        // checkout -b
      { exitCode: 0 },                                        // apply --check
      { exitCode: 0 },                                        // apply
      { exitCode: 0 },                                        // add
      { exitCode: 0 },                                        // commit
      { exitCode: 0, stdout: 'deadbeefcafe0011223344556677889900aabbcc\n' }, // rev-parse
      { exitCode: 0 },                                        // push
    ]);
    const result = await applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl });
    expect(result.branchName).toBe('code-author/plan-test-1-abc');
    expect(result.commitSha).toBe('deadbeefcafe0011223344556677889900aabbcc');
    expect(result.commitShaShort).toBe('deadbee');
    expect(result.committedPaths).toEqual(['README.md']);
    expect(calls).toHaveLength(9);
    // Every call carries the identity override flags.
    for (const c of calls) {
      expect(c.bin).toBe('git');
      expect(c.args[0]).toBe('-c');
      expect(c.args[1]).toBe('user.name=Code Author');
      expect(c.args[2]).toBe('-c');
      expect(c.args[3]).toBe('user.email=code-author@example.com');
      expect(c.cwd).toBe('/tmp/repo-stub');
    }
  });

  it('dirty worktree -> GitOpsError(reason=dirty-worktree)', async () => {
    const { impl } = stubExeca([
      { exitCode: 0, stdout: ' M src/foo.ts\n?? src/bar.ts\n' }, // status: dirty
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'dirty-worktree',
      stage: 'status',
    });
  });

  it('fetch failure -> unexpected (stage=fetch)', async () => {
    const { impl } = stubExeca([
      { exitCode: 0 }, // status clean
      { exitCode: 128, stderr: 'remote not found' },
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'unexpected',
      stage: 'fetch',
    });
  });

  it('checkout -b failure -> branch-create-failed', async () => {
    const { impl } = stubExeca([
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 128, stderr: "fatal: A branch named '...' already exists" },
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'branch-create-failed',
      stage: 'checkout',
    });
  });

  it('apply --check rejects -> diff-apply-failed (stage=apply-check)', async () => {
    const { impl } = stubExeca([
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout
      { exitCode: 1, stderr: 'error: patch failed: README.md:1' }, // apply --check
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'diff-apply-failed',
      stage: 'apply-check',
    });
  });

  it('apply fails after --check passed -> diff-apply-failed (stage=apply)', async () => {
    const { impl } = stubExeca([
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout
      { exitCode: 0 }, // apply --check
      { exitCode: 1, stderr: 'error: patch failed mid-apply' },
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'diff-apply-failed',
      stage: 'apply',
    });
  });

  it('empty stagePaths -> commit-failed before staging', async () => {
    const { impl, calls } = stubExeca([
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout
      { exitCode: 0 }, // apply --check
      { exitCode: 0 }, // apply
      // no further calls expected; refusal happens client-side
    ]);
    await expect(applyDraftBranch({
      ...DEFAULT_INPUTS,
      stagePaths: [],
      execImpl: impl,
    })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'commit-failed',
      stage: 'stage',
    });
    // Five calls: status, fetch, checkout, apply --check, apply.
    // No git add / commit / push should have fired.
    expect(calls).toHaveLength(5);
  });

  it('git commit failure -> commit-failed (stage=commit)', async () => {
    const { impl } = stubExeca([
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout
      { exitCode: 0 }, // apply --check
      { exitCode: 0 }, // apply
      { exitCode: 0 }, // add
      { exitCode: 1, stdout: 'nothing to commit', stderr: '' },
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'commit-failed',
      stage: 'commit',
    });
  });

  it('push failure -> push-failed (commit already succeeded; SHA captured)', async () => {
    const { impl } = stubExeca([
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout
      { exitCode: 0 }, // apply --check
      { exitCode: 0 }, // apply
      { exitCode: 0 }, // add
      { exitCode: 0 }, // commit
      { exitCode: 0, stdout: 'abc1234567890123456789012345678901234567\n' }, // rev-parse
      { exitCode: 1, stderr: 'fatal: Authentication failed' },
    ]);
    await expect(applyDraftBranch({ ...DEFAULT_INPUTS, execImpl: impl })).rejects.toMatchObject({
      name: 'GitOpsError',
      reason: 'push-failed',
      stage: 'push',
    });
  });

  it('AbortSignal is forwarded to every git invocation', async () => {
    const controller = new AbortController();
    const { impl, calls } = stubExeca([
      { exitCode: 0 },                       // status (must be empty stdout = clean)
      { exitCode: 0 },                       // fetch
      { exitCode: 0 },                       // checkout
      { exitCode: 0 },                       // apply --check
      { exitCode: 0 },                       // apply
      { exitCode: 0 },                       // add
      { exitCode: 0 },                       // commit
      { exitCode: 0, stdout: 'abc1234\n' }, // rev-parse
      { exitCode: 0 },                       // push
    ]);
    await applyDraftBranch({
      ...DEFAULT_INPUTS,
      execImpl: impl,
      signal: controller.signal,
    });
    for (const c of calls) {
      expect(c.cancelSignal).toBe(controller.signal);
    }
  });
});
