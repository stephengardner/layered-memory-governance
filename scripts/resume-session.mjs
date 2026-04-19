#!/usr/bin/env node
/**
 * Resume-session helper.
 *
 * Claude Code stores session jsonls at
 *   ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl
 * where `<sanitized-cwd>` is the cwd at session start, with `/` and
 * `\` replaced by `-` and the drive prefix doubled.
 *
 * `claude --resume <id>` only finds sessions in the project dir
 * matching the current cwd. So if you want to resume a session that
 * was originally started from a different directory, this helper
 * copies the jsonl into the current project's dir first.
 *
 * Usage:
 *   node scripts/resume-session.mjs <session-id>
 *   node scripts/resume-session.mjs <session-id> --from-cwd <path>
 *   node scripts/resume-session.mjs --list
 *
 * --from-cwd defaults to C:\Users\opens\phx (the common case for
 * migrating a phx-started session into memory-governance). Override
 * for other source directories.
 *
 * After running, launch via:
 *   npm run terminal -- --resume-session <id>
 *   npm run terminal:auto -- --resume-session <id>
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

function sanitizeCwd(cwd) {
  // Claude Code replaces every `:`, `\`, and `/` with `-`. The Windows
  // drive-letter therefore produces a double-dash: `C:\Users\...`
  // becomes `C--Users-...` (colon -> `-`, backslash -> `-`, adjacent).
  return cwd.replace(/[:\\/]/g, '-');
}

async function listProjects() {
  try {
    const entries = await readdir(PROJECTS_ROOT);
    return entries.filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
}

async function findSession(sessionId) {
  const projects = await listProjects();
  for (const p of projects) {
    const file = join(PROJECTS_ROOT, p, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      const s = await stat(file);
      return { projectDir: p, file, size: s.size, mtime: s.mtimeMs };
    }
  }
  return null;
}

async function listHelper() {
  const projects = await listProjects();
  for (const p of projects) {
    const dir = join(PROJECTS_ROOT, p);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    const sessions = files.filter((f) => f.endsWith('.jsonl'));
    if (sessions.length === 0) continue;
    console.log(`\n${p}:`);
    for (const f of sessions) {
      let mtime = '';
      try {
        const s = await stat(join(dir, f));
        mtime = new Date(s.mtimeMs).toISOString();
      } catch { /* ignore */ }
      console.log(`  ${f.replace(/\.jsonl$/, '')}  (mtime ${mtime})`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(`Usage:
  node scripts/resume-session.mjs <session-id>                    copy session into current project
  node scripts/resume-session.mjs <session-id> --from-cwd <path>  override source (default: phx)
  node scripts/resume-session.mjs --list                          list all sessions in ~/.claude/projects`);
    process.exit(0);
  }

  if (argv[0] === '--list') {
    await listHelper();
    return;
  }

  const sessionId = argv[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    console.error(`Expected a session UUID (8-4-4-4-12 hex), got: ${sessionId}`);
    process.exit(1);
  }

  const current = sanitizeCwd(REPO_ROOT);
  const targetDir = join(PROJECTS_ROOT, current);
  const targetFile = join(targetDir, `${sessionId}.jsonl`);

  if (existsSync(targetFile)) {
    console.log(`Session already present at ${targetFile}; nothing to do.`);
    return;
  }

  const found = await findSession(sessionId);
  if (!found) {
    console.error(`Session ${sessionId} not found in any ~/.claude/projects/* directory.`);
    console.error(`Use --list to see available sessions.`);
    process.exit(1);
  }

  console.log(`Source: ${found.file}`);
  console.log(`        (project dir: ${found.projectDir}, ${(found.size / 1024).toFixed(1)} KB)`);
  console.log(`Target: ${targetFile}`);
  console.log(`        (current project: ${current})`);

  await mkdir(targetDir, { recursive: true });
  await cp(found.file, targetFile);
  console.log(`\nCopied. You can now resume with:`);
  console.log(`  npm run terminal -- --resume-session ${sessionId}`);
  console.log(`  npm run terminal:auto -- --resume-session ${sessionId}`);
}

main().catch((err) => {
  console.error('resume-session failed:', err);
  process.exit(1);
});
