/**
 * ensureServiceRunning: a generic, framework-agnostic primitive that
 * keeps a background service alive across invocations.
 *
 * Intended use case: a Claude Code SessionStart hook, or any periodic
 * trigger, that wants to guarantee "process X is up" without having
 * to think about whether it already started.
 *
 * The contract is deliberately narrow:
 *   - caller supplies the command to run and a PID lockfile path
 *   - we check the lockfile; if the recorded PID is alive, do nothing
 *   - if the PID is missing or dead, spawn the command detached and
 *     write the new PID
 *
 * Cross-platform (Linux, macOS, Windows). No native modules; only
 * node:child_process + node:fs/promises. No LAG-specific assumptions:
 * this module knows nothing about daemons, actors, canon, or telegram.
 * It is suitable for extraction to a separate package if a second
 * consumer appears.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface EnsureServiceOptions {
  /** Executable to spawn. Resolved against PATH unless absolute. */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args: ReadonlyArray<string>;
  /**
   * Absolute path to a PID lockfile. The parent directory is created
   * if missing. A subsequent call with the same path is the liveness
   * check.
   */
  readonly pidFile: string;
  /** Working directory for the spawned process. Default: process.cwd(). */
  readonly cwd?: string;
  /**
   * Environment overlay merged on top of process.env. Absent keys fall
   * back to the parent environment. Useful for opt-in flags.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Optional path for the spawned process's stdout/stderr. When set,
   * both streams are redirected here (append mode). When absent, both
   * are routed to /dev/null so the spawned process truly detaches.
   */
  readonly logFile?: string;
  /**
   * Liveness check. Default uses `process.kill(pid, 0)` which is the
   * standard non-destructive probe on POSIX and Windows. Injectable
   * for tests.
   */
  readonly isAlive?: (pid: number) => boolean | Promise<boolean>;
  /**
   * Spawn impl. Default uses node:child_process.spawn. Injectable so
   * tests can assert args + env without forking a real process.
   */
  readonly spawnImpl?: typeof spawn;
}

export type EnsureServiceResult =
  | { readonly status: 'already-running'; readonly pid: number }
  | { readonly status: 'started'; readonly pid: number }
  | {
      readonly status: 'stale-lock-reclaimed';
      readonly pid: number;
      readonly previousPid: number;
    }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Ensure the service described by `options` is running. Idempotent:
 * safe to call on every invocation.
 *
 * Never throws. Failures are returned in the `failed` branch so the
 * caller (typically a hook) can decide whether to surface them.
 */
export async function ensureServiceRunning(
  options: EnsureServiceOptions,
): Promise<EnsureServiceResult> {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const spawnFn = options.spawnImpl ?? spawn;
  const lockFile = options.pidFile + '.lock';

  const existing = await readExistingPid(options.pidFile);
  if (existing !== null) {
    const alive = await isAlive(existing);
    if (alive) return { status: 'already-running', pid: existing };
  }

  // Atomic lock-or-bust. `openSync(..., 'wx')` throws EEXIST if the
  // lock file is already there. Without this guard, two concurrent
  // callers (e.g. two SessionStart hooks firing at the same millisecond)
  // both observe a missing pidFile, both spawn a detached child, and
  // whichever writes the pidFile last wins. We'd end up with a
  // double-started service and a leaked process. The lockfile makes
  // exactly one caller win the spawn.
  try {
    await mkdir(dirname(lockFile), { recursive: true });
    const fd = openSync(lockFile, 'wx');
    // Stash our PID in the lock for diagnostics if we crash before
    // cleanup; the real service pid lands in the pidFile on success.
    try { writeSync(fd, String(process.pid)); } catch { /* ignore */ }
    try { closeSync(fd); } catch { /* ignore */ }
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'EEXIST') {
      // Another caller holds the lock. Give them a short window to
      // finish spawning and write the pidFile, then observe the
      // result. If we still see no live pid, the other caller likely
      // crashed mid-spawn; surface as failed so the caller can retry.
      for (let i = 0; i < 10; i++) {
        await sleep(100);
        const pid = await readExistingPid(options.pidFile);
        if (pid !== null && (await isAlive(pid))) {
          return { status: 'already-running', pid };
        }
      }
      return {
        status: 'failed',
        reason: `lockfile ${lockFile} held by another caller but pidFile never became live. Remove the lockfile and retry.`,
      };
    }
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let startResult: StartResult;
  try {
    startResult = await startDetached(options, spawnFn);
  } catch (err) {
    // Release the lock so a retry can make progress.
    await rm(lockFile, { force: true }).catch(() => { /* ignore */ });
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await writePidFile(options.pidFile, startResult.pid);
  } catch (err) {
    // Kill the orphan. We already spawned the detached child, so if
    // we can't persist its pid to the lockfile, the next caller will
    // see "no pidFile" and spawn a SECOND instance while the first
    // is still running. Best-effort SIGTERM; whatever happens, we
    // release the lock and surface failure.
    try { process.kill(startResult.pid, 'SIGTERM'); } catch { /* already gone */ }
    await rm(lockFile, { force: true }).catch(() => { /* ignore */ });
    return {
      status: 'failed',
      reason: `spawned pid ${startResult.pid} but could not write ${options.pidFile} (orphan killed): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // pidFile is now authoritative; release the lock. A leaked lock
  // only costs the next caller one retry loop, so best-effort rm.
  await rm(lockFile, { force: true }).catch(() => { /* ignore */ });

  return existing !== null
    ? { status: 'stale-lock-reclaimed', pid: startResult.pid, previousPid: existing }
    : { status: 'started', pid: startResult.pid };
}

export interface GetStatusOptions {
  readonly pidFile: string;
  readonly isAlive?: (pid: number) => boolean | Promise<boolean>;
}

export type ServiceStatus =
  | { readonly status: 'running'; readonly pid: number }
  | { readonly status: 'stopped' }
  | { readonly status: 'stale'; readonly pid: number };

/**
 * Probe the lockfile without starting anything. `stale` means the
 * lockfile exists but the PID is dead (likely an unclean shutdown).
 */
export async function getServiceStatus(
  options: GetStatusOptions,
): Promise<ServiceStatus> {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const pid = await readExistingPid(options.pidFile);
  if (pid === null) return { status: 'stopped' };
  const alive = await isAlive(pid);
  return alive ? { status: 'running', pid } : { status: 'stale', pid };
}

export interface StopServiceOptions {
  readonly pidFile: string;
  /** POSIX signal to send. Default 'SIGTERM'. Ignored on Windows. */
  readonly signal?: NodeJS.Signals;
  readonly isAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

export type StopServiceResult =
  | { readonly status: 'stopped'; readonly pid: number }
  | { readonly status: 'not-running' }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Send a signal to the recorded PID and remove the lockfile. Idempotent:
 * a second call after a successful stop returns `not-running`.
 */
export async function stopService(
  options: StopServiceOptions,
): Promise<StopServiceResult> {
  const signal = options.signal ?? 'SIGTERM';
  const isAlive = options.isAlive ?? defaultIsAlive;
  const killImpl = options.killImpl ?? ((pid, sig) => { process.kill(pid, sig); });

  const pid = await readExistingPid(options.pidFile);
  if (pid === null) return { status: 'not-running' };
  const alive = await isAlive(pid);
  if (!alive) {
    await rm(options.pidFile, { force: true });
    return { status: 'not-running' };
  }
  try {
    killImpl(pid, signal);
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Wait for the process to actually exit before clearing the
  // pidFile. If we removed the pidFile eagerly a caller could spawn
  // a replacement instance while the old one is still draining
  // requests, which defeats the lifecycle guarantee for `restart`
  // and terminal takeover. We poll isAlive for up to ~2 seconds; if
  // the process still lives past that, surface a weaker state so
  // the caller knows to back off or escalate to SIGKILL.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!(await isAlive(pid))) {
      await rm(options.pidFile, { force: true });
      return { status: 'stopped', pid };
    }
    await sleep(100);
  }
  return {
    status: 'failed',
    reason: `sent ${signal} to pid ${pid} but it is still alive after 2s grace. ` +
      `Caller should retry with SIGKILL or investigate a wedged process.`,
  };
}

// ---- internals ---------------------------------------------------------

interface StartResult {
  readonly pid: number;
}

async function startDetached(
  options: EnsureServiceOptions,
  spawnFn: typeof spawn,
): Promise<StartResult> {
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;

  let stdio: 'ignore' | ['ignore', number, number];
  let logFd: number | undefined;
  if (options.logFile !== undefined) {
    await mkdir(dirname(options.logFile), { recursive: true });
    // Append-open so a pre-existing log is preserved and restarts land
    // on the tail. 'a' = append, 0o644 rw/r/r.
    logFd = openSync(options.logFile, 'a', 0o644);
    stdio = ['ignore', logFd, logFd];
  } else {
    stdio = 'ignore';
  }

  try {
    const child = spawnFn(options.command, [...options.args], {
      cwd: options.cwd ?? process.cwd(),
      env,
      detached: true,
      stdio,
      windowsHide: true,
    });

    // Detach: unref the child so the parent can exit without waiting.
    // Wrap in try so a mock spawn (no unref) doesn't throw.
    try { child.unref(); } catch { /* ok */ }

    if (typeof child.pid !== 'number') {
      throw new Error('spawn did not return a pid');
    }
    return { pid: child.pid };
  } finally {
    // Close the parent-side log FD after spawn. The child inherited
    // its own references via stdio, so closing here only releases the
    // parent's descriptor. Without this, repeated starts/restarts
    // leak one FD per start until the parent hits its ulimit.
    if (logFd !== undefined) {
      try { closeSync(logFd); } catch { /* ignore */ }
    }
  }
}

async function readExistingPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, 'utf8');
    const n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

async function writePidFile(pidFile: string, pid: number): Promise<void> {
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(pidFile, String(pid) + '\n', 'utf8');
}

function defaultIsAlive(pid: number): boolean {
  try {
    // signal 0 is the standard no-op probe: throws ESRCH if dead,
    // returns true if alive (or EPERM if alive but owned by another user).
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = exists but we lack permission. For our purposes, still alive.
    if (err && typeof err === 'object' && 'code' in err) {
      return (err as { code?: string }).code === 'EPERM';
    }
    return false;
  }
}
