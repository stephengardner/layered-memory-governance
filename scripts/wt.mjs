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
async function cmdList(args) { throw new Error('not implemented'); }
async function cmdRm(args) { throw new Error('not implemented'); }
async function cmdClean(args) { throw new Error('not implemented'); }
async function cmdStack(args) { throw new Error('not implemented'); }
async function cmdNote(args) { throw new Error('not implemented'); }

await main().catch((err) => {
  console.error(`[wt] ${err.message}`);
  process.exit(1);
});
