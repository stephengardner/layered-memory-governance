import { describe, expect, it } from 'vitest';
import {
  validateSlug,
  parseGitWorktreeList,
  detectActivity,
  detectStale,
  detectPackageManager,
  renderNotesSkeleton,
  prStateToStaleSignals,
  findWorktreeBySlug,
  parseCleanFlags,
  classifyBranchRefs,
  localTrunkBranchName,
} from '../../scripts/lib/wt.mjs';

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

describe('prStateToStaleSignals', () => {
  // The CLI calls `gh pr view --json state --jq .state`; this helper
  // translates the raw state string into the stale-detection signals
  // (branchMerged, prClosed) that `cmdClean` feeds to `detectStale`.
  //
  // Regression context (post-#128 live dogfood): the original
  // implementation only flagged PR state === 'CLOSED', and set
  // `branchMerged` solely via `git branch --merged`. Squash-merge and
  // rebase-merge produce main-side commits whose ancestry does NOT
  // include the source branch tip, so `--merged` returns false for
  // every squash-merged branch. 20+ worktrees with `AHEAD>0 + PR=MERGED`
  // slipped through `wt clean` as a result. This helper makes PR state
  // an authoritative merge signal.
  it('treats MERGED as branchMerged (catches squash-merge blindspot)', () => {
    expect(prStateToStaleSignals('MERGED')).toEqual({ branchMerged: true, prClosed: false });
  });
  it('treats CLOSED as prClosed', () => {
    expect(prStateToStaleSignals('CLOSED')).toEqual({ branchMerged: false, prClosed: true });
  });
  it('treats OPEN as no signal', () => {
    expect(prStateToStaleSignals('OPEN')).toEqual({ branchMerged: false, prClosed: false });
  });
  it('is case-insensitive (defensive against gh output drift)', () => {
    expect(prStateToStaleSignals('merged')).toEqual({ branchMerged: true, prClosed: false });
    expect(prStateToStaleSignals('closed')).toEqual({ branchMerged: false, prClosed: true });
  });
  it('trims whitespace', () => {
    expect(prStateToStaleSignals('  MERGED  \n')).toEqual({ branchMerged: true, prClosed: false });
  });
  it('returns no signal for empty / null / undefined', () => {
    expect(prStateToStaleSignals('')).toEqual({ branchMerged: false, prClosed: false });
    expect(prStateToStaleSignals(null as unknown as string)).toEqual({ branchMerged: false, prClosed: false });
    expect(prStateToStaleSignals(undefined as unknown as string)).toEqual({ branchMerged: false, prClosed: false });
  });
  it('returns no signal for unrecognized states', () => {
    expect(prStateToStaleSignals('DRAFT')).toEqual({ branchMerged: false, prClosed: false });
    expect(prStateToStaleSignals('PENDING')).toEqual({ branchMerged: false, prClosed: false });
  });
});

describe('findWorktreeBySlug', () => {
  // Regression: the first pass of the cmdRm --delete-branch fix used
  // `r.path === wtPath`, which failed every Windows scenario because
  // `git worktree list --porcelain` emits forward-slash paths while
  // `path.join` produces backslashes. A 2026-04-24 live smoke test
  // caught the bug after the initial fix had already passed ubuntu +
  // windows CI (no existing test exercised this code path).
  it('finds a record by forward-slash path', () => {
    const records = [
      { path: 'C:/Users/opens/memory-governance/.worktrees/foo', branch: 'chore/foo' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toEqual(records[0]);
  });
  it('finds a record by backslash path (Windows path.join output)', () => {
    const records = [
      { path: 'C:\\Users\\opens\\memory-governance\\.worktrees\\foo', branch: 'chore/foo' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toEqual(records[0]);
  });
  it('finds a record by mixed-separator path', () => {
    const records = [
      { path: 'C:/Users\\opens/memory-governance\\.worktrees/foo', branch: 'chore/foo' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toEqual(records[0]);
  });
  it('finds a record by posix path', () => {
    const records = [
      { path: '/home/user/repo/.worktrees/foo', branch: 'feat/foo' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toEqual(records[0]);
  });
  it('returns the first match when multiple candidates exist', () => {
    const records = [
      { path: '/a/.worktrees/foo', branch: 'feat/foo' },
      { path: '/b/.worktrees/foo', branch: 'chore/foo' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toEqual(records[0]);
  });
  it('returns undefined when no record matches', () => {
    const records = [
      { path: '/a/.worktrees/bar', branch: 'feat/bar' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toBeUndefined();
  });
  it('skips records with null or empty path', () => {
    const records = [
      { path: null, branch: 'feat/foo' },
      { path: '', branch: 'feat/foo' },
      { path: '/a/.worktrees/foo', branch: 'chore/foo' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toEqual(records[2]);
  });
  it('returns undefined for invalid inputs', () => {
    expect(findWorktreeBySlug(null as unknown as [], 'foo')).toBeUndefined();
    expect(findWorktreeBySlug([], '')).toBeUndefined();
    expect(findWorktreeBySlug([], null as unknown as string)).toBeUndefined();
  });
  it('does not match a partial slug substring', () => {
    const records = [
      { path: '/a/.worktrees/foo-bar', branch: 'feat/foo-bar' },
    ];
    expect(findWorktreeBySlug(records, 'foo')).toBeUndefined();
    expect(findWorktreeBySlug(records, 'foo-bar')).toEqual(records[0]);
  });
});

describe('parseCleanFlags', () => {
  // CR #154 learning: `.mjs` scripts are not tsc-type-checked and
  // Vitest runs transpile-only, so a regression that flips flag
  // precedence would go unnoticed until a live invocation. These
  // tests pin the (dryRun, yes) contract so cmdClean's branching
  // stays honest.
  it('returns both false for no flags', () => {
    expect(parseCleanFlags([])).toEqual({ dryRun: false, yes: false });
  });
  it('parses --dry-run alone', () => {
    expect(parseCleanFlags(['--dry-run'])).toEqual({ dryRun: true, yes: false });
  });
  it('parses --yes alone', () => {
    expect(parseCleanFlags(['--yes'])).toEqual({ dryRun: false, yes: true });
  });
  it('accepts -y as a short form of --yes', () => {
    expect(parseCleanFlags(['-y'])).toEqual({ dryRun: false, yes: true });
  });
  it('parses --dry-run + --yes together (dry-run wins in caller)', () => {
    expect(parseCleanFlags(['--dry-run', '--yes'])).toEqual({ dryRun: true, yes: true });
  });
  it('ignores unrelated flags', () => {
    expect(parseCleanFlags(['--force', 'foo', '--other'])).toEqual({ dryRun: false, yes: false });
  });
});

describe('classifyBranchRefs', () => {
  it('partitions into protected / inWorktree / candidates (exact shape)', () => {
    // Tighter assertion per CR #155 nit: lock the full partition shape
    // including the currentBranch === trunkBranch dedup behavior.
    const branches = ['main', 'feat/a', 'feat/b', 'fix/c'];
    const wtRecords = [
      { path: '/r', branch: 'main' },
      { path: '/r/.worktrees/a', branch: 'feat/a' },
    ];
    expect(classifyBranchRefs(branches, wtRecords, 'main', 'main')).toEqual({
      protected: ['main'],
      inWorktree: ['feat/a'],
      candidates: ['feat/b', 'fix/c'],
    });
  });
  it('protects current HEAD branch even when no worktree record matches it', () => {
    const r = classifyBranchRefs(['feat/x', 'feat/y'], [], 'feat/x', 'main');
    expect(r.protected).toContain('feat/x');
    expect(r.candidates).toEqual(['feat/y']);
  });
  it('treats a missing currentBranch (null/detached) as not protecting any branch', () => {
    const r = classifyBranchRefs(['feat/x'], [], null, 'main');
    expect(r.candidates).toEqual(['feat/x']);
  });
  it('ignores null branch entries in worktree records (detached worktrees)', () => {
    const wt = [{ path: '/r/.worktrees/det', branch: null }];
    const r = classifyBranchRefs(['feat/a'], wt, null, 'main');
    expect(r.candidates).toEqual(['feat/a']);
    expect(r.inWorktree).toEqual([]);
  });
  it('honors a non-main trunk (e.g. master)', () => {
    const r = classifyBranchRefs(['master', 'feat/x'], [], null, 'master');
    expect(r.protected).toContain('master');
    expect(r.candidates).toEqual(['feat/x']);
  });
  it('skips empty / non-string entries defensively', () => {
    const r = classifyBranchRefs(['', 'feat/a', null as unknown as string], [], null, 'main');
    expect(r.candidates).toEqual(['feat/a']);
  });
  it('handles empty inputs', () => {
    const r = classifyBranchRefs([], [], null, 'main');
    expect(r).toEqual({ protected: [], inWorktree: [], candidates: [] });
  });
});

describe('localTrunkBranchName', () => {
  // CR #155 Major: the original slash-split logic produced 'heads/main'
  // for 'refs/heads/main', leaving main unprotected. These tests pin
  // the ref-prefix handling for all common WT_TRUNK_REF shapes.
  it('returns a bare branch name unchanged', () => {
    expect(localTrunkBranchName('main')).toBe('main');
    expect(localTrunkBranchName('master')).toBe('master');
  });
  it('strips a remote prefix (origin/main -> main)', () => {
    expect(localTrunkBranchName('origin/main')).toBe('main');
    expect(localTrunkBranchName('upstream/main')).toBe('main');
  });
  it('strips refs/heads/ fully-qualified form', () => {
    expect(localTrunkBranchName('refs/heads/main')).toBe('main');
    expect(localTrunkBranchName('refs/heads/master')).toBe('master');
  });
  it('strips refs/remotes/<remote>/ fully-qualified form', () => {
    expect(localTrunkBranchName('refs/remotes/origin/main')).toBe('main');
    expect(localTrunkBranchName('refs/remotes/upstream/develop')).toBe('develop');
  });
  it('trims whitespace', () => {
    expect(localTrunkBranchName('  origin/main  ')).toBe('main');
  });
  it('returns empty string on non-string or empty input', () => {
    expect(localTrunkBranchName('')).toBe('');
    expect(localTrunkBranchName(null as unknown as string)).toBe('');
    expect(localTrunkBranchName(undefined as unknown as string)).toBe('');
  });
});
