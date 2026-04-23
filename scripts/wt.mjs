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
async function cmdList(args) {
  const repoRoot = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const wtList = await execa('git', ['worktree', 'list', '--porcelain']);
  const records = parseGitWorktreeList(wtList.stdout);

  const staleDays = Number(process.env.WT_STALE_DAYS ?? 14);
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const activityWindowMs = (Number(process.env.WT_ACTIVITY_MIN ?? 10)) * 60 * 1000;
  const now = Date.now();

  const rows = [];
  for (const rec of records) {
    if (!rec.path) continue;
    const isPrimary = rec.path === repoRoot;
    const slug = isPrimary ? '(main)' : rec.path.split(/[\\/]/).pop() ?? rec.path;
    const branch = rec.branch ?? (rec.detached ? '(detached)' : '?');

    // Ahead/behind main.
    let ahead = 0, behind = 0;
    if (!isPrimary) {
      try {
        ahead = Number((await execa('git', ['-C', rec.path, 'rev-list', '--count', 'origin/main..HEAD'])).stdout.trim()) || 0;
        behind = Number((await execa('git', ['-C', rec.path, 'rev-list', '--count', 'HEAD..origin/main'])).stdout.trim()) || 0;
      } catch { /* offline or no origin/main - leave 0 */ }
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

    // Branch merged check.
    let branchMerged = false;
    if (!isPrimary && branch && branch !== '(detached)') {
      try {
        const merged = await execa('git', ['branch', '--merged', 'origin/main', '--list', branch]);
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

  // Check dirty.
  let dirty = false;
  try {
    const st = await execa('git', ['-C', wtPath, 'status', '--porcelain']);
    dirty = st.stdout.trim().length > 0;
  } catch {}

  // Check ahead of main.
  let aheadCount = 0;
  try {
    aheadCount = Number((await execa('git', ['-C', wtPath, 'rev-list', '--count', 'origin/main..HEAD'])).stdout.trim()) || 0;
  } catch {}

  // Check unmerged (local branch merged into origin/main?).
  const branch = `feat/${slug}`;
  let branchMerged = false;
  try {
    const m = await execa('git', ['branch', '--merged', 'origin/main', '--list', branch]);
    branchMerged = m.stdout.trim().length > 0;
  } catch {}
  const hasUnmerged = aheadCount > 0 && !branchMerged;

  const concerns = [];
  if (dirty) concerns.push(`dirty working tree`);
  if (hasUnmerged) concerns.push(`${aheadCount} commit(s) ahead of origin/main and not merged`);

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
  const dryRun = args.includes('--dry-run');

  const repoRoot = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
  const wtList = await execa('git', ['worktree', 'list', '--porcelain']);
  const records = parseGitWorktreeList(wtList.stdout);

  const staleDays = Number(process.env.WT_STALE_DAYS ?? 14);
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const candidates = [];
  for (const rec of records) {
    if (!rec.path) continue;
    if (rec.path === repoRoot) continue; // skip primary

    const slug = rec.path.split(/[\\/]/).pop() ?? rec.path;
    const branch = rec.branch ?? '';

    // Last commit time.
    let lastCommitMs = now;
    try {
      const ts = (await execa('git', ['-C', rec.path, 'log', '-1', '--format=%ct'])).stdout.trim();
      if (ts) lastCommitMs = Number(ts) * 1000;
    } catch {}

    // NOTES.md mtime - use merge-base mtime as proxy if NOTES absent.
    let notesMtimeMs = lastCommitMs;
    try { notesMtimeMs = (await stat(join(rec.path, 'NOTES.md'))).mtimeMs; } catch {}

    // Branch merged check against local merge-base vs origin/main.
    let branchMerged = false;
    if (branch) {
      try {
        const m = await execa('git', ['branch', '--merged', 'origin/main', '--list', branch]);
        branchMerged = m.stdout.trim().length > 0;
      } catch {}
    }

    // PR state via gh (graceful fallback).
    let prClosed = false;
    if (branch) {
      try {
        const res = await execa('gh', ['pr', 'view', branch, '--json', 'state', '--jq', '.state']);
        const state = res.stdout.trim();
        prClosed = state === 'CLOSED';
      } catch { /* gh unavailable or no PR */ }
    }

    const stale = detectStale({ lastCommitMs, notesMtimeMs, branchMerged, prClosed, now, thresholdMs });
    if (stale.stale) {
      candidates.push({ slug, branch, path: rec.path, reasons: stale.reasons });
    }
  }

  if (candidates.length === 0) {
    console.log('[wt clean] no stale worktrees found.');
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
    if (!isTTY) {
      console.log(`  skipped (non-TTY; use --dry-run to inspect or wt rm ${c.slug} --force)`);
      continue;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`  Remove ${c.slug}? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log(`  skipped.`);
      continue;
    }
    try {
      await execa('git', ['worktree', 'remove', c.path, '--force'], { stdio: 'inherit' });
      console.log(`  removed .worktrees/${c.slug}/`);
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
  // TODO: verify exact gs subcommand against `gs --help` at gs-install time.
  // `gs branch track --base <parent>` is the idiomatic way to declare a base in git-spice
  // (see https://abhinav.github.io/git-spice/cli/branch/track/). An alternative is
  // `gs branch create` which creates AND tracks. Since the branch already exists via
  // git worktree add, `gs branch track --base <parentBranch>` is the correct call.
  // Leaving the TODO marker so the first operator with gs installed can confirm.
  await execa('gs', ['-C', childPath, 'branch', 'track', '--base', parentBranch], { stdio: 'inherit' });

  // Resolve parent HEAD for NOTES.
  const parentSha = (await execa('git', ['-C', parentPath, 'rev-parse', '--short', 'HEAD'])).stdout.trim();

  // Write NOTES.md.
  const notes = renderNotesSkeleton({ slug: child, baseLabel: parent, baseSha: parentSha });
  await writeFile(join(childPath, 'NOTES.md'), notes, 'utf8');

  // Verify NOTES is gitignored inside the new worktree.
  try {
    await execa('git', ['-C', childPath, 'check-ignore', '-q', 'NOTES.md']);
  } catch {
    console.error(`[wt stack] WARNING: NOTES.md is NOT gitignored in ${childPath}. Add /NOTES.md to .gitignore.`);
  }

  // Auto-detect + run package-manager setup.
  const rootEntries = await readdir(childPath);
  const pm = detectPackageManager(rootEntries);
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

  const editor = process.env.EDITOR;
  if (editor) {
    await execa(editor, [notesPath], { stdio: 'inherit' });
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
