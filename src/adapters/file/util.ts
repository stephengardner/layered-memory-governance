/**
 * Shared filesystem helpers for the file adapter.
 *
 * - Atomic write: write-to-temp, fsync, rename. Prevents partial writes.
 * - Safe read: returns null on ENOENT instead of throwing.
 * - Ensure directory exists (mkdir -p).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write file atomically: to temp path, then rename. Rename is atomic on
 * POSIX and on Windows NTFS for same-volume targets.
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

/** Convenience: join paths, ensuring forward slashes for cross-platform. */
export function p(...parts: string[]): string {
  return join(...parts);
}
