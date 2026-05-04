/**
 * Unit tests for the file-adapter `util.ts` helpers, focused on the
 * Windows-transient retry behaviour added to `atomicWriteFile`.
 *
 * Background: on Windows, `fs.rename` over a freshly written file
 * intermittently fails with EPERM / EBUSY / EACCES because Defender,
 * SearchIndexer, or another scanner briefly opens the new file for
 * inspection. The failure is transient (typically clears within a few
 * tens of milliseconds). A short bounded retry loop with exponential
 * backoff turns the flake into a correctness-preserving wait.
 *
 * Test approach: the rename function is injected through an internal
 * `_renameImpl` option so the loop's behaviour can be exercised
 * deterministically without mocking the global filesystem. Real fs
 * coverage is still provided by the no-injection success case which
 * walks the production rename.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFile,
  __testing__,
} from '../../../src/adapters/file/util.js';

describe('atomicWriteFile - Windows-transient retry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lag-util-retry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes through cleanly when rename succeeds on first attempt', async () => {
    const target = join(dir, 'target.json');
    await atomicWriteFile(target, '{"ok":true}');
    expect(await readFile(target, 'utf8')).toBe('{"ok":true}');
  });

  it('retries on EPERM and succeeds when the scanner releases the lock', async () => {
    const target = join(dir, 'eperm.json');
    let calls = 0;
    const flakyRename = async (src: string, dest: string): Promise<void> => {
      calls++;
      if (calls < 3) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      // Real rename for the final attempt so the on-disk artifact lands.
      const { rename } = await import('node:fs/promises');
      await rename(src, dest);
    };
    await atomicWriteFile(target, 'data', { _renameImpl: flakyRename, _delayMs: () => 0 });
    expect(calls).toBe(3);
    expect(await readFile(target, 'utf8')).toBe('data');
  });

  it('retries on EBUSY', async () => {
    const target = join(dir, 'ebusy.json');
    let calls = 0;
    const flakyRename = async (src: string, dest: string): Promise<void> => {
      calls++;
      if (calls < 2) {
        const err = new Error('EBUSY: resource busy or locked, rename') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      const { rename } = await import('node:fs/promises');
      await rename(src, dest);
    };
    await atomicWriteFile(target, 'data', { _renameImpl: flakyRename, _delayMs: () => 0 });
    expect(calls).toBe(2);
  });

  it('retries on EACCES', async () => {
    const target = join(dir, 'eacces.json');
    let calls = 0;
    const flakyRename = async (src: string, dest: string): Promise<void> => {
      calls++;
      if (calls < 4) {
        const err = new Error('EACCES: permission denied, rename') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      const { rename } = await import('node:fs/promises');
      await rename(src, dest);
    };
    await atomicWriteFile(target, 'data', { _renameImpl: flakyRename, _delayMs: () => 0 });
    expect(calls).toBe(4);
  });

  it('throws non-transient errors immediately without retrying', async () => {
    const target = join(dir, 'enoent.json');
    let calls = 0;
    const failingRename = async (): Promise<void> => {
      calls++;
      const err = new Error('ENOENT: no such file or directory, rename') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    await expect(
      atomicWriteFile(target, 'data', { _renameImpl: failingRename, _delayMs: () => 0 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });

  it('exhausts retries on persistent EPERM and re-throws the original error', async () => {
    const target = join(dir, 'persistent.json');
    let calls = 0;
    const alwaysFails = async (): Promise<void> => {
      calls++;
      const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    await expect(
      atomicWriteFile(target, 'data', { _renameImpl: alwaysFails, _delayMs: () => 0 }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    // Default policy: 1 initial attempt + 6 retries = 7 calls.
    expect(calls).toBe(7);
  });

  it('cleans up the temp file after exhausting retries', async () => {
    const target = join(dir, 'cleanup.json');
    let lastTmpSeen: string | null = null;
    const alwaysFails = async (src: string): Promise<void> => {
      lastTmpSeen = src;
      const err = new Error('EBUSY: rename failed') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    };
    await expect(
      atomicWriteFile(target, 'data', { _renameImpl: alwaysFails, _delayMs: () => 0 }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    // The .tmp file was created before the rename; the failure path
    // must remove it. readFile should report ENOENT.
    expect(lastTmpSeen).not.toBeNull();
    await expect(readFile(lastTmpSeen as unknown as string, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('isTransientWindowsRenameError - pure classifier', () => {
  it('classifies EPERM, EBUSY, EACCES as transient', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const err = Object.assign(new Error('x'), { code });
      expect(__testing__.isTransientRenameError(err)).toBe(true);
    }
  });

  it('rejects ENOENT, EEXIST, and unrelated errors', () => {
    for (const code of ['ENOENT', 'EEXIST', 'EISDIR', 'EROFS']) {
      const err = Object.assign(new Error('x'), { code });
      expect(__testing__.isTransientRenameError(err)).toBe(false);
    }
    expect(__testing__.isTransientRenameError(new Error('plain'))).toBe(false);
    expect(__testing__.isTransientRenameError(null)).toBe(false);
    expect(__testing__.isTransientRenameError(undefined)).toBe(false);
    expect(__testing__.isTransientRenameError({})).toBe(false);
  });
});

describe('computeBackoffMs - exponential 50/100/200/400/800/1600', () => {
  it('returns the documented schedule for attempts 0..5', () => {
    expect(__testing__.computeBackoffMs(0)).toBe(50);
    expect(__testing__.computeBackoffMs(1)).toBe(100);
    expect(__testing__.computeBackoffMs(2)).toBe(200);
    expect(__testing__.computeBackoffMs(3)).toBe(400);
    expect(__testing__.computeBackoffMs(4)).toBe(800);
    expect(__testing__.computeBackoffMs(5)).toBe(1600);
  });
});

describe('atomicWriteFile - backoff timing', () => {
  it('waits between retry attempts using the supplied delay function', async () => {
    const target = join(tmpdir(), 'never-written-' + Math.random().toString(36).slice(2));
    const delays: number[] = [];
    const recordingDelay = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const alwaysFails = async (): Promise<void> => {
      const err = new Error('EBUSY') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    };
    await expect(
      atomicWriteFile(target, 'data', { _renameImpl: alwaysFails, _delayMs: recordingDelay }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    // Six retries -> six backoff calls between the seven attempts.
    expect(delays).toEqual([50, 100, 200, 400, 800, 1600]);
  });
});
