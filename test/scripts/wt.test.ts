import { describe, expect, it } from 'vitest';
import { validateSlug, parseGitWorktreeList, detectActivity, detectStale, detectPackageManager, renderNotesSkeleton } from '../../scripts/lib/wt.mjs';

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
  it('flags stale when prClosed is true (CR #128 coverage gap)', () => {
    const r = detectStale({
      lastCommitMs: now,
      notesMtimeMs: now,
      branchMerged: false,
      prClosed: true,
      now,
      thresholdMs: 14 * DAY,
    });
    expect(r.stale).toBe(true);
    expect(r.reasons).toContain('PR closed');
  });
  it('reason string reflects the threshold actually passed (not a hardcoded "14+ days")', () => {
    const r = detectStale({
      lastCommitMs: now - 10 * DAY,
      notesMtimeMs: now - 10 * DAY,
      branchMerged: false,
      prClosed: false,
      now,
      thresholdMs: 7 * DAY,
    });
    expect(r.stale).toBe(true);
    expect(r.reasons[0]).toMatch(/no commits for 7\+ days/);
  });
});

describe('detectPackageManager', () => {
  it('picks npm for package.json alone (no lockfile, no Corepack field)', () => {
    expect(detectPackageManager(['package.json'])).toEqual({ tool: 'npm', install: 'npm install' });
  });
  it('picks pnpm when pnpm-lock.yaml is present alongside package.json', () => {
    expect(detectPackageManager(['package.json', 'pnpm-lock.yaml'])).toEqual({
      tool: 'pnpm',
      install: 'pnpm install',
    });
  });
  it('picks yarn when yarn.lock is present alongside package.json', () => {
    expect(detectPackageManager(['package.json', 'yarn.lock'])).toEqual({
      tool: 'yarn',
      install: 'yarn install',
    });
  });
  it('picks bun when bun.lockb is present alongside package.json', () => {
    expect(detectPackageManager(['package.json', 'bun.lockb'])).toEqual({
      tool: 'bun',
      install: 'bun install',
    });
  });
  it('honors Corepack packageManager field when no lockfile present', () => {
    const pkg = JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0' });
    expect(detectPackageManager(['package.json'], pkg)).toEqual({
      tool: 'pnpm',
      install: 'pnpm install',
    });
  });
  it('lockfile wins over Corepack packageManager field (concrete state beats declaration)', () => {
    const pkg = JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0' });
    expect(detectPackageManager(['package.json', 'yarn.lock'], pkg).tool).toBe('yarn');
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
  it('package.json wins over non-JS manifests (prioritizes the JS toolchain)', () => {
    expect(detectPackageManager(['package.json', 'go.mod']).tool).toBe('npm');
  });
  it('returns null for none', () => {
    expect(detectPackageManager(['README.md'])).toBeNull();
  });
  it('gracefully handles malformed package.json (falls back to plain npm)', () => {
    expect(detectPackageManager(['package.json'], '{ not valid json')).toEqual({
      tool: 'npm',
      install: 'npm install',
    });
  });
});

describe('renderNotesSkeleton', () => {
  it('renders a complete skeleton with slug and base', () => {
    const out = renderNotesSkeleton({
      slug: 'foo-bar',
      baseLabel: 'main',
      baseSha: '5ef8fea',
    });
    expect(out).toContain('# foo-bar');
    // Pin the literal template form so the plan doc and the renderer
    // cannot silently drift (CR #128: `**Intent**` vs `**Intent:**`
    // matched either variant and the drift went unnoticed).
    expect(out).toContain('**Intent** (1 line: what this worktree exists to do)');
    expect(out).toContain('**Branched off:** main @ 5ef8fea');
    expect(out).toContain('## Open threads');
    expect(out).toContain('## Decisions this worktree');
    expect(out).toContain('## Next pick-up');
  });
});
