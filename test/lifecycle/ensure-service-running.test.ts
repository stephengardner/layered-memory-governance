/**
 * Tests for the lifecycle primitive. Uses an injected spawn + isAlive
 * so we never fork a real child; the contract is exercised purely
 * through the interface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureServiceRunning,
  getServiceStatus,
  stopService,
} from '../../src/lifecycle/index.js';

describe('ensureServiceRunning', () => {
  let tmp: string;
  let pidFile: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-lifecycle-'));
    pidFile = join(tmp, 'svc.pid');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('spawns when no lockfile exists and writes the pid', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const res = await ensureServiceRunning({
      command: 'my-svc',
      args: ['--flag'],
      pidFile,
      spawnImpl: ((command, args) => {
        calls.push({ command, args: [...args] });
        return { pid: 42, unref: () => {} } as never;
      }) as never,
      isAlive: () => false,
    });
    expect(res).toEqual({ status: 'started', pid: 42 });
    expect(calls).toEqual([{ command: 'my-svc', args: ['--flag'] }]);
    const raw = await readFile(pidFile, 'utf8');
    expect(raw.trim()).toBe('42');
  });

  it('is idempotent when the pid in the lockfile is alive', async () => {
    await writeFile(pidFile, '100\n');
    let spawned = false;
    const res = await ensureServiceRunning({
      command: 'my-svc',
      args: [],
      pidFile,
      spawnImpl: (() => {
        spawned = true;
        return { pid: 999, unref: () => {} } as never;
      }) as never,
      isAlive: (pid) => pid === 100,
    });
    expect(res).toEqual({ status: 'already-running', pid: 100 });
    expect(spawned).toBe(false);
  });

  it('reclaims a stale lock when the recorded pid is dead', async () => {
    await writeFile(pidFile, '777\n');
    const res = await ensureServiceRunning({
      command: 'my-svc',
      args: [],
      pidFile,
      spawnImpl: (() => ({ pid: 888, unref: () => {} } as never)) as never,
      isAlive: (pid) => pid === 888, // 777 is dead
    });
    expect(res).toEqual({
      status: 'stale-lock-reclaimed',
      pid: 888,
      previousPid: 777,
    });
    const raw = await readFile(pidFile, 'utf8');
    expect(raw.trim()).toBe('888');
  });

  it('returns failed when spawn throws', async () => {
    const res = await ensureServiceRunning({
      command: 'my-svc',
      args: [],
      pidFile,
      spawnImpl: (() => { throw new Error('ENOENT'); }) as never,
      isAlive: () => false,
    });
    expect(res.status).toBe('failed');
    if (res.status === 'failed') {
      expect(res.reason).toContain('ENOENT');
    }
  });

  it('merges env overlay on top of process.env', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    await ensureServiceRunning({
      command: 'my-svc',
      args: [],
      pidFile,
      env: { MY_CUSTOM_VAR: 'hello' },
      spawnImpl: ((_cmd, _args, opts: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = opts?.env;
        return { pid: 1, unref: () => {} } as never;
      }) as never,
      isAlive: () => false,
    });
    expect(capturedEnv?.MY_CUSTOM_VAR).toBe('hello');
    // Parent env keys still visible.
    expect(capturedEnv?.PATH).toBeDefined();
  });
});

describe('getServiceStatus', () => {
  let tmp: string;
  let pidFile: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-lifecycle-'));
    pidFile = join(tmp, 'svc.pid');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reports stopped when no lockfile', async () => {
    const res = await getServiceStatus({ pidFile });
    expect(res).toEqual({ status: 'stopped' });
  });

  it('reports running when pid is alive', async () => {
    await writeFile(pidFile, '123\n');
    const res = await getServiceStatus({ pidFile, isAlive: () => true });
    expect(res).toEqual({ status: 'running', pid: 123 });
  });

  it('reports stale when pid is dead', async () => {
    await writeFile(pidFile, '456\n');
    const res = await getServiceStatus({ pidFile, isAlive: () => false });
    expect(res).toEqual({ status: 'stale', pid: 456 });
  });
});

describe('stopService', () => {
  let tmp: string;
  let pidFile: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lag-lifecycle-'));
    pidFile = join(tmp, 'svc.pid');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('sends signal, waits for exit, then removes lockfile', async () => {
    await writeFile(pidFile, '555\n');
    const sent: Array<{ pid: number; signal: string }> = [];
    // Simulate a process that is alive at the time of kill but becomes
    // dead once killImpl runs. stopService now polls isAlive after
    // sending the signal so removing the lockfile eagerly cannot let
    // a caller spawn a replacement while the old process still exists.
    let dead = false;
    const res = await stopService({
      pidFile,
      isAlive: () => !dead,
      killImpl: (pid, signal) => {
        sent.push({ pid, signal });
        dead = true;
      },
    });
    expect(res).toEqual({ status: 'stopped', pid: 555 });
    expect(sent).toEqual([{ pid: 555, signal: 'SIGTERM' }]);
    // Lockfile removed.
    await expect(stat(pidFile)).rejects.toThrow();
  });

  it('reports failed when the process does not exit within the grace window', async () => {
    // Regression guard for the eager-rm bug: if the signal is sent but
    // the process stays alive, stopService must not pretend success.
    // Callers (e.g. lag-tg terminal) rely on this to decide whether to
    // escalate to SIGKILL or abort.
    await writeFile(pidFile, '666\n');
    const res = await stopService({
      pidFile,
      isAlive: () => true, // stays alive forever
      killImpl: () => { /* no-op: signal sent, but the process ignores it */ },
    });
    expect(res.status).toBe('failed');
    // Lockfile NOT removed: the caller must not assume the slot is free.
    await expect(stat(pidFile)).resolves.toBeDefined();
  });

  it('reports not-running when pid is dead (clears lockfile)', async () => {
    await writeFile(pidFile, '999\n');
    const res = await stopService({
      pidFile,
      isAlive: () => false,
      killImpl: () => { throw new Error('should not be called'); },
    });
    expect(res).toEqual({ status: 'not-running' });
    await expect(stat(pidFile)).rejects.toThrow();
  });

  it('reports not-running when no lockfile', async () => {
    const res = await stopService({ pidFile });
    expect(res).toEqual({ status: 'not-running' });
  });
});
