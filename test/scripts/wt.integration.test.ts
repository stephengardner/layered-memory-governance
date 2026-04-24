import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GATED = process.env['LAG_WT_INTEGRATION'] === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const WT_CLI = resolve(HERE, '../../scripts/wt.mjs');

(GATED ? describe : describe.skip)('wt integration round-trip', () => {
  it('creates, lists, and removes a worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-int-'));
    try {
      await execa('git', ['init', '-b', 'main'], { cwd: dir });
      await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execa('git', ['config', 'user.name', 'test'], { cwd: dir });
      await writeFile(join(dir, 'README.md'), '# test\n');
      await writeFile(join(dir, '.gitignore'), '/.worktrees/\n/NOTES.md\n');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-m', 'init'], { cwd: dir });

      // wt new foo
      await execa('node', [WT_CLI, 'new', 'foo', '--from', 'main'], {
        cwd: dir,
        env: { ...process.env, WT_SKIP_ACTIVITY_WARN: '1' },
      });
      expect(existsSync(join(dir, '.worktrees', 'foo', 'NOTES.md'))).toBe(true);

      // wt list shows foo
      const list = await execa('node', [WT_CLI, 'list'], { cwd: dir });
      expect(list.stdout).toMatch(/foo/);

      // wt rm foo --force --delete-branch
      await execa('node', [WT_CLI, 'rm', 'foo', '--force', '--delete-branch'], { cwd: dir });
      expect(existsSync(join(dir, '.worktrees', 'foo'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
