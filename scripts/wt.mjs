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
 * Zero imports from src/, dist/, or .lag/ - enforced by
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
  prStateToStaleSignals,
  findWorktreeBySlug,
  parseCleanFlags,
} from './lib/wt.mjs';

const COMMANDS = ['new', 'list', 'rm', 'clean', 'stack', 'note'];

function parsePositiveNumber(raw, fallback) {
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

/**
 * Resolve the trunk ref used for ahead/behind, merge-check, and
 * stale-PR comparisons. Teams with `origin/master`, `origin/trunk`,
 * `origin/develop`, or a non-`origin` remote (fork workflow,
 * `upstream/main`) set `WT_TRUNK_REF` to override. Defaults to
 * `origin/main` for backward compat.
 */
function trunkRef() {
  const raw = process.env.WT_TRUNK_REF;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return 'origin/main';
}

/**
 * Parse an $EDITOR string that may contain arguments, e.g.
 * `code --wait`, `nvim -u NONE`, `emacsclient -n`. Returns
 * `{ bin, args }` or null when the string is empty/whitespace.
 *
 * Simple whitespace split is sufficient for the vast majority of
 * operator-configured editors; the pathological case of an editor
 * whose executable path contains a literal space needs a quoted
 * EDITOR ("/path/with space/editor" arg1) which we handle by
 * respecting balanced double quotes.
 */
function parseEditorCommand(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parts = [];
  let buf = '';
  let inQuote = false;
  for (const ch of trimmed) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (buf.length > 0) { parts.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) parts.push(buf);
  if (parts.length === 0) return null;
  return { bin: parts[0], args: parts.slice(1) };
}

/**
 * Read package.json (if present at the root) and return its raw
 * contents as a string. The caller forwards this to
 * `detectPackageManager` so the Corepack `packageManager` field can
 * be honored. Returns undefined on any error (missing, unreadable)
 * so the detector can still apply its other priorities.
 */
async function readPackageJsonIfAny(rootPath) {
  try {
    return await readFile(join(rootPath, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
}

function usage() {
  console.log(`Usage: wt <command> [args]

Commands:
  new <slug> [--from <base>]     Create worktree + branch off main (or parent).
  list                            Show all worktrees with state + stale flags.
  rm <slug>                       Remove worktree (confirms if dirty or unmerged).
  clean [--dry-run] [--yes|-y]    Prompt to remove merged/abandoned worktrees.
                                  Worktrees showing activity (recent HEAD,
                                  dirty tree, index.lock) are skipped.
                                  --yes removes all non-skipped candidates
                                  without prompting (bulk cleanup).
  stack <parent> <child>          Create child stacked on parent via git-spice.
  note [<slug>]                   Open NOTES.md in $EDITOR (supports args).

Env:
  WT_ACTIVITY_MIN   Activity-window minutes (default 10).
  WT_STALE_DAYS     Stale-threshold days (default 14).
  WT_TRUNK_REF      Trunk ref for ahead/behind and merge checks
                    (default origin/main; set to origin/master,
                    upstream/main, etc. for non-default trunks).`);
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

async function cmdNew(args) {
  // Parse args: first positional = slug, optional --from <base>.
  const positional = [];
  let from = 'main';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') {
      if (i + 1 >= args.length) {
        console.error('[wt new] --from requires a value');
        process.exit(2);
      }
      const nextVal = args[++i];
      // Guard against `--from` followed by a flag-looking or empty
      // value (e.g. `wt new foo --from $EMPTY_VAR`). Without this
      // the failure surfaced later at `git fetch origin undefined`.
      if (typeof nextVal !== 'string' || nextVal.trim().length === 0 || nextVal.startsWith('--')) {
        console.error(`[wt new] --from requires a non-empty ref (got ${JSON.stringify(nextVal ?? '')})`);
        process.exit(2);
      }
      from = nextVal.trim();
    } else positional.push(args[i]);
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
  const activityWindowMs = parsePositiveNumber(process.env.WT_ACTIVITY_MIN, 10) * 60 * 1000;
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

  // Verify NOTES is gitignored inside the new worktree. A warning
  // here would scroll past in busy CI logs; the skill promises the
  // operator that `wt new` refuses to proceed, and "kill-switch
  // before autonomy" favors the strict option: exit loud, let the
  // operator add `/NOTES.md` to `.gitignore` before retrying.
  try {
    await execa('git', ['-C', wtPath, 'check-ignore', '-q', 'NOTES.md']);
  } catch {
    console.error(
      `[wt new] ERROR: NOTES.md is NOT gitignored in ${wtPath}.\n`
      + `  Add "/NOTES.md" to .gitignore in the parent repo (or its ancestor) so\n`
      + `  per-worktree handoff notes never land in a commit by accident. After\n`
      + `  fixing the gitignore, remove the worktree (wt rm ${slug} --force) and\n`
      + `  run wt new again.`,
    );
    process.exit(2);
  }

  // Auto-detect + run package-manager setup. Passing the raw
  // package.json content lets the detector honor Corepack's
  // `packageManager` field and avoid clobbering pnpm/yarn/bun
  // lockfiles with a bare `npm install`.
  const rootEntries = await readdir(wtPath);
  const packageJsonContent = await readPackageJsonIfAny(wtPath);
  const pm = detectPackageManager(rootEntries, packageJsonContent);
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
async function cmdList(args) {
  const repoRoot = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const wtList = await execa('git', ['worktree', 'list', '--porcelain']);
  const records = parseGitWorktreeList(wtList.stdout);

  const staleDays = parsePositiveNumber(process.env.WT_STALE_DAYS, 14);
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const activityWindowMs = parsePositiveNumber(process.env.WT_ACTIVITY_MIN, 10) * 60 * 1000;
  const now = Date.now();

  const rows = [];
  for (const rec of records) {
    if (!rec.path) continue;
    const isPrimary = rec.path === repoRoot;
    const slug = isPrimary ? '(main)' : rec.path.split(/[\\/]/).pop() ?? rec.path;
    const branch = rec.branch ?? (rec.detached ? '(detached)' : '?');

    // Ahead/behind trunk (WT_TRUNK_REF, default origin/main).
    let ahead = 0, behind = 0;
    if (!isPrimary) {
      try {
        const trunk = trunkRef();
        ahead = Number((await execa('git', ['-C', rec.path, 'rev-list', '--count', `${trunk}..HEAD`])).stdout.trim()) || 0;
        behind = Number((await execa('git', ['-C', rec.path, 'rev-list', '--count', `HEAD..${trunk}`])).stdout.trim()) || 0;
      } catch { /* offline or no trunk ref - leave 0 */ }
    }

    // NOTES.md mtime.
    let notesMtimeMs = 0;
    try { notesMtimeMs = (await stat(join(rec.path, 'NOTES.md'))).mtimeMs; } catch {}

    // Activity.
    const gitAdminDir = isPrimary
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
    const activity = detectActivity({ headMtimeMs, indexMtimeMs, hasLockfile, dirty, now, windowMs: activityWindowMs });

    // Last commit time.
    let lastCommitMs = 0;
    try {
      const ts = (await execa('git', ['-C', rec.path, 'log', '-1', '--format=%ct'])).stdout.trim();
      if (ts) lastCommitMs = Number(ts) * 1000;
    } catch {}

    // PR state via gh (graceful fallback).
    let prState = 'none';
    if (!isPrimary && branch && branch !== '(detached)') {
      try {
        const res = await execa('gh', ['pr', 'view', branch, '--json', 'state', '--jq', '.state']);
        prState = res.stdout.trim() || 'none';
      } catch { prState = 'none'; }
    }

    // Branch merged check against the configured trunk ref.
    let branchMerged = false;
    if (!isPrimary && branch && branch !== '(detached)') {
      try {
        const merged = await execa('git', ['branch', '--merged', trunkRef(), '--list', branch]);
        branchMerged = merged.stdout.trim().length > 0;
      } catch {}
    }

    const stale = isPrimary ? { stale: false, reasons: [] } : detectStale({
      lastCommitMs: lastCommitMs || now,
      notesMtimeMs: notesMtimeMs || now,
      branchMerged,
      prClosed: prState === 'CLOSED',
      now,
      thresholdMs,
    });

    rows.push({ slug, branch, ahead, behind, active: activity.active, stale: stale.stale, staleReasons: stale.reasons, prState, isPrimary });
  }

  // Render aligned table.
  const cols = ['SLUG', 'BRANCH', 'AHEAD', 'BEHIND', 'ACTIVE', 'PR', 'FLAGS'];
  const data = rows.map(r => [
    r.slug,
    r.branch,
    String(r.ahead),
    String(r.behind),
    r.active ? 'yes' : 'no',
    r.prState,
    r.stale ? `[stale] ${r.staleReasons.join(', ')}` : '',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map(row => row[i].length)));
  const fmt = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(fmt(cols));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of data) console.log(fmt(row));
}
async function cmdRm(args) {
  const positional = [];
  let force = false;
  let deleteBranch = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force' || args[i] === '-f') force = true;
    else if (args[i] === '--delete-branch') deleteBranch = true;
    else positional.push(args[i]);
  }

  const rawSlug = positional[0];
  const v = validateSlug(rawSlug);
  if (!v.ok) {
    console.error(`[wt rm] invalid slug: ${v.reason}`);
    process.exit(2);
  }
  const slug = v.slug;

  const repoRoot = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const wtPath = join(repoRoot, '.worktrees', slug);

  if (!existsSync(wtPath)) {
    console.error(`[wt rm] .worktrees/${slug}/ not found`);
    process.exit(2);
  }

  // Resolve the actual branch checked out in this worktree. The old
  // `feat/${slug}` assumption silently failed for every non-feat branch
  // (substrate/*, fix/*, docs/*, chore/*, spec/*, task-*, code-author/*,
  // etc.); all three live-dogfood removals on 2026-04-24 hit this.
  //
  // Match is done via findWorktreeBySlug (basename comparison) instead
  // of raw path equality because `git worktree list --porcelain` emits
  // forward slashes on Windows while `path.join` emits backslashes; a
  // naive `r.path === wtPath` comparison never matched cross-platform.
  let branch = `feat/${slug}`;
  try {
    const wtList = await execa('git', ['worktree', 'list', '--porcelain']);
    const records = parseGitWorktreeList(wtList.stdout);
    const rec = findWorktreeBySlug(records, slug);
    if (rec?.branch) branch = rec.branch;
  } catch { /* fall back to feat/<slug> */ }

  // Check dirty.
  let dirty = false;
  try {
    const st = await execa('git', ['-C', wtPath, 'status', '--porcelain']);
    dirty = st.stdout.trim().length > 0;
  } catch {}

  // Check ahead of the configured trunk.
  const trunk = trunkRef();
  let aheadCount = 0;
  try {
    aheadCount = Number((await execa('git', ['-C', wtPath, 'rev-list', '--count', `${trunk}..HEAD`])).stdout.trim()) || 0;
  } catch {}

  // Check unmerged (local branch merged into trunk? - ancestry check
  // only; squash-merged branches return false here, which is fine for
  // `wt rm`'s safety prompt: the operator still sees the ahead-count
  // warning and chooses).
  let branchMerged = false;
  try {
    const m = await execa('git', ['branch', '--merged', trunk, '--list', branch]);
    branchMerged = m.stdout.trim().length > 0;
  } catch {}
  const hasUnmerged = aheadCount > 0 && !branchMerged;

  const concerns = [];
  if (dirty) concerns.push(`dirty working tree`);
  if (hasUnmerged) concerns.push(`${aheadCount} commit(s) ahead of ${trunk} and not merged`);

  if (concerns.length > 0 && !force) {
    const isTTY = process.stdin.isTTY;
    if (!isTTY) {
      console.error(`[wt rm] ${slug} has concerns (${concerns.join('; ')}). Pass --force to remove non-interactively.`);
      process.exit(2);
    }
    console.warn(`[wt rm] ${slug} has concerns:`);
    for (const c of concerns) console.warn(`  - ${c}`);
    const { createInterface } = await import('readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Remove anyway? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('[wt rm] aborted.');
      process.exit(0);
    }
  }

  await execa('git', ['worktree', 'remove', wtPath, '--force'], { stdio: 'inherit' });
  console.log(`[wt rm] removed .worktrees/${slug}/`);
  try { await execa('git', ['worktree', 'prune']); } catch { /* non-fatal */ }

  if (deleteBranch) {
    try {
      await execa('git', ['branch', '-D', branch]);
      console.log(`[wt rm] deleted branch ${branch}`);
    } catch (err) {
      console.warn(`[wt rm] could not delete branch ${branch}: ${err.message}`);
    }
  }
}
async function cmdClean(args) {
  const { dryRun, yes } = parseCleanFlags(args);

  const repoRoot = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const wtList = await execa('git', ['worktree', 'list', '--porcelain']);
  const records = parseGitWorktreeList(wtList.stdout);

  const staleDays = parsePositiveNumber(process.env.WT_STALE_DAYS, 14);
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const activityWindowMs = parsePositiveNumber(process.env.WT_ACTIVITY_MIN, 10) * 60 * 1000;
  const now = Date.now();

  const candidates = [];
  const skippedActive = [];
  for (const rec of records) {
    if (!rec.path) continue;
    if (rec.path === repoRoot) continue; // skip primary

    const slug = rec.path.split(/[\\/]/).pop() ?? rec.path;
    const branch = rec.branch ?? '';

    // Activity gate (CR #128 Critical). `wt clean` prompts before
    // `git worktree remove --force`, which bypasses git's own
    // dirty-tree protection. An agent can be mid-edit right now
    // while the last commit is >thresholdMs old, and a single
    // muscle-memory `y` would wipe their work. Gate any
    // remove-candidate on detectActivity: if the worktree shows
    // recent HEAD motion, a fresh index mtime, a lockfile, or a
    // dirty tree, skip it entirely and tell the operator why.
    const gitAdminDir = join(repoRoot, '.git', 'worktrees', slug);
    let headMtimeMs = 0, indexMtimeMs = 0, hasLockfile = false;
    try { headMtimeMs = (await stat(join(gitAdminDir, 'HEAD'))).mtimeMs; } catch {}
    try { indexMtimeMs = (await stat(join(gitAdminDir, 'index'))).mtimeMs; } catch {}
    try { hasLockfile = existsSync(join(gitAdminDir, 'index.lock')); } catch {}
    let dirty = false;
    try {
      const st = await execa('git', ['-C', rec.path, 'status', '--porcelain']);
      dirty = st.stdout.trim().length > 0;
    } catch {}
    const activity = detectActivity({
      headMtimeMs, indexMtimeMs, hasLockfile, dirty, now, windowMs: activityWindowMs,
    });
    if (activity.active) {
      skippedActive.push({ slug, reasons: activity.reasons });
      continue;
    }

    // Last commit time.
    let lastCommitMs = now;
    try {
      const ts = (await execa('git', ['-C', rec.path, 'log', '-1', '--format=%ct'])).stdout.trim();
      if (ts) lastCommitMs = Number(ts) * 1000;
    } catch {}

    // NOTES.md mtime - use merge-base mtime as proxy if NOTES absent.
    let notesMtimeMs = lastCommitMs;
    try { notesMtimeMs = (await stat(join(rec.path, 'NOTES.md'))).mtimeMs; } catch {}

    // Branch merged check against the configured trunk ref.
    let branchMerged = false;
    if (branch) {
      try {
        const m = await execa('git', ['branch', '--merged', trunkRef(), '--list', branch]);
        branchMerged = m.stdout.trim().length > 0;
      } catch {}
    }

    // PR state via gh (graceful fallback). `git branch --merged` uses
    // ancestry, which squash-merge and rebase-merge invalidate: the
    // trunk-side commit has no relationship to the branch tip, so
    // `--merged` returns false for every squash-merged branch. Using
    // PR state as an authoritative merge signal (MERGED => branchMerged,
    // CLOSED => prClosed) closes the blindspot that left 20+
    // squash-merged worktrees slipping through `wt clean` post-#128.
    let prClosed = false;
    if (branch) {
      try {
        const res = await execa('gh', ['pr', 'view', branch, '--json', 'state', '--jq', '.state']);
        const signals = prStateToStaleSignals(res.stdout);
        if (signals.branchMerged) branchMerged = true;
        if (signals.prClosed) prClosed = true;
      } catch { /* gh unavailable or no PR */ }
    }

    const stale = detectStale({ lastCommitMs, notesMtimeMs, branchMerged, prClosed, now, thresholdMs });
    if (stale.stale) {
      candidates.push({ slug, branch, path: rec.path, reasons: stale.reasons });
    }
  }

  if (skippedActive.length > 0) {
    console.log('[wt clean] skipping active worktrees (never offer to remove mid-work):');
    for (const s of skippedActive) {
      console.log(`  ${s.slug}  (${s.reasons.join(', ')})`);
    }
  }

  if (candidates.length === 0) {
    if (skippedActive.length === 0) console.log('[wt clean] no stale worktrees found.');
    else console.log('[wt clean] no stale worktrees offered (all candidates skipped above for activity).');
    return;
  }

  if (dryRun) {
    console.log('[wt clean] dry-run - would remove:');
    for (const c of candidates) {
      console.log(`  ${c.slug}  (${c.reasons.join(', ')})`);
    }
    return;
  }

  const isTTY = process.stdin.isTTY;
  const { createInterface } = await import('readline/promises');

  for (const c of candidates) {
    console.log(`\n[wt clean] ${c.slug}: ${c.reasons.join(', ')}`);
    if (!yes) {
      if (!isTTY) {
        console.log(`  skipped (non-TTY; use --dry-run to inspect, --yes for bulk, or wt rm ${c.slug} --force)`);
        continue;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`  Remove ${c.slug}? [y/N] `);
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log(`  skipped.`);
        continue;
      }
    }
    try {
      await execa('git', ['worktree', 'remove', c.path, '--force'], { stdio: 'inherit' });
      console.log(`  removed .worktrees/${c.slug}/`);
      try { await execa('git', ['worktree', 'prune']); } catch { /* non-fatal */ }
    } catch (err) {
      console.warn(`  failed to remove ${c.slug}: ${err.message}`);
    }
  }
}
async function cmdStack(args) {
  const positional = args.filter(a => !a.startsWith('-'));
  const parentRaw = positional[0];
  const childRaw = positional[1];

  if (!parentRaw || !childRaw) {
    console.error('[wt stack] usage: wt stack <parent> <child>');
    process.exit(2);
  }

  const vp = validateSlug(parentRaw);
  if (!vp.ok) { console.error(`[wt stack] invalid parent slug: ${vp.reason}`); process.exit(2); }
  const vc = validateSlug(childRaw);
  if (!vc.ok) { console.error(`[wt stack] invalid child slug: ${vc.reason}`); process.exit(2); }
  const parent = vp.slug;
  const child = vc.slug;

  // gs is required - never fall back to raw rebase.
  try {
    await execa('gs', ['--version']);
  } catch {
    process.stderr.write('[wt-stack] git-spice not found. Install: https://github.com/abhinav/git-spice/releases\n');
    process.exit(3);
  }

  const repoRoot = await resolveMainRoot();
  const parentPath = join(repoRoot, '.worktrees', parent);
  const childPath = join(repoRoot, '.worktrees', child);

  if (!existsSync(parentPath)) {
    console.error(`[wt stack] parent worktree .worktrees/${parent}/ not found; run: wt new ${parent}`);
    process.exit(2);
  }
  if (existsSync(childPath)) {
    console.error(`[wt stack] .worktrees/${child}/ already exists`);
    process.exit(2);
  }

  const parentBranch = `feat/${parent}`;
  const childBranch = `feat/${child}`;

  // Create the child worktree off the parent branch.
  await execa('git', ['worktree', 'add', childPath, '-b', childBranch, parentBranch], { stdio: 'inherit' });

  // Register the stack with git-spice.
  // `gs branch track --base <parent>` is the idiomatic way to declare a base in git-spice
  // (see https://abhinav.github.io/git-spice/cli/branch/track/). Since the branch already exists
  // via git worktree add, tracking with an explicit base is the correct call.
  await execa('gs', ['-C', childPath, 'branch', 'track', '--base', parentBranch], { stdio: 'inherit' });

  // Resolve parent HEAD for NOTES.
  const parentSha = (await execa('git', ['-C', parentPath, 'rev-parse', '--short', 'HEAD'])).stdout.trim();

  // Write NOTES.md.
  const notes = renderNotesSkeleton({ slug: child, baseLabel: parent, baseSha: parentSha });
  await writeFile(join(childPath, 'NOTES.md'), notes, 'utf8');

  // Verify NOTES is gitignored inside the new worktree. Same
  // strict contract as cmdNew: exit loud rather than warn-and-continue
  // so NOTES.md never lands in a commit by accident.
  try {
    await execa('git', ['-C', childPath, 'check-ignore', '-q', 'NOTES.md']);
  } catch {
    console.error(
      `[wt stack] ERROR: NOTES.md is NOT gitignored in ${childPath}.\n`
      + `  Add "/NOTES.md" to .gitignore in the parent repo (or its ancestor).\n`
      + `  After fixing the gitignore, remove the stacked worktree\n`
      + `  (wt rm ${child} --force) and re-run wt stack.`,
    );
    process.exit(2);
  }

  // Auto-detect + run package-manager setup (lockfile / packageManager-aware).
  const rootEntries = await readdir(childPath);
  const packageJsonContent = await readPackageJsonIfAny(childPath);
  const pm = detectPackageManager(rootEntries, packageJsonContent);
  if (pm) {
    console.log(`[wt stack] running ${pm.install} in ${childPath}`);
    try {
      const [cmd0, ...rest] = pm.install.split(' ');
      await execa(cmd0, rest, { cwd: childPath, stdio: 'inherit' });
    } catch (err) {
      console.warn(`[wt stack] ${pm.install} failed: ${err.message}. Proceeding; run it manually.`);
    }
  }

  console.log(`\nStack worktree ready at ${childPath}`);
  console.log(`Branch: ${childBranch} (stacked on ${parentBranch} @ ${parentSha})`);
  console.log(`Next: edit NOTES.md, then cd ${childPath} and start work.`);
}
/** Resolve the main (primary) worktree root regardless of which worktree is cwd. */
async function resolveMainRoot() {
  // git worktree list --porcelain always lists the primary first.
  const out = (await execa('git', ['worktree', 'list', '--porcelain'])).stdout;
  const records = parseGitWorktreeList(out);
  return records[0]?.path ?? (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
}

async function cmdNote(args) {
  const positional = args.filter(a => !a.startsWith('-'));
  let slug = positional[0];

  const repoRoot = await resolveMainRoot();

  if (!slug) {
    // Infer slug from cwd - walk up until we find a .worktrees/<slug>/ ancestor.
    const cwd = process.cwd();
    const wtBase = join(repoRoot, '.worktrees');
    // Normalize both to use forward slashes for comparison.
    const cwdNorm = cwd.replace(/\\/g, '/');
    const wtBaseNorm = wtBase.replace(/\\/g, '/');
    if (cwdNorm.startsWith(wtBaseNorm + '/')) {
      const rest = cwdNorm.slice(wtBaseNorm.length + 1);
      slug = rest.split('/')[0];
    }
    if (!slug) {
      console.error('[wt note] could not infer slug from cwd; pass a slug explicitly');
      process.exit(2);
    }
  } else {
    const v = validateSlug(slug);
    if (!v.ok) {
      console.error(`[wt note] invalid slug: ${v.reason}`);
      process.exit(2);
    }
    slug = v.slug;
  }

  const wtPath = join(repoRoot, '.worktrees', slug);
  if (!existsSync(wtPath)) {
    console.error(`[wt note] .worktrees/${slug}/ not found`);
    process.exit(2);
  }

  const notesPath = join(wtPath, 'NOTES.md');

  // $EDITOR commonly contains arguments (`code --wait`, `nvim -u NONE`,
  // `emacsclient -n`). execa with a single binary name treats the
  // whole string as the executable and hits ENOENT. Parse the string
  // into bin + args so the canonical operator setups work.
  const parsed = parseEditorCommand(process.env.EDITOR);
  if (parsed !== null) {
    await execa(parsed.bin, [...parsed.args, notesPath], { stdio: 'inherit' });
  } else {
    // Try 'code' as fallback.
    try {
      await execa('code', [notesPath], { stdio: 'inherit' });
    } catch {
      console.log(notesPath);
    }
  }
}

await main().catch((err) => {
  console.error(`[wt] ${err.message}`);
  process.exit(1);
});
