import { describe, expect, it } from 'vitest';
import { validateSlug, parseGitWorktreeList } from '../../scripts/lib/wt.mjs';

describe('validateSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(validateSlug('kill-switch-cli')).toEqual({ ok: true, slug: 'kill-switch-cli' });
  });
  it('accepts single-word slugs', () => {
    expect(validateSlug('substrate')).toEqual({ ok: true, slug: 'substrate' });
  });
  it('rejects empty strings', () => {
    const r = validateSlug('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|required/i);
  });
  it('rejects slugs over 40 chars', () => {
    const long = 'a'.repeat(41);
    const r = validateSlug(long);
    expect(r.ok).toBe(false);
  });
  it('rejects slashes and spaces', () => {
    expect(validateSlug('feat/foo').ok).toBe(false);
    expect(validateSlug('foo bar').ok).toBe(false);
  });
  it('rejects leading or trailing dashes', () => {
    expect(validateSlug('-foo').ok).toBe(false);
    expect(validateSlug('foo-').ok).toBe(false);
  });
  it('normalizes uppercase to lowercase', () => {
    expect(validateSlug('Foo-Bar')).toEqual({ ok: true, slug: 'foo-bar' });
  });
});

describe('parseGitWorktreeList', () => {
  it('parses porcelain output with three worktrees', () => {
    const input = [
      'worktree C:/Users/opens/memory-governance',
      'HEAD 5ef8fea6d2e8f3f4a1b2c3d4e5f6a7b8c9d0e1f2',
      'branch refs/heads/main',
      '',
      'worktree C:/Users/opens/memory-governance/.worktrees/foo',
      'HEAD abc123...',
      'branch refs/heads/feat/foo',
      '',
      'worktree C:/Users/opens/memory-governance/.worktrees/bar',
      'HEAD def456...',
      'detached',
      '',
    ].join('\n');
    const r = parseGitWorktreeList(input);
    expect(r).toHaveLength(3);
    expect(r[0].branch).toBe('main');
    expect(r[1].branch).toBe('feat/foo');
    expect(r[2].branch).toBeNull();
    expect(r[2].detached).toBe(true);
  });
  it('handles empty input', () => {
    expect(parseGitWorktreeList('')).toEqual([]);
  });
});
