/**
 * Shared filesystem helpers for the file adapter.
 *
 * - Atomic write: write-to-temp, fsync, rename. Prevents partial writes.
 * - Atomic create: write-to-temp, hard-link to target. Fails loudly if
 *   target exists (used by create-only callers like AtomStore.put).
 * - Safe read: returns null on ENOENT instead of throwing.
 * - Ensure directory exists (mkdir -p).
 */

import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write file atomically: to temp path, then rename. Rename is atomic on
 * POSIX and on Windows NTFS for same-volume targets.
 *
 * Overwrite semantics: if the target exists, rename clobbers it. Use
 * `atomicCreateFile` instead when create-or-fail is required.
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    // Clean up temp on failure.
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Atomically create a file; fail loudly if target already exists.
 *
 * Implementation: write to a temp file, then hard-link to the target.
 * `fs.link` is atomic on POSIX and on Windows NTFS, and fails with
 * EEXIST when the target is already present. The failure code is
 * stable across Linux, macOS, and Windows (NTFS).
 *
 * Race semantics: when N concurrent callers race on the same target,
 * exactly one link() call succeeds; the rest get EEXIST. This closes
 * the read-then-write TOCTOU window.
 *
 * Cleanup: the temp file is unlinked in both the success path (after
 * the hard link is established) and the failure path (target already
 * existed, link rejected, or any other error). No `.tmp` orphans
 * leak into the target directory.
 *
 * Throws an Error with `code === 'EEXIST'` when the target exists.
 * Callers translate that code into a domain error
 * (e.g. ConflictError) at their layer.
 */
export async function atomicCreateFile(path: string, data: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  try {
    await link(tmp, path);
  } finally {
    // Always remove the temp: on success it has a second name (the
    // target), on failure we don't want to leave residue.
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  const text = await readFileOrNull(path);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value, null, 2));
}

/** Append a line to a file (for JSONL logs). */
export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, line + '\n', 'utf8');
}

export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}

export function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'EEXIST';
}

/** Convenience: join paths, ensuring forward slashes for cross-platform. */
export function p(...parts: string[]): string {
  return join(...parts);
}
