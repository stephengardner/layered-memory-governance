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

async function cmdNew(args) { throw new Error('not implemented'); }
async function cmdList(args) { throw new Error('not implemented'); }
async function cmdRm(args) { throw new Error('not implemented'); }
async function cmdClean(args) { throw new Error('not implemented'); }
async function cmdStack(args) { throw new Error('not implemented'); }
async function cmdNote(args) { throw new Error('not implemented'); }

await main().catch((err) => {
  console.error(`[wt] ${err.message}`);
  process.exit(1);
});
