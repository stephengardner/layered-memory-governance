# Worktree-first parallel workflow  -  implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `.worktrees/<slug>/` + `NOTES.md` + `wt` CLI + skill so parallel agents stop colliding on a shared checkout, and codify the rule as L3 canon.

**Architecture:** A thin Node CLI (`scripts/wt.mjs`) dispatches over pure helper functions in `scripts/lib/wt.mjs`. The helpers are unit-testable with vitest and have zero imports from `src/`, `dist/`, or `.lag/`  -  enforced by a static portability test. The CLI wraps `git worktree`, `gh` (graceful fallback), and `git-spice` (`gs`). A `.claude/skills/worktree-workflow/SKILL.md` documents the workflow; one L3 canon atom encodes the rule; a memory update revises the prior "never stack" note to reflect the nuance.

**Tech stack:** Node >=22 (ES modules), vitest, execa (existing dep), plain `git` + optional `gh` + optional `gs`. No new runtime deps.

**Working branch:** `feat/worktree-workflow` in `.worktrees/worktree-workflow/`. Spec at `docs/superpowers/specs/2026-04-21-worktree-workflow-design.md`.

**Out of scope (explicit):**
- **No migration** of existing sibling worktrees (`../memory-governance-apps`, `../memory-governance-substrate`) in this PR. Migration ships as a separate small PR after the agents currently using those worktrees hand off.
- **No edit to `apps/console/CLAUDE.md:43`** in this PR  -  that file still documents the sibling convention and must stay consistent with reality until migration.
- **No Stop-hook** for NOTES.md staleness; deferred to phase 2 if cadence proves insufficient.
- **No scheduled cleanup job.**

---

## File structure

**Create:**
- `scripts/lib/wt.mjs`  -  pure helpers (slug validation, worktree-list parser, activity/stale detectors, package-manager detect, NOTES skeleton). ~200 lines max.
- `scripts/wt.mjs`  -  CLI entry dispatching `new|list|rm|clean|stack|note`. ~250 lines max.
- `test/scripts/wt.test.ts`  -  unit tests against `scripts/lib/wt.mjs`.
- `test/scripts/wt.portability.test.ts`  -  static test: `scripts/wt.mjs` and `scripts/lib/wt.mjs` import nothing from `src/`, `dist/`, or `.lag/`.
- `test/scripts/wt.integration.test.ts`  -  round-trip: `new foo → list → rm foo` against a throwaway git repo under `os.tmpdir()`. Gated behind `LAG_WT_INTEGRATION=1` so default CI doesn't need a writable tmp.
- `.claude/skills/worktree-workflow/SKILL.md`  -  skill file.
- `scripts/bootstrap-workflow-canon.mjs`  -  canon atom bootstrap for the new L3 directive.

**Modify:**
- `CLAUDE.md` (repo root)  -  add one-paragraph pointer to the new skill under an existing section (do NOT edit the auto-managed canon block).
- `package.json`  -  add `"wt": "node scripts/wt.mjs"` npm script; add bootstrap target if needed.
- `scripts/bootstrap-all-canon.mjs`  -  call the new bootstrap in its pipeline (if the pattern applies; verify at task time).
- Operator-local auto-memory entry `feedback_branch_off_main_not_stacks` (outside the repo; operator resolves the path on their own machine via their memory tooling)  -  revise to reflect the stacking-allowed-for-genuine-coupling nuance.

**Do NOT modify:**
- `apps/console/CLAUDE.md` (sibling-convention reference stays until migration PR).
- `../memory-governance-apps` or `../memory-governance-substrate` (live agents).
- Any file under `src/` or `dist/`.
- The main checkout's working tree  -  all changes happen in this worktree and land via PR.

---

## Task 1: Write the worktree-workflow skill

**Files:**
- Create: `.claude/skills/worktree-workflow/SKILL.md`

- [ ] **Step 1: Read the reference skill**

Read the `superpowers:using-git-worktrees` skill (via its plugin-qualified name so the resolver picks up whatever version is installed) to match its tone, structure, and "Announce at start" convention.

- [ ] **Step 2: Write the skill file**

Content sections (in order):
1. Frontmatter (`name: worktree-workflow`, `description: Use when starting any parallel unit of work in this repo  -  isolates a branch into `.worktrees/<slug>/`, writes a NOTES.md handoff doc, and leaves the main checkout untouched`).
2. **Overview**  -  what the skill does, when to use it.
3. **Announce at start** (matches superpowers skill convention).
4. **Creating a worktree**  -  `wt new <slug>`, what it does step-by-step.
5. **NOTES.md schema**  -  the full template from spec §2.
6. **Listing and staleness**  -  `wt list` output + default thresholds (10-min activity, 14-day stale), overridable via env.
7. **Removing a worktree**  -  `wt rm <slug>` confirmations.
8. **Cleanup**  -  `wt clean`, operator-invoked, default-skip prompts.
9. **Stacking**  -  the codified test ("does child compile without parent?"), `wt stack`, `git-spice` install link, loud failure if `gs` missing.
10. **Common mistakes**  -  editing outside your worktree, creating one when another agent is mid-work, committing NOTES.md by accident.
11. **Integration**  -  when this skill is called by other skills (paired with `using-git-worktrees`, called before any implementation plan execution).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/worktree-workflow/SKILL.md
git commit -m "skill: add worktree-workflow skill for parallel-agent isolation"
```

---

## Task 2: Slug validation helper (TDD)

**Files:**
- Create: `scripts/lib/wt.mjs`
- Create: `test/scripts/wt.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/scripts/wt.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { validateSlug } from '../../scripts/lib/wt.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd .worktrees/worktree-workflow && npx vitest run test/scripts/wt.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement `validateSlug` in `scripts/lib/wt.mjs`**

```javascript
// scripts/lib/wt.mjs  -  pure helpers for scripts/wt.mjs.
// Zero imports from src/, dist/, or .lag/ (enforced by wt.portability.test.ts).

/**
 * Validate a worktree slug. Returns { ok: true, slug } on success (with
 * normalized form) or { ok: false, reason } on failure.
 *
 * Rules:
 *   - 1-40 chars
 *   - lowercase after normalization
 *   - only [a-z0-9-]
 *   - no leading/trailing dash
 */
export function validateSlug(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'slug is required' };
  }
  const normalized = input.toLowerCase();
  if (normalized.length > 40) {
    return { ok: false, reason: `slug too long (${normalized.length} > 40 chars)` };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    return {
      ok: false,
      reason: 'slug must be [a-z0-9-], no leading/trailing dash, no spaces or slashes',
    };
  }
  return { ok: true, slug: normalized };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd .worktrees/worktree-workflow && npx vitest run test/scripts/wt.test.ts -t validateSlug
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/wt.mjs test/scripts/wt.test.ts
git commit -m "wt: slug validation helper + tests"
```

---

## Task 3: `git worktree list` parser (TDD)

**Files:**
- Modify: `scripts/lib/wt.mjs`
- Modify: `test/scripts/wt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/scripts/wt.test.ts`:

```typescript
import { parseGitWorktreeList } from '../../scripts/lib/wt.mjs';

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
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run test/scripts/wt.test.ts -t parseGitWorktreeList
```

Expected: FAIL (function not exported).

- [ ] **Step 3: Implement**

In `scripts/lib/wt.mjs` append:

```javascript
/**
 * Parse `git worktree list --porcelain` output.
 * Returns array of { path, head, branch, detached } records.
 */
export function parseGitWorktreeList(output) {
  const blocks = output.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const rec = { path: null, head: null, branch: null, detached: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) rec.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) rec.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) rec.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'detached') rec.detached = true;
    }
    return rec;
  });
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run test/scripts/wt.test.ts -t parseGitWorktreeList
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/wt.mjs test/scripts/wt.test.ts
git commit -m "wt: parse git worktree list porcelain output"
```

---

## Task 4: Activity detector (TDD)

**Files:**
- Modify: `scripts/lib/wt.mjs`
- Modify: `test/scripts/wt.test.ts`

- [ ] **Step 1: Failing test**

Append to `test/scripts/wt.test.ts`:

```typescript
import { detectActivity } from '../../scripts/lib/wt.mjs';

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
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run test/scripts/wt.test.ts -t detectActivity
```

- [ ] **Step 3: Implement**

Append to `scripts/lib/wt.mjs`:

```javascript
/**
 * Decide whether a worktree is "active" based on injected signals.
 * Pure function: caller does the filesystem reads.
 *
 * Used by `wt new` and `wt list` to warn before creating a new worktree
 * on the same branch / slug, or before proposing to remove a worktree
 * someone else is mid-work in.
 */
export function detectActivity({
  headMtimeMs,
  indexMtimeMs,
  hasLockfile,
  dirty,
  now,
  windowMs,
}) {
  const reasons = [];
  if (now - headMtimeMs < windowMs) reasons.push('HEAD moved within activity window');
  if (now - indexMtimeMs < windowMs) reasons.push('index touched within activity window');
  if (hasLockfile) reasons.push('git lockfile present');
  if (dirty) reasons.push('uncommitted changes');
  return { active: reasons.length > 0, reasons };
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run test/scripts/wt.test.ts -t detectActivity
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/wt.mjs test/scripts/wt.test.ts
git commit -m "wt: parallel-agent activity detector (pure)"
```

---

## Task 5: Stale detector (TDD)

**Files:**
- Modify: `scripts/lib/wt.mjs`
- Modify: `test/scripts/wt.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { detectStale } from '../../scripts/lib/wt.mjs';

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
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run test/scripts/wt.test.ts -t detectStale
```

- [ ] **Step 3: Implement**

```javascript
export function detectStale({
  lastCommitMs,
  notesMtimeMs,
  branchMerged,
  prClosed,
  now,
  thresholdMs,
}) {
  const reasons = [];
  if (now - lastCommitMs > thresholdMs) reasons.push('no commits for 14+ days');
  if (now - notesMtimeMs > thresholdMs) reasons.push('NOTES.md untouched for 14+ days');
  if (branchMerged) reasons.push('branch merged to main');
  if (prClosed) reasons.push('PR closed');
  return { stale: reasons.length > 0, reasons };
}
```

- [ ] **Step 4: Verify pass + Commit**

```bash
npx vitest run test/scripts/wt.test.ts -t detectStale
git add scripts/lib/wt.mjs test/scripts/wt.test.ts
git commit -m "wt: stale-candidate detector for wt list + wt clean"
```

---

## Task 6: Package-manager auto-detect (TDD)

**Files:**
- Modify: `scripts/lib/wt.mjs`
- Modify: `test/scripts/wt.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { detectPackageManager } from '../../scripts/lib/wt.mjs';

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
```

- [ ] **Step 2: Implement**

```javascript
const PACKAGE_MANAGERS = [
  { file: 'package.json', tool: 'npm', install: 'npm install' },
  { file: 'Cargo.toml', tool: 'cargo', install: 'cargo build' },
  { file: 'pyproject.toml', tool: 'poetry', install: 'poetry install' },
  { file: 'go.mod', tool: 'go', install: 'go mod download' },
];

export function detectPackageManager(rootFiles) {
  const set = new Set(rootFiles);
  for (const pm of PACKAGE_MANAGERS) {
    if (set.has(pm.file)) return { tool: pm.tool, install: pm.install };
  }
  return null;
}
```

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run test/scripts/wt.test.ts -t detectPackageManager
git add scripts/lib/wt.mjs test/scripts/wt.test.ts
git commit -m "wt: package-manager auto-detect (npm/cargo/poetry/go)"
```

---

## Task 7: NOTES.md skeleton generator (TDD)

**Files:**
- Modify: `scripts/lib/wt.mjs`
- Modify: `test/scripts/wt.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { renderNotesSkeleton } from '../../scripts/lib/wt.mjs';

describe('renderNotesSkeleton', () => {
  it('renders a complete skeleton with slug and base', () => {
    const out = renderNotesSkeleton({
      slug: 'foo-bar',
      baseLabel: 'main',
      baseSha: '5ef8fea',
    });
    expect(out).toContain('# foo-bar');
    expect(out).toContain('**Intent**');
    expect(out).toContain('main @ 5ef8fea');
    expect(out).toContain('## Open threads');
    expect(out).toContain('## Decisions this worktree');
    expect(out).toContain('## Next pick-up');
  });
});
```

- [ ] **Step 2: Implement**

```javascript
export function renderNotesSkeleton({ slug, baseLabel, baseSha }) {
  return `# ${slug}

**Intent** (1 line: what this worktree exists to do)
**Branched off:** ${baseLabel} @ ${baseSha}
**PR:** (pending)

## Open threads
- [ ] (what's in flight)

## Decisions this worktree
- (record non-obvious choices as you make them)

## Next pick-up
If a fresh agent opens this worktree: (first action)
`;
}
```

- [ ] **Step 3: Verify + commit**

---

## Task 8: CLI dispatcher scaffold

**Files:**
- Create: `scripts/wt.mjs`

- [ ] **Step 1: Write the scaffold**

```javascript
#!/usr/bin/env node
/**
 * wt: worktree-first parallel workflow CLI.
 *
 * Thin dispatcher over pure helpers in ./lib/wt.mjs, plus child-process
 * calls to git, gh (optional, graceful fallback), and gs / git-spice
 * (required for `wt stack`).
 *
 * Commands: new, list, rm, clean, stack, note.
 *
 * Zero imports from src/, dist/, or .lag/  -  enforced by
 * test/scripts/wt.portability.test.ts.
 */

import { execa } from 'execa';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateSlug,
  parseGitWorktreeList,
  detectActivity,
  detectStale,
  detectPackageManager,
  renderNotesSkeleton,
} from './lib/wt.mjs';

const COMMANDS = ['new', 'list', 'rm', 'clean', 'stack', 'note'];

function usage() {
  console.log(`Usage: wt <command> [args]

Commands:
  new <slug> [--from <base>]     Create worktree + branch off main (or parent).
  list                            Show all worktrees with state + stale flags.
  rm <slug>                       Remove worktree (confirms if dirty or unmerged).
  clean [--dry-run]               Prompt to remove merged/abandoned worktrees.
  stack <parent> <child>          Create child stacked on parent via git-spice.
  note [<slug>]                   Open NOTES.md in $EDITOR.

Env:
  WT_ACTIVITY_MIN   Activity-window minutes (default 10).
  WT_STALE_DAYS     Stale-threshold days (default 14).`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); process.exit(0); }
  if (!COMMANDS.includes(cmd)) {
    console.error(`[wt] unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }
  // Command handlers wired in subsequent tasks.
  switch (cmd) {
    case 'new': return cmdNew(args);
    case 'list': return cmdList(args);
    case 'rm': return cmdRm(args);
    case 'clean': return cmdClean(args);
    case 'stack': return cmdStack(args);
    case 'note': return cmdNote(args);
  }
}

async function cmdNew(args) { throw new Error('not implemented'); }
async function cmdList(args) { throw new Error('not implemented'); }
async function cmdRm(args) { throw new Error('not implemented'); }
async function cmdClean(args) { throw new Error('not implemented'); }
async function cmdStack(args) { throw new Error('not implemented'); }
async function cmdNote(args) { throw new Error('not implemented'); }

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  main().catch((err) => {
    console.error(`[wt] ${err.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify it runs**

```bash
chmod +x scripts/wt.mjs || true
node scripts/wt.mjs --help
```

Expected: usage text, exit 0.

```bash
node scripts/wt.mjs foo
```

Expected: "[wt] unknown command: foo" + usage, exit 2.

- [ ] **Step 3: Commit**

```bash
git add scripts/wt.mjs
git commit -m "wt: CLI dispatcher scaffold (no command bodies yet)"
```

---

## Task 9: `wt new` command

**Files:**
- Modify: `scripts/wt.mjs`

- [ ] **Step 1: Implement `cmdNew`**

Replace the stub in `scripts/wt.mjs` with:

```javascript
async function cmdNew(args) {
  // Parse args: first positional = slug, optional --from <base>.
  const positional = [];
  let from = 'main';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') { from = args[++i]; }
    else positional.push(args[i]);
  }
  const rawSlug = positional[0];
  const v = validateSlug(rawSlug);
  if (!v.ok) {
    console.error(`[wt new] invalid slug: ${v.reason}`);
    process.exit(2);
  }
  const slug = v.slug;
  const branch = `feat/${slug}`;

  const repoRoot = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const wtPath = join(repoRoot, '.worktrees', slug);

  if (existsSync(wtPath)) {
    console.error(`[wt new] .worktrees/${slug}/ already exists; pick another slug or run: wt rm ${slug}`);
    process.exit(2);
  }
  const { stdout: branches } = await execa('git', ['branch', '--list', branch]);
  if (branches.trim().length > 0) {
    console.error(`[wt new] branch ${branch} already exists; pick another slug or delete the branch first`);
    process.exit(2);
  }

  // Try to fetch; warn on failure (e.g. offline).
  try { await execa('git', ['fetch', 'origin', from], { stdio: 'inherit' }); }
  catch { console.warn(`[wt new] fetch origin ${from} failed; proceeding with local ref`); }

  // Parallel-agent collision scan.
  const activityWindowMs = (Number(process.env.WT_ACTIVITY_MIN ?? 10)) * 60 * 1000;
  const now = Date.now();
  const wtList = await execa('git', ['worktree', 'list', '--porcelain']);
  const records = parseGitWorktreeList(wtList.stdout);
  const warnings = [];
  for (const rec of records) {
    if (!rec.path) continue;
    const gitAdminDir = rec.path === repoRoot
      ? join(repoRoot, '.git')
      : join(repoRoot, '.git', 'worktrees', rec.path.split(/[\\/]/).pop() ?? '');
    let headMtimeMs = 0, indexMtimeMs = 0, hasLockfile = false;
    try { headMtimeMs = (await stat(join(gitAdminDir, 'HEAD'))).mtimeMs; } catch {}
    try { indexMtimeMs = (await stat(join(gitAdminDir, 'index'))).mtimeMs; } catch {}
    try { hasLockfile = existsSync(join(gitAdminDir, 'index.lock')); } catch {}
    let dirty = false;
    try {
      const st = await execa('git', ['-C', rec.path, 'status', '--porcelain']);
      dirty = st.stdout.trim().length > 0;
    } catch {}
    const a = detectActivity({ headMtimeMs, indexMtimeMs, hasLockfile, dirty, now, windowMs: activityWindowMs });
    if (a.active) warnings.push(`  ${rec.path} (${rec.branch ?? 'detached'}): ${a.reasons.join(', ')}`);
  }
  if (warnings.length > 0) {
    console.warn(`[wt new] other worktrees show activity:\n${warnings.join('\n')}`);
    console.warn(`[wt new] proceed? (set WT_SKIP_ACTIVITY_WARN=1 to bypass; otherwise Ctrl-C to abort)`);
    if (process.env.WT_SKIP_ACTIVITY_WARN !== '1') {
      // Pause briefly so the operator can Ctrl-C.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Create the worktree.
  await execa('git', ['worktree', 'add', wtPath, '-b', branch, from], { stdio: 'inherit' });

  // Resolve the base sha for NOTES.
  const baseSha = (await execa('git', ['rev-parse', '--short', from])).stdout.trim();

  // Write NOTES.md.
  const notes = renderNotesSkeleton({ slug, baseLabel: from, baseSha });
  await writeFile(join(wtPath, 'NOTES.md'), notes, 'utf8');

  // Verify NOTES is gitignored inside the new worktree.
  try {
    await execa('git', ['-C', wtPath, 'check-ignore', '-q', 'NOTES.md']);
  } catch {
    console.error(`[wt new] WARNING: NOTES.md is NOT gitignored in ${wtPath}. Add /NOTES.md to .gitignore before committing.`);
  }

  // Auto-detect + run package-manager setup.
  const rootEntries = await readdir(wtPath);
  const pm = detectPackageManager(rootEntries);
  if (pm) {
    console.log(`[wt new] running ${pm.install} in ${wtPath}`);
    try {
      const [cmd0, ...rest] = pm.install.split(' ');
      await execa(cmd0, rest, { cwd: wtPath, stdio: 'inherit' });
    } catch (err) {
      console.warn(`[wt new] ${pm.install} failed: ${err.message}. Proceeding; run it manually.`);
    }
  }

  console.log(`\nWorktree ready at ${wtPath}`);
  console.log(`Branch: ${branch} (from ${from} @ ${baseSha})`);
  console.log(`Next: edit NOTES.md, then cd ${wtPath} and start work.`);
}
```

- [ ] **Step 2: Manual smoke test**

```bash
cd .worktrees/worktree-workflow
node scripts/wt.mjs new smoke-test --from main
# verify: .worktrees/smoke-test/ exists, branch feat/smoke-test, NOTES.md present
cd .worktrees/smoke-test && git check-ignore NOTES.md && echo ok
cd .. && git worktree remove smoke-test && git branch -D feat/smoke-test
```

- [ ] **Step 3: Commit**

```bash
git add scripts/wt.mjs
git commit -m "wt: implement wt new with parallel-agent collision detection"
```

---

## Task 10: `wt list` command

**Files:**
- Modify: `scripts/wt.mjs`

- [ ] **Step 1: Implement `cmdList`**

1. `git worktree list --porcelain` → `parseGitWorktreeList`.
2. For each non-primary entry: compute ahead/behind main (`git -C <path> rev-list --count origin/main..HEAD` and reverse), activity, staleness, NOTES.md mtime, PR state (try `gh pr view <branch> --json state --jq .state`; if `gh` missing or non-zero, PR state = "none").
3. Render a table (aligned columns). Stale candidates flagged with `[stale]` + reason.

- [ ] **Step 2: Smoke test**

```bash
node scripts/wt.mjs list
```

Expected: table with the main checkout + `worktree-workflow`, correct branch names.

- [ ] **Step 3: Commit**

---

## Task 11: `wt rm` command

**Files:**
- Modify: `scripts/wt.mjs`

- [ ] **Step 1: Implement `cmdRm`**

1. Validate slug.
2. Locate worktree at `.worktrees/<slug>/`; error if missing.
3. Check dirty / unmerged / ahead-of-main. If any present, prompt `[y/N]` default N. Read via `readline/promises`; if stdin is not a TTY, require `--force`.
4. `git worktree remove <path>`. Optional `--delete-branch`: `git branch -D feat/<slug>`.
5. Print confirmation.

- [ ] **Step 2: Smoke test**

Use the smoke-test worktree from task 9. Commit once there to make it "ahead of main." Verify prompt. Abort with N. Verify still present.

- [ ] **Step 3: Commit**

---

## Task 12: `wt clean` command

**Files:**
- Modify: `scripts/wt.mjs`

- [ ] **Step 1: Implement `cmdClean`**

1. List all worktrees. For each: compute `detectStale` using (a) local merge-base against `origin/main`, (b) optional `gh pr view`.
2. For each stale candidate, print its slug + reasons + prompt `[y/N]` default N.
3. If `--dry-run`, print what would be removed and exit without prompting.
4. On confirm: `git worktree remove` + optional branch delete.

- [ ] **Step 2: Smoke test**

Create two throwaway worktrees, merge one, run `wt clean --dry-run` and verify the merged one is flagged and the other isn't.

- [ ] **Step 3: Commit**

---

## Task 13: `wt note` command

**Files:**
- Modify: `scripts/wt.mjs`

- [ ] **Step 1: Implement `cmdNote`**

1. If slug omitted, infer from cwd (nearest `.worktrees/<slug>/` ancestor).
2. Resolve path to NOTES.md.
3. Open via `$EDITOR` (fallback: `code` if `$EDITOR` unset; else print path).

- [ ] **Step 2: Smoke test + commit**

---

## Task 14: `wt stack` command + git-spice detection

**Files:**
- Modify: `scripts/wt.mjs`

- [ ] **Step 1: Implement `cmdStack`**

1. Validate `<parent>` and `<child>` slugs.
2. Verify `gs --version` succeeds; on failure, exit with `[wt-stack] git-spice not found. Install: https://github.com/abhinav/git-spice/releases` (exit 3, distinct code).
3. `git worktree add .worktrees/<child> -b feat/<child> feat/<parent>`.
4. `cd .worktrees/<child> && gs branch create --at feat/<parent>` (or the equivalent  -  verify against `gs --help` at implementation time).
5. Write NOTES with `baseLabel = <parent>`, `baseSha = <parent-head>`.
6. Run setup + verify NOTES ignored.

- [ ] **Step 2: Smoke test**

Skip if `gs` not installed; verify the error message is the expected one. If `gs` is installed, run `wt stack smoke-parent smoke-child` against a throwaway parent and verify the stack is registered.

- [ ] **Step 3: Commit**

---

## Task 15: Portability static test

**Files:**
- Create: `test/scripts/wt.portability.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FILES = [
  resolve(HERE, '../../scripts/wt.mjs'),
  resolve(HERE, '../../scripts/lib/wt.mjs'),
];

const FORBIDDEN = [
  /from\s+['"](\.\.\/)+src\//,
  /from\s+['"](\.\.\/)+dist\//,
  /from\s+['"](\.\.\/)+\.lag\//,
  /from\s+['"][^'"]*\/dist\/adapters\//,
  /from\s+['"][^'"]*\/dist\/actors\//,
];

describe('wt CLI portability', () => {
  for (const file of FILES) {
    it(`${file} imports nothing from src/, dist/, or .lag/`, async () => {
      const body = await readFile(file, 'utf8');
      for (const pat of FORBIDDEN) {
        expect(body, `${file} has forbidden import`).not.toMatch(pat);
      }
    });
  }
});
```

- [ ] **Step 2: Run and verify pass**

```bash
npx vitest run test/scripts/wt.portability.test.ts
```

- [ ] **Step 3: Commit**

---

## Task 16: Integration round-trip test (gated)

**Files:**
- Create: `test/scripts/wt.integration.test.ts`

- [ ] **Step 1: Write the test**

Gated behind `LAG_WT_INTEGRATION=1`. Creates a throwaway repo under `os.tmpdir()`, commits one file, runs `wt new foo`, asserts worktree exists + NOTES.md present + ignored, runs `wt list`, asserts foo appears, runs `wt rm foo --force`, asserts worktree gone.

```typescript
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
```

- [ ] **Step 2: Run locally**

```bash
LAG_WT_INTEGRATION=1 npx vitest run test/scripts/wt.integration.test.ts
```

- [ ] **Step 3: Commit**

---

## Task 17: Canon atom bootstrap

**Files:**
- Create: `scripts/bootstrap-workflow-canon.mjs`
- Modify: `scripts/bootstrap-all-canon.mjs` (if the aggregation file exists; verify first)

- [ ] **Step 1: Read the reference bootstrap**

Read `scripts/bootstrap-operator-directives.mjs` and `scripts/bootstrap-dev-canon-proposals.mjs` to match the existing shape (atom schema, idempotency check, drift-detection, `LAG_OPERATOR_ID` guard).

- [ ] **Step 2: Write `scripts/bootstrap-workflow-canon.mjs`**

Content: one atom.

```javascript
// …header comment block matching existing bootstrap files…

const ATOMS = [
  {
    id: 'dev-parallel-workstreams-use-worktrees',
    content:
      'Parallel workstreams must use isolated `.worktrees/<slug>/` branched off main; '
      + 'one worktree per branch. Shared-checkout parallel work is rejected. Stacking is '
      + 'permitted for genuinely-dependent work (child branch cannot compile or pass its '
      + 'own tests without the parent merged, and interface-extraction in the parent does '
      + 'not resolve the dependency); every branch in a stack still gets its own worktree, '
      + 'and cascading rebases go through `git-spice`. Cleanup is operator-invoked via '
      + '`wt clean`; no scheduled or auto-cleanup job. Mechanics (CLI surface, NOTES.md '
      + 'schema, default thresholds) live in the worktree-workflow skill, not canon.',
    alternatives_rejected: [
      'Continue with sibling-directory worktrees per apps/console/CLAUDE.md convention',
      'Adopt sessions/<name>/ with per-session NOTES.md across repos',
      'Ban stacking entirely (too strict; genuinely-dependent work pays an avoidable tax)',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: the rule scales with actor count (every new actor wants its own '
      + 'isolated workspace) and with repo-count (if a second repo joins, the pattern '
      + 'generalizes  -  one .worktrees/ per repo). Revisit would be prompted only by a '
      + 'shift to a filesystem-transparent orchestration layer (e.g., per-actor containers) '
      + 'where the worktree abstraction moves below the line; the rule still applies, '
      + 'the mechanism changes.',
    derived_from: [
      'dev-branch-off-main-not-stacks',
      'dev-governance-before-autonomy',
      'dev-design-the-kill-switch-before-the-dial',
      'dev-canon-is-strategic-not-tactical',
      'dev-indie-floor-and-org-ceiling',
    ],
    layer: 'L3',
    confidence: 1.0,
    // `provenance.kind` must be a valid ProvenanceKind enum member:
    // 'user-directive' | 'agent-observed' | 'agent-inferred' |
    // 'llm-refined' | 'canon-promoted' | 'operator-seeded'.
    // Bootstrap-time atoms use 'operator-seeded'.
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-workflow-canon', agent_id: 'bootstrap' },
      derived_from: /* see above */ [],
    },
    // …match the field shape of existing atoms in bootstrap-dev-canon-proposals.mjs…
  },
];
```

Include the idempotent write loop pattern (read existing atom, compare shape, fail loud on drift, skip on match, write on new).

- [ ] **Step 3: Wire into `bootstrap-all-canon.mjs`**

Read `scripts/bootstrap-all-canon.mjs`; add a call to the new bootstrap in its aggregate chain, matching the existing pattern.

- [ ] **Step 4: Dry-run verify (only if `LAG_OPERATOR_ID` is set in your shell)**

```bash
cd .worktrees/worktree-workflow && npm run build --silent && node scripts/bootstrap-workflow-canon.mjs
```

Expected: atom written on first run, idempotent-skip message on subsequent runs.

**If `LAG_OPERATOR_ID` is not set:** skip this step. Do NOT auto-resolve a placeholder principal  -  writing an L3 atom under a wrong principal corrupts the provenance chain. Mark the task "verify at merge time" and let the PR reviewer confirm the atom lands correctly when the operator-id environment is available (typically in CI via the existing bootstrap pipeline).

- [ ] **Step 5: Commit**

```bash
git add scripts/bootstrap-workflow-canon.mjs scripts/bootstrap-all-canon.mjs
git commit -m "canon: parallel-workstreams-use-worktrees L3 directive"
```

---

## Task 18: Update memory `feedback_branch_off_main_not_stacks`

**Files:**
- Modify: the operator-local auto-memory entry slug `feedback_branch_off_main_not_stacks` (outside the repo; resolve the path on your machine via your memory tooling - paths are machine-specific and must not be committed).

- [ ] **Step 1: Read current memory file** (via whatever path your memory tooling reports)

- [ ] **Step 2: Revise content**

Rewrite to: "Default branch-off-main; stack deliberately when work is genuinely dependent (child cannot compile without parent). Use `wt stack` + `git-spice`; never share a checkout across parallel work. Reference: `.claude/skills/worktree-workflow/SKILL.md`. **Why:** prior stacking pain was three problems fused (shared checkout + parallel-dressed-as-stack + hand-rolled rebases), not stacking itself. **How to apply:** default path is `wt new <slug> --from main`; `wt stack` only when the codified test says so."

- [ ] **Step 3: No commit**

Memory file lives outside the repo  -  no git action. (MEMORY.md's one-line pointer stays the same title; only the body of the file changes.)

---

## Task 19: Add skill pointer to README.md

**Files:**
- Modify: `README.md` (only if a Development/Scripts/Tooling section exists; otherwise skip)

**Context:** Main `CLAUDE.md` is entirely auto-managed by LAG (the whole file is the rendered canon projection  -  there is no hand-edited region). Editing content outside the `<!-- lag:canon-start --> / <!-- lag:canon-end -->` markers would be overwritten on next canon application, and the new canon atom from Task 17 already surfaces the rule via the auto-rendered Directives section. So we don't need a pointer in `CLAUDE.md`  -  the canon atom itself IS the pointer.

- [ ] **Step 1: Check README.md for an appropriate section**

```bash
grep -nE "^##+ (Development|Scripts|Tooling|Getting started|Contributing)" README.md 2>&1 || echo "no section"
```

- [ ] **Step 2: If section found, add one line**

One-line addition under the matched section:

```markdown
- `npm run wt -- --help`  -  worktree CLI for parallel-agent isolation (see `.claude/skills/worktree-workflow/SKILL.md`).
```

- [ ] **Step 3: If no section found, skip this task**

Skills auto-discover through `.claude/skills/` registry; a README mention is a nice-to-have, not a blocker. The canon atom written in Task 17 is the authoritative pointer.

- [ ] **Step 4: Commit (if an edit was made)**

```bash
git add README.md
git commit -m "docs: README pointer to worktree-workflow skill"
```

---

## Task 20: Add npm script + README pointer

**Files:**
- Modify: `package.json`
- Modify: `README.md` (optional; only if an existing "tooling" section exists)

- [ ] **Step 1: Add npm script**

In `package.json` scripts:

```json
"wt": "node scripts/wt.mjs"
```

- [ ] **Step 2: Verify**

```bash
npm run wt -- --help
```

Expected: usage text.

- [ ] **Step 3: README pointer (conditional)**

If `README.md` has a "Development" or "Scripts" section, add one line: `npm run wt -- --help`  -  worktree CLI. Otherwise skip.

- [ ] **Step 4: Commit**

---

## Task 21: Pre-push verification + open PR

**Files:** none (shell only)

- [ ] **Step 1: Run the full test suite**

```bash
cd .worktrees/worktree-workflow && npm test
```

Expected: all tests pass, no new failures vs. main baseline.

- [ ] **Step 2: Run the pre-push grep checklist**

Per `feedback_pre_push_grep_checklist` memory:

```bash
cd .worktrees/worktree-workflow && \
  grep -rE "(Co-Authored-By|🤖 Generated|Claude Code)" --include='*.ts' --include='*.mjs' --include='*.md' --include='*.json' . 2>&1 | grep -v node_modules | grep -v '.git/' || echo "clean"
```

Expected: "clean" (no AI-attribution leaks).

Also check emdashes in committed files and private-term leaks per the CI package-hygiene rule.

- [ ] **Step 3: Verify portability test**

```bash
npx vitest run test/scripts/wt.portability.test.ts
```

Expected: pass.

- [ ] **Step 4: Verify `gh-as` is available + push via bot identity**

```bash
node scripts/git-as.mjs lag-ceo push -u origin feat/worktree-workflow
```

Expected: push succeeds, attributed to `lag-ceo[bot]`, not operator.

- [ ] **Step 5: Open PR via `gh-as`**

```bash
node scripts/gh-as.mjs lag-ceo pr create \
  --title "feat: worktree-first parallel workflow + wt CLI + canon" \
  --body "$(cat <<'EOF'
Ships the `.worktrees/<slug>/` + NOTES.md + `wt` CLI + skill + canon atom from the design at docs/superpowers/specs/2026-04-21-worktree-workflow-design.md.

## Scope
- New skill .claude/skills/worktree-workflow/SKILL.md
- New CLI scripts/wt.mjs (dispatcher) + scripts/lib/wt.mjs (pure helpers)
- Unit + portability + (gated) integration tests
- One L3 canon atom dev-parallel-workstreams-use-worktrees
- Memory update for feedback_branch_off_main_not_stacks
- CLAUDE.md pointer; npm run wt script

## Explicitly out of scope
- No migration of `../memory-governance-apps` / `../memory-governance-substrate` (separate PR after in-flight agents finish).
- No edit to apps/console/CLAUDE.md:43 (stays consistent with reality until migration).
- No Stop-hook for NOTES.md (phase 2).

## Test plan
- [ ] npm test passes
- [ ] Portability test passes (wt imports nothing from src/, dist/, .lag/)
- [ ] LAG_WT_INTEGRATION=1 npm test passes the round-trip
- [ ] Manual smoke: wt new smoke --from main, wt list shows it, wt rm smoke --delete-branch cleans up
EOF
)"
```

- [ ] **Step 6: Verify PR state**

```bash
gh pr view --json url,mergeable,mergeStateStatus,reviewDecision
```

Watch for CodeRabbit verdict. Address CR feedback per the `feedback_detailed_coderabbit_replies` memory (inline replies with rationale before resolving).

---

## Post-merge follow-ups (not in this plan)

1. **Migration PR**  -  `git worktree move` the sibling worktrees into `.worktrees/`, update `apps/console/CLAUDE.md:43`, run one pass of `wt list --stale` + `wt clean` on the 30+ stale branches. Ships as its own plan.
2. **Tier-3 upstream contribution**  -  PR `worktree-workflow` skill + CLI as an enhancement to `superpowers:using-git-worktrees`. Optional, owner-decision.
3. **Phase-2 NOTES.md freshness warning**  -  if operators report NOTES drift, add an opt-in Stop-hook that warns (never acts) when NOTES is >2h stale.
