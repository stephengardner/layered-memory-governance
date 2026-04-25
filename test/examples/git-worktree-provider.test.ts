import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeProvider } from '../../examples/workspace-providers/git-worktree/index.js';
import { runWorkspaceProviderContract } from '../substrate/workspace-provider-contract.test.js';
import type { PrincipalId } from '../../src/substrate/types.js';

let repoDir: string;

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lag-wt-test-'));
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await mkdir(join(dir, '.lag', 'apps'), { recursive: true });
  await writeFile(join(dir, '.lag', 'apps', 'lag-ceo.json'), '{"role":"lag-ceo"}');
  await writeFile(join(dir, 'README.md'), 'hello');
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

beforeEach(async () => {
  repoDir = await initRepo();
});

afterEach(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

runWorkspaceProviderContract('GitWorktreeProvider', () => new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] }));

describe('GitWorktreeProvider specifics', () => {
  it('creates a worktree on the requested base ref', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-1' });
    try {
      const s = await stat(ws.path);
      expect(s.isDirectory()).toBe(true);
      // README.md from the base commit should be present.
      const r = await stat(join(ws.path, 'README.md'));
      expect(r.isFile()).toBe(true);
    } finally {
      await p.release(ws);
    }
  });

  it('copies bot creds for requested roles only', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-2' });
    try {
      const credPath = join(ws.path, '.lag', 'apps', 'lag-ceo.json');
      const s = await stat(credPath);
      expect(s.isFile()).toBe(true);
    } finally {
      await p.release(ws);
    }
  });

  it('does not copy creds for roles not requested', async () => {
    // Provision a second role's cred in the parent.
    await mkdir(join(repoDir, '.lag', 'apps'), { recursive: true });
    await writeFile(join(repoDir, '.lag', 'apps', 'lag-cto.json'), '{"role":"lag-cto"}');
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-no-cto' });
    try {
      // lag-ceo present
      await expect(stat(join(ws.path, '.lag', 'apps', 'lag-ceo.json'))).resolves.toBeDefined();
      // lag-cto MUST NOT have been copied
      await expect(stat(join(ws.path, '.lag', 'apps', 'lag-cto.json'))).rejects.toThrow();
    } finally {
      await p.release(ws);
    }
  });

  it('release removes the worktree directory', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-3' });
    await p.release(ws);
    await expect(stat(ws.path)).rejects.toThrow();
  });

  it('rejects unknown base ref', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    await expect(p.acquire({ principal: 'p' as PrincipalId, baseRef: 'no-such-ref', correlationId: 'spec-4' })).rejects.toThrow(/baseRef/);
  });

  it('sanitizes correlation_id in path (no .. survives any form)', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    // Test multiple traversal-attempt shapes, each with a distinct
    // suffix so the resulting branch names don't collide across the
    // loop iterations (tests share the same `repoDir`).
    // Use distinctive label tokens so the includes-check actually
    // proves the label survived sanitization (single-letter labels
    // like 'a','b' would coincidentally appear in surrounding text
    // such as 'escape', 'attempt-a').
    const attempts = [
      { raw: '../escape-XQA1', label: 'XQA1' },
      { raw: '..\\windows-XQB2', label: 'XQB2' },
      { raw: '....\\double-XQC3', label: 'XQC3' },
      { raw: '../../absolute-XQD4', label: 'XQD4' },
    ];
    for (const { raw, label } of attempts) {
      const ws = await p.acquire({ principal: 'p' as PrincipalId, baseRef: 'main', correlationId: raw });
      try {
        // The sanitized id portion of the path must NOT contain ANY '..' substring.
        const idPortion = ws.id;
        expect(idPortion.includes('..')).toBe(false);
        // And the full path must not contain a parent-traversal segment.
        expect(ws.path.includes('..' + '/') || ws.path.includes('..\\')).toBe(false);
        // Sanity that we tested distinct attempts.
        expect(idPortion.includes(label)).toBe(true);
      } finally {
        await p.release(ws);
      }
    }
  });
});

describe('GitWorktreeProvider checkoutBranch', () => {
  it('checks out an existing local branch (does NOT pass -b to worktree add)', async () => {
    // Fresh repo with an extra branch `feat/x` we will request via
    // `checkoutBranch`. Independent of the suite-level repo so the
    // execa-spy assertion is unambiguous.
    const dir = await mkdtemp(join(tmpdir(), 'lag-checkout-'));
    await execa('git', ['init', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await writeFile(join(dir, 'a.md'), 'a\n');
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['commit', '-m', 'initial'], { cwd: dir });
    await execa('git', ['branch', 'feat/x'], { cwd: dir });

    // Spy on execa via the new `execImpl` injection point so we can
    // read argv. Skip cred-copy in this test (`copyCredsForRoles: []`)
    // so the asserted argv set is exactly the worktree-add path; cred
    // semantics are covered by sibling tests above.
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    const provider = new GitWorktreeProvider({
      repoDir: dir,
      copyCredsForRoles: [],
      execImpl: (async (bin: string, args: ReadonlyArray<string>, opts: unknown) => {
        calls.push({ args: args.slice() });
        return execa(bin, args.slice(), opts as never);
      }) as never,
    });
    let ws: Awaited<ReturnType<typeof provider.acquire>> | undefined;
    try {
      ws = await provider.acquire({
        principal: 'p' as PrincipalId,
        baseRef: 'main',
        correlationId: 'corr-1',
        checkoutBranch: 'feat/x',
      });
      // Worktree HEAD must be on the existing branch (NOT a new
      // `agentic/<id>` branch).
      const r = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path });
      expect(r.stdout.trim()).toBe('feat/x');
      // Regression assertion: `worktree add` MUST NOT have used `-b`.
      // A future revert that re-introduces the `-b` flag fails loud
      // here.
      const addCalls = calls.filter((c) => c.args.includes('worktree') && c.args.includes('add'));
      expect(addCalls.length).toBeGreaterThan(0);
      for (const c of addCalls) {
        expect(c.args).not.toContain('-b');
      }
    } finally {
      if (ws !== undefined) await provider.release(ws);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects checkoutBranch containing `..`', async () => {
    // Defense-in-depth path-traversal guard: a branch name with `..`
    // segments must throw before any git command runs.
    const dir = await mkdtemp(join(tmpdir(), 'lag-checkout-bad-'));
    try {
      await execa('git', ['init', '-b', 'main'], { cwd: dir });
      await execa('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
      await writeFile(join(dir, 'a.md'), 'a\n');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-m', 'i'], { cwd: dir });
      const provider = new GitWorktreeProvider({ repoDir: dir, copyCredsForRoles: [] });
      await expect(provider.acquire({
        principal: 'p' as PrincipalId,
        baseRef: 'main',
        correlationId: 'corr-bad',
        checkoutBranch: '../escape',
      })).rejects.toThrow(/must not contain/);
    } finally {
      // Cleanup must run even if the assertion above fails, otherwise
      // the bootstrap repo lingers in os.tmpdir(). Mirrors the
      // try/finally pattern in the sibling test on L170-173.
      await rm(dir, { recursive: true, force: true });
    }
  });
});
