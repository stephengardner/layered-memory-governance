/**
 * Shared filesystem helpers for the file adapter.
 *
 * - Atomic write: write-to-temp, fsync, rename. Prevents partial writes.
 * - Atomic create: write-to-temp, hard-link to target. Fails loudly if
 *   target exists (used by create-only callers like AtomStore.put).
 * - Safe read: returns null on ENOENT instead of throwing.
 * - Ensure directory exists (mkdir -p).
 *
 * Transient-rename retry: on Windows, anti-virus and indexer processes
 * intermittently hold a handle on a freshly-created file for tens to
 * thousands of milliseconds (observed up to ~3s under heavy parallel
 * load from a conformance suite + Defender real-time scan), causing
 * `rename` to fail with EPERM, EBUSY, or EACCES. The failure is
 * transient -- the same call succeeds shortly after. We absorb the
 * flake with a bounded exponential-backoff retry around the rename
 * syscall (50, 100, 200, 400, 800, 1600 ms; up to 6 retries, summing
 * ~3.15s). Other error codes throw immediately so genuine bugs are not
 * masked. POSIX systems share this code path: on Linux/macOS the
 * transient codes are not produced for in-process renames so the loop
 * passes through with no observable cost beyond a single conditional.
 */

import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Codes that signal an anti-virus / indexer transiently holding the
 * destination path. EPERM is the most common on Windows; EBUSY appears
 * for SMB/network volumes; EACCES surfaces when the path is in a
 * directory the scanner has briefly elevated.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const DEFAULT_MAX_RETRIES = 6;

/** Exponential backoff: 50, 100, 200, 400, 800, 1600 ms (sum ~3.15s). */
function computeBackoffMs(attempt: number): number {
  return 50 * (1 << attempt);
}

function isTransientRenameError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (!('code' in err)) return false;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Internal options for `atomicWriteFile`. Exposed only for testing the
 * retry mechanism without driving the real filesystem into a flaky
 * state. Underscore-prefixed and not part of the public API contract.
 */
export interface AtomicWriteFileOptions {
  readonly _renameImpl?: (src: string, dest: string) => Promise<void>;
  readonly _delayMs?: (ms: number) => Promise<void>;
  readonly _maxRetries?: number;
}

/**
 * Write file atomically: to temp path, then rename. Rename is atomic on
 * POSIX and on Windows NTFS for same-volume targets.
 *
 * Overwrite semantics: if the target exists, rename clobbers it. Use
 * `atomicCreateFile` instead when create-or-fail is required.
 *
 * Transient-rename retry: see file header. The retry loop applies to
 * the rename syscall only; the temp-file write is a fresh path nobody
 * else holds and does not flake under the same scanner pattern.
 */
export async function atomicWriteFile(
  path: string,
  data: string,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  const renameImpl = options._renameImpl ?? rename;
  const delayMs = options._delayMs ?? defaultDelay;
  const maxRetries = options._maxRetries ?? DEFAULT_MAX_RETRIES;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await renameImpl(tmp, path);
        return;
      } catch (err) {
        if (!isTransientRenameError(err) || attempt === maxRetries) {
          throw err;
        }
        await delayMs(computeBackoffMs(attempt));
      }
    }
    // Unreachable: the loop either returns or throws above. Defensive
    // throw keeps the type-checker honest.
    throw new Error('atomicWriteFile: retry loop exited without return or throw');
  } catch (err) {
    // Clean up temp on every failure path (non-transient first throw,
    // exhausted retries, or the unreachable defensive throw above).
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

/**
 * Internal hooks exported for test-only access. The public API is the
 * named exports above; this struct is the seam tests use to verify
 * pure-function behaviour (classifier, backoff curve) without tying
 * those internals into the framework's public surface.
 */
export const __testing__ = {
  isTransientRenameError,
  computeBackoffMs,
  TRANSIENT_RENAME_CODES,
} as const;
