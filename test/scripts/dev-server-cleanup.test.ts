/**
 * Unit tests for scripts/lib/dev-server-cleanup.mjs.
 *
 * Helpers run without forking real processes: every spawn / kill /
 * fs side-effect is injectable so the contract is exercised purely
 * through the interface. Coverage targets:
 *
 *   - PID-file roundtrip (read / write / remove with malformed
 *     input tolerated).
 *   - Stale-PID detection via injected isAlive.
 *   - Scan-output parsing for both Windows wmic CSV and POSIX ps.
 *   - cleanupOrphans orchestrator: PID-file path, scan-fallback,
 *     no-op when nothing to clean, error aggregation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  buildScanCommand,
  cleanupOrphans,
  isPidAlive,
  killProcessTree,
  parseScanOutput,
  readPidRecord,
  readPidRecordDir,
  removePidRecord,
  removePidRecordFile,
  writePidRecord,
  writePidRecordFile,
} from '../../scripts/lib/dev-server-cleanup.mjs';

describe('readPidRecord', () => {
  let tmp: string;
  let pidFile: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-dev-cleanup-'));
    pidFile = join(tmp, 'dev-servers.pid.json');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(readPidRecord(pidFile)).toBeNull();
  });

  it('returns null when the file is malformed JSON', async () => {
    await writeFile(pidFile, 'not-json{', 'utf8');
    expect(readPidRecord(pidFile)).toBeNull();
  });

  it('returns null when pids is missing or not an array', async () => {
    await writeFile(pidFile, JSON.stringify({ version: 1 }), 'utf8');
    expect(readPidRecord(pidFile)).toBeNull();
    await writeFile(pidFile, JSON.stringify({ pids: 'oops' }), 'utf8');
    expect(readPidRecord(pidFile)).toBeNull();
  });

  it('parses a valid record', async () => {
    await writeFile(
      pidFile,
      JSON.stringify({
        version: 1,
        pids: [12345, 12346],
        startedAt: '2026-05-04T10:00:00.000Z',
        repoRoot: '/repo',
        entry: 'apps/console/server/index.ts',
      }),
      'utf8',
    );
    const record = readPidRecord(pidFile);
    expect(record).toEqual({
      version: 1,
      pids: [12345, 12346],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
    });
  });

  it('filters out non-positive and non-finite pids', async () => {
    await writeFile(
      pidFile,
      JSON.stringify({ pids: [123, 0, -5, 'abc', null, 456] }),
      'utf8',
    );
    const record = readPidRecord(pidFile);
    expect(record?.pids).toEqual([123, 456]);
  });
});

describe('writePidRecord', () => {
  let tmp: string;
  let pidFile: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-dev-cleanup-'));
    pidFile = join(tmp, 'sub', 'dev-servers.pid.json');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes a JSON record with version 1 and creates the parent dir', async () => {
    writePidRecord(pidFile, {
      pids: [42, 43],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
    });
    const raw = await readFile(pidFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      version: 1,
      pids: [42, 43],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
    });
  });

  it('drops invalid pids before writing', async () => {
    writePidRecord(pidFile, {
      pids: [42, 0, -1, NaN, 43],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'x',
    });
    const parsed = JSON.parse(await readFile(pidFile, 'utf8'));
    expect(parsed.pids).toEqual([42, 43]);
  });

  it('defaults startedAt to a fresh ISO string when missing', async () => {
    writePidRecord(pidFile, { pids: [42], repoRoot: '/r', entry: 'x' });
    const parsed = JSON.parse(await readFile(pidFile, 'utf8'));
    expect(typeof parsed.startedAt).toBe('string');
    expect(() => new Date(parsed.startedAt).toISOString()).not.toThrow();
  });
});

describe('removePidRecord', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-dev-cleanup-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns false when the file is missing (no-op idempotent)', () => {
    expect(removePidRecord(join(tmp, 'missing.json'))).toBe(false);
  });

  it('removes an existing file and returns true', async () => {
    const f = join(tmp, 'p.json');
    await writeFile(f, '{}', 'utf8');
    expect(removePidRecord(f)).toBe(true);
    await expect(readFile(f, 'utf8')).rejects.toThrow();
  });
});

describe('isPidAlive', () => {
  it('returns false for invalid pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });

  it('returns true when killImpl returns successfully (alive)', () => {
    const alive = isPidAlive(123, {
      killImpl: () => undefined,
    });
    expect(alive).toBe(true);
  });

  it('returns false when killImpl throws ESRCH (dead)', () => {
    const dead = isPidAlive(123, {
      killImpl: () => {
        const e = new Error('No such process') as Error & { code?: string };
        e.code = 'ESRCH';
        throw e;
      },
    });
    expect(dead).toBe(false);
  });

  it('returns true when killImpl throws EPERM (alive but other-user)', () => {
    const alive = isPidAlive(123, {
      killImpl: () => {
        const e = new Error('Operation not permitted') as Error & { code?: string };
        e.code = 'EPERM';
        throw e;
      },
    });
    expect(alive).toBe(true);
  });
});

describe('killProcessTree', () => {
  it('returns ok=false for invalid pid without invoking exec', async () => {
    let called = false;
    const result = await killProcessTree(0, {
      platform: 'linux',
      execImpl: async () => {
        called = true;
        return { stdout: '' };
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('returns ok=true immediately when the pid is already dead', async () => {
    const result = await killProcessTree(123, {
      platform: 'linux',
      isAliveImpl: () => false,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already dead/);
  });

  it('uses taskkill /F /T /PID on win32', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let alive = true;
    const result = await killProcessTree(4321, {
      platform: 'win32',
      execImpl: async (cmd, args) => {
        calls.push({ cmd, args: [...args] });
        alive = false;
        return { stdout: '' };
      },
      isAliveImpl: () => alive,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ cmd: 'taskkill', args: ['/F', '/T', '/PID', '4321'] }]);
  });

  it('escalates SIGTERM to SIGKILL on POSIX when SIGTERM is ignored', async () => {
    const sigs: Array<{ pid: number; sig: NodeJS.Signals | number }> = [];
    let alive = true;
    const result = await killProcessTree(987, {
      platform: 'linux',
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        sigs.push({ pid: p, sig: s });
        if (s === 'SIGKILL') alive = false;
      }) as never,
      isAliveImpl: () => alive,
      sleepImpl: async () => undefined,
    });
    expect(result.ok).toBe(true);
    // First send is SIGTERM to the process group (-pid), then a
    // sequence of SIGKILLs to the group (after the grace window).
    expect(sigs[0]).toEqual({ pid: -987, sig: 'SIGTERM' });
    expect(sigs.some((s) => s.sig === 'SIGKILL')).toBe(true);
  });
});

describe('buildScanCommand', () => {
  it('returns wmic on win32', () => {
    expect(buildScanCommand('win32')).toEqual({
      cmd: 'wmic',
      args: ['process', 'get', 'ProcessId,CommandLine', '/format:csv'],
    });
  });
  it('returns ps on POSIX', () => {
    expect(buildScanCommand('linux')).toEqual({
      cmd: 'ps',
      args: ['-eo', 'pid,command'],
    });
    expect(buildScanCommand('darwin')).toEqual({
      cmd: 'ps',
      args: ['-eo', 'pid,command'],
    });
  });
});

describe('parseScanOutput', () => {
  it('extracts matching POSIX pids whose command-line contains the entry', () => {
    const stdout = [
      'PID COMMAND',
      ' 1234 node /repo/apps/console/node_modules/.bin/tsx watch server/index.ts',
      ' 5678 node /repo/apps/console/node_modules/.bin/vite',
      '99999 grep tsx',
      ' 8888 node /other-repo/apps/console/server/index.ts',
    ].join('\n');
    const pids = parseScanOutput(stdout, {
      platform: 'linux',
      entry: 'apps/console/server/index.ts',
      repoRoot: '/repo',
      selfPid: 9999,
    });
    expect(pids).toEqual([1234]);
  });

  it('excludes the calling process pid', () => {
    const stdout = [
      'PID COMMAND',
      ' 1234 node /repo/apps/console/server/index.ts',
    ].join('\n');
    const pids = parseScanOutput(stdout, {
      platform: 'linux',
      entry: 'apps/console/server/index.ts',
      repoRoot: '/repo',
      selfPid: 1234,
    });
    expect(pids).toEqual([]);
  });

  it('parses Windows wmic CSV output', () => {
    const stdout = [
      'Node,CommandLine,ProcessId',
      'HOST,"node C:\\repo\\apps\\console\\node_modules\\.bin\\tsx watch server\\index.ts",2222',
      'HOST,"node C:\\other\\app.js",3333',
      'HOST,,4444',
    ].join('\r\n');
    const pids = parseScanOutput(stdout, {
      platform: 'win32',
      entry: 'apps/console/server/index.ts',
      repoRoot: 'C:\\repo',
      selfPid: 9999,
    });
    expect(pids).toEqual([2222]);
  });

  it('returns empty when entry is not provided', () => {
    expect(parseScanOutput('1 something', { platform: 'linux', entry: '', repoRoot: '/r' })).toEqual([]);
  });

  it('returns empty for empty stdout', () => {
    expect(parseScanOutput('', { platform: 'linux', entry: 'x', repoRoot: '/r' })).toEqual([]);
  });

  it('drops matches outside the repo root', () => {
    const stdout = [
      'PID COMMAND',
      ' 1234 node /elsewhere/apps/console/server/index.ts',
    ].join('\n');
    const pids = parseScanOutput(stdout, {
      platform: 'linux',
      entry: 'apps/console/server/index.ts',
      repoRoot: '/repo',
      selfPid: 9999,
    });
    expect(pids).toEqual([]);
  });
});

describe('cleanupOrphans', () => {
  let tmp: string;
  let pidFile: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-dev-cleanup-'));
    pidFile = join(tmp, 'dev-servers.pid.json');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reports source=none when no pid file and scan finds nothing', async () => {
    const result = await cleanupOrphans({
      pidFile,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({ stdout: 'PID COMMAND\n' }),
      killImpl: (() => undefined) as never,
      sleepImpl: async () => undefined,
    });
    expect(result).toEqual({
      recordedKilled: [],
      scannedKilled: [],
      source: 'none',
      errors: [],
    });
  });

  it('kills recorded PIDs and removes the pid file', async () => {
    await writeFile(
      pidFile,
      JSON.stringify({
        version: 1,
        pids: [1111, 2222],
        startedAt: '2026-05-04T10:00:00.000Z',
        repoRoot: '/repo',
        entry: 'apps/console/server/index.ts',
      }),
      'utf8',
    );
    const live = new Set([1111, 2222]);
    const result = await cleanupOrphans({
      pidFile,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({ stdout: 'PID COMMAND\n' }),
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        if (s === 0) {
          if (!live.has(Math.abs(p))) {
            const e = new Error('ESRCH') as Error & { code?: string };
            e.code = 'ESRCH';
            throw e;
          }
          return;
        }
        live.delete(Math.abs(p));
      }) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.recordedKilled.sort()).toEqual([1111, 2222]);
    expect(result.scannedKilled).toEqual([]);
    expect(result.source).toBe('pid-file');
    // Pid file removed.
    await expect(readFile(pidFile, 'utf8')).rejects.toThrow();
  });

  it('uses scan-fallback when no pid file exists', async () => {
    const live = new Set([7777]);
    const result = await cleanupOrphans({
      pidFile,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({
        stdout: [
          'PID COMMAND',
          ' 7777 node /repo/apps/console/node_modules/.bin/tsx watch server/index.ts',
        ].join('\n'),
      }),
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        if (s === 0) {
          if (!live.has(Math.abs(p))) {
            const e = new Error('ESRCH') as Error & { code?: string };
            e.code = 'ESRCH';
            throw e;
          }
          return;
        }
        live.delete(Math.abs(p));
      }) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.recordedKilled).toEqual([]);
    expect(result.scannedKilled).toEqual([7777]);
    expect(result.source).toBe('scan');
  });

  it('does not double-kill pids found in both pid file and scan', async () => {
    await writeFile(
      pidFile,
      JSON.stringify({
        version: 1,
        pids: [5555],
        repoRoot: '/repo',
        entry: 'apps/console/server/index.ts',
        startedAt: '2026-05-04T00:00:00.000Z',
      }),
      'utf8',
    );
    const live = new Set([5555]);
    const killCalls: Array<{ pid: number; sig: NodeJS.Signals | number }> = [];
    const result = await cleanupOrphans({
      pidFile,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({
        stdout: [
          'PID COMMAND',
          ' 5555 node /repo/apps/console/server/index.ts',
        ].join('\n'),
      }),
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        killCalls.push({ pid: p, sig: s });
        if (s === 0) {
          if (!live.has(Math.abs(p))) {
            const e = new Error('ESRCH') as Error & { code?: string };
            e.code = 'ESRCH';
            throw e;
          }
          return;
        }
        live.delete(Math.abs(p));
      }) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.recordedKilled).toEqual([5555]);
    expect(result.scannedKilled).toEqual([]);
    // Should not have re-issued SIGTERM/SIGKILL after the recorded kill.
    const term = killCalls.filter((c) => c.sig === 'SIGTERM');
    expect(term.length).toBe(1);
  });

  it('aggregates errors without throwing when scan fails', async () => {
    const result = await cleanupOrphans({
      pidFile,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => {
        throw new Error('wmic disabled in this environment');
      },
      killImpl: (() => undefined) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/scan failed/);
  });

  it('preserves unresolved PIDs in the pidFile when a kill fails', async () => {
    // Records two PIDs; only one is killable, the other refuses to die.
    // The cleanup must rewrite the file with the unresolved PID rather
    // than removing it entirely (otherwise the next launcher loses
    // track of the survivor).
    await writeFile(
      pidFile,
      JSON.stringify({
        version: 1,
        pids: [3333, 4444],
        startedAt: '2026-05-04T10:00:00.000Z',
        repoRoot: '/repo',
        entry: 'apps/console/server/index.ts',
      }),
      'utf8',
    );
    const live = new Set([3333, 4444]);
    const result = await cleanupOrphans({
      pidFile,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({ stdout: 'PID COMMAND\n' }),
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        if (s === 0) {
          if (!live.has(Math.abs(p))) {
            const e = new Error('ESRCH') as Error & { code?: string };
            e.code = 'ESRCH';
            throw e;
          }
          return;
        }
        // 3333 dies; 4444 ignores all signals (simulates a wedged
        // child that won't even respond to SIGKILL within the
        // grace window).
        if (Math.abs(p) === 3333) live.delete(3333);
      }) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.recordedKilled).toEqual([3333]);
    expect(result.errors.length).toBeGreaterThan(0);
    // Pid file rewritten with only the unresolved PID.
    const remaining = JSON.parse(await readFile(pidFile, 'utf8'));
    expect(remaining.pids).toEqual([4444]);
  });
});

describe('readPidRecordDir / writePidRecordFile / removePidRecordFile', () => {
  let tmp: string;
  let dir: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-dev-cleanup-dir-'));
    dir = join(tmp, '.lag-dev-servers');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns [] when the directory does not exist', () => {
    expect(readPidRecordDir(dir)).toEqual([]);
  });

  it('round-trips per-launcher records', () => {
    writePidRecordFile(dir, 1001, {
      pids: [1001, 2002],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'tsx watch server/index.ts',
    });
    writePidRecordFile(dir, 1003, {
      pids: [1003, 2003],
      startedAt: '2026-05-04T10:00:01.000Z',
      repoRoot: '/repo',
      entry: 'vite',
    });
    const entries = readPidRecordDir(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.launcherPid)).toEqual([1001, 1003]);
    expect(entries[0].record.pids).toEqual([1001, 2002]);
    expect(entries[1].record.pids).toEqual([1003, 2003]);
  });

  it('skips files that fail to parse', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '999.json'), 'not-json{', 'utf8');
    writePidRecordFile(dir, 1001, {
      pids: [1001],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'x',
    });
    const entries = readPidRecordDir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].launcherPid).toBe(1001);
  });

  it('skips non-numeric filenames', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.json'), JSON.stringify({ pids: [1] }), 'utf8');
    writePidRecordFile(dir, 1001, {
      pids: [1001],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'x',
    });
    const entries = readPidRecordDir(dir);
    expect(entries.map((e) => e.launcherPid)).toEqual([1001]);
  });

  it('removePidRecordFile is idempotent', () => {
    writePidRecordFile(dir, 1001, {
      pids: [1001],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'x',
    });
    expect(removePidRecordFile(dir, 1001)).toBe(true);
    expect(removePidRecordFile(dir, 1001)).toBe(false);
  });
});

describe('cleanupOrphans pidDir mode', () => {
  let tmp: string;
  let dir: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-dev-cleanup-orph-'));
    dir = join(tmp, '.lag-dev-servers');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('walks every record file and kills the recorded PIDs', async () => {
    writePidRecordFile(dir, 1001, {
      pids: [1001, 2001],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'tsx watch server/index.ts',
    });
    writePidRecordFile(dir, 1002, {
      pids: [1002, 2002],
      startedAt: '2026-05-04T10:00:01.000Z',
      repoRoot: '/repo',
      entry: 'vite',
    });
    const live = new Set([1001, 2001, 1002, 2002]);
    const result = await cleanupOrphans({
      pidDir: dir,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({ stdout: 'PID COMMAND\n' }),
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        if (s === 0) {
          if (!live.has(Math.abs(p))) {
            const e = new Error('ESRCH') as Error & { code?: string };
            e.code = 'ESRCH';
            throw e;
          }
          return;
        }
        live.delete(Math.abs(p));
      }) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.recordedKilled.sort((a, b) => a - b)).toEqual([1001, 1002, 2001, 2002]);
    // Both record files removed.
    expect(readPidRecordDir(dir)).toEqual([]);
  });

  it('preserves only the unresolved PIDs per record file', async () => {
    writePidRecordFile(dir, 1001, {
      pids: [1001, 2001],
      startedAt: '2026-05-04T10:00:00.000Z',
      repoRoot: '/repo',
      entry: 'tsx watch server/index.ts',
    });
    const live = new Set([1001, 2001]);
    const result = await cleanupOrphans({
      pidDir: dir,
      repoRoot: '/repo',
      entry: 'apps/console/server/index.ts',
      platform: 'linux',
      execImpl: async () => ({ stdout: 'PID COMMAND\n' }),
      killImpl: ((p: number, s: NodeJS.Signals | number) => {
        if (s === 0) {
          if (!live.has(Math.abs(p))) {
            const e = new Error('ESRCH') as Error & { code?: string };
            e.code = 'ESRCH';
            throw e;
          }
          return;
        }
        // 1001 dies cleanly; 2001 refuses (simulates wedged child).
        if (Math.abs(p) === 1001) live.delete(1001);
      }) as never,
      sleepImpl: async () => undefined,
    });
    expect(result.recordedKilled).toEqual([1001]);
    const remaining = readPidRecordDir(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].record.pids).toEqual([2001]);
  });
});
