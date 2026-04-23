import { describe, expect, it } from 'vitest';
import { validateSlug, parseGitWorktreeList, detectActivity, detectStale, detectPackageManager } from '../../scripts/lib/wt.mjs';

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

describe('detectActivity', () => {
  const now = new Date('2026-04-21T22:00:00Z').getTime();
  it('flags recent HEAD move within activity window', () => {
    const r = detectActivity({
      headMtimeMs: now - 5 * 60 * 1000, // 5 minutes ago
      indexMtimeMs: now - 60 * 60 * 1000,
      hasLockfile: false,
      dirty: false,
      now,
      windowMs: 10 * 60 * 1000,
    });
    expect(r.active).toBe(true);
    expect(r.reasons).toContain('HEAD moved within activity window');
  });
  it('flags lockfile presence', () => {
    const r = detectActivity({
      headMtimeMs: now - 60 * 60 * 1000,
      indexMtimeMs: now - 60 * 60 * 1000,
      hasLockfile: true,
      dirty: false,
      now,
      windowMs: 10 * 60 * 1000,
    });
    expect(r.active).toBe(true);
    expect(r.reasons).toContain('git lockfile present');
  });
  it('flags dirty tree', () => {
    const r = detectActivity({
      headMtimeMs: now - 60 * 60 * 1000,
      indexMtimeMs: now - 60 * 60 * 1000,
      hasLockfile: false,
      dirty: true,
      now,
      windowMs: 10 * 60 * 1000,
    });
    expect(r.active).toBe(true);
    expect(r.reasons).toContain('uncommitted changes');
  });
  it('returns inactive when all signals are quiet', () => {
    const r = detectActivity({
      headMtimeMs: now - 24 * 60 * 60 * 1000,
      indexMtimeMs: now - 24 * 60 * 60 * 1000,
      hasLockfile: false,
      dirty: false,
      now,
      windowMs: 10 * 60 * 1000,
    });
    expect(r.active).toBe(false);
    expect(r.reasons).toEqual([]);
  });
});

describe('detectStale', () => {
  const now = new Date('2026-04-21T22:00:00Z').getTime();
  const DAY = 24 * 60 * 60 * 1000;
  it('flags worktrees with no commits for 14+ days', () => {
    const r = detectStale({
      lastCommitMs: now - 15 * DAY,
      notesMtimeMs: now - 1 * DAY,
      branchMerged: false,
      prClosed: false,
      now,
      thresholdMs: 14 * DAY,
    });
    expect(r.stale).toBe(true);
    expect(r.reasons).toContain('no commits for 14+ days');
  });
  it('flags merged branches', () => {
    const r = detectStale({
      lastCommitMs: now,
      notesMtimeMs: now,
      branchMerged: true,
      prClosed: false,
      now,
      thresholdMs: 14 * DAY,
    });
    expect(r.stale).toBe(true);
    expect(r.reasons).toContain('branch merged to main');
  });
  it('returns not-stale for a fresh active worktree', () => {
    const r = detectStale({
      lastCommitMs: now - 1 * DAY,
      notesMtimeMs: now - 1 * DAY,
      branchMerged: false,
      prClosed: false,
      now,
      thresholdMs: 14 * DAY,
    });
    expect(r.stale).toBe(false);
  });
});

describe('detectPackageManager', () => {
  it('picks npm for package.json', () => {
    expect(detectPackageManager(['package.json'])).toEqual({ tool: 'npm', install: 'npm install' });
  });
  it('picks cargo for Cargo.toml', () => {
    expect(detectPackageManager(['Cargo.toml'])).toEqual({ tool: 'cargo', install: 'cargo build' });
  });
  it('picks poetry for pyproject.toml', () => {
    expect(detectPackageManager(['pyproject.toml'])).toEqual({ tool: 'poetry', install: 'poetry install' });
  });
  it('picks go for go.mod', () => {
    expect(detectPackageManager(['go.mod'])).toEqual({ tool: 'go', install: 'go mod download' });
  });
  it('prefers first matched when multiple manifests present', () => {
    expect(detectPackageManager(['package.json', 'go.mod']).tool).toBe('npm');
  });
  it('returns null for none', () => {
    expect(detectPackageManager(['README.md'])).toBeNull();
  });
});
