// Pure helpers for scripts/dev-server-cleanup.mjs and
// scripts/dev-server-with-pid.mjs.
//
// Extracted into a shebang-free module so vitest can static-import
// the helpers from a `.test.ts` file without tripping the
// Windows-CI shebang-parsing bug (importing a shebanged `.mjs`
// causes SyntaxError at line 1 column 1 even though Node's own
// loader handles it fine when the file is invoked directly).
//
// The module covers two complementary failure modes for long-running
// dev servers (vite + tsx watch):
//
//   (b) PID-FILE LIFECYCLE: the launcher writes child PIDs to a
//       JSON record on start; on next start, the cleanup helper
//       reads + kills any prior PID before spawning new ones.
//       Deterministic, kills only OUR processes.
//
//   (a) SCAN-AND-KILL FALLBACK: when the PID file is missing
//       (unclean shutdown, manual delete, fresh worktree), scan
//       the OS process table for tsx/vite processes whose
//       command-line matches the recorded server entry path AND
//       whose cwd is rooted in this repo. Kill only matching PIDs.
//
// Cross-platform: Windows (tasklist + taskkill) and POSIX
// (ps + kill -9). All platform branches are gated through
// `process.platform === 'win32'`.

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Shape of the PID-file record. Versioned so future fields don't
// silently break older readers; v1 readers tolerate extra keys.
//
// Example:
//   {
//     "version": 1,
//     "pids": [12345, 12346],
//     "startedAt": "2026-05-04T10:00:00.000Z",
//     "repoRoot": "/c/Users/opens/memory-governance",
//     "entry": "apps/console/server/index.ts"
//   }

/**
 * Read and parse the PID record. Returns null when the file is
 * missing, empty, or malformed (treat any parse failure as "no
 * record" so a corrupted file does not block startup).
 */
export function readPidRecord(pidFile, opts = {}) {
  const fs = opts.fs ?? { existsSync, readFileSync };
  if (!fs.existsSync(pidFile)) return null;
  let raw;
  try {
    raw = fs.readFileSync(pidFile, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.pids)) return null;
  const pids = parsed.pids
    .map((n) => (typeof n === 'number' ? n : Number.parseInt(String(n), 10)))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    pids,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    repoRoot: typeof parsed.repoRoot === 'string' ? parsed.repoRoot : null,
    entry: typeof parsed.entry === 'string' ? parsed.entry : null,
  };
}

/**
 * Write the PID record. Creates the parent directory if missing.
 * Pure-ish: side-effects only on the injected fs (default: real fs).
 */
export function writePidRecord(pidFile, record, opts = {}) {
  const fs = opts.fs ?? { mkdirSync, writeFileSync };
  fs.mkdirSync(dirname(pidFile), { recursive: true });
  const safe = {
    version: 1,
    pids: Array.isArray(record.pids)
      ? record.pids.filter((n) => Number.isFinite(n) && n > 0)
      : [],
    startedAt: typeof record.startedAt === 'string'
      ? record.startedAt
      : new Date().toISOString(),
    repoRoot: typeof record.repoRoot === 'string' ? record.repoRoot : null,
    entry: typeof record.entry === 'string' ? record.entry : null,
  };
  fs.writeFileSync(pidFile, JSON.stringify(safe, null, 2) + '\n', 'utf8');
}

/**
 * Remove the PID record. Idempotent: returns false if the file
 * does not exist; never throws.
 */
export function removePidRecord(pidFile, opts = {}) {
  const fs = opts.fs ?? { existsSync, unlinkSync };
  if (!fs.existsSync(pidFile)) return false;
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-launcher PID-record directory mode. Each launcher (one per
 * concurrent dev-server child: tsx watch, vite, ...) writes its
 * own JSON file at <pidDir>/<launcherPid>.json. Read merges all
 * files. This eliminates the lost-update race that a single shared
 * file would have under concurrent npm-script spawns: each writer
 * touches a unique path, no read-merge-write window exists.
 *
 * The directory shape is what `cleanupOrphans` consumes when
 * `pidDir` is set; the legacy single-file mode (`pidFile`) is
 * retained for callers that already write a single record.
 */

/**
 * Read every record file in `pidDir`. Files that fail to parse
 * are skipped (a single malformed file does not block cleanup).
 * Returns an array of { launcherPid, record } pairs sorted by
 * launcherPid for determinism.
 */
export function readPidRecordDir(pidDir, opts = {}) {
  const fs = opts.fs ?? { existsSync, readdirSync, readFileSync };
  if (!fs.existsSync(pidDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(pidDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const launcherPid = Number.parseInt(name.slice(0, -'.json'.length), 10);
    if (!Number.isFinite(launcherPid) || launcherPid <= 0) continue;
    const record = readPidRecord(join(pidDir, name), { fs });
    if (record === null) continue;
    out.push({ launcherPid, record, file: join(pidDir, name) });
  }
  return out.sort((a, b) => a.launcherPid - b.launcherPid);
}

/**
 * Write a per-launcher record to `<pidDir>/<launcherPid>.json`.
 * Each launcher owns its own file: no read-merge-write race.
 */
export function writePidRecordFile(pidDir, launcherPid, record, opts = {}) {
  const path = join(pidDir, `${launcherPid}.json`);
  return writePidRecord(path, record, opts);
}

/**
 * Remove a per-launcher record. Returns false when the file is
 * already gone (idempotent).
 */
export function removePidRecordFile(pidDir, launcherPid, opts = {}) {
  const path = join(pidDir, `${launcherPid}.json`);
  return removePidRecord(path, opts);
}

/**
 * Liveness probe. Standard cross-platform technique: signal 0
 * throws ESRCH if the pid is dead, and EPERM if the pid exists
 * but is owned by another user (still alive). Both POSIX and
 * Windows respect signal 0 in node's wrapper.
 */
export function isPidAlive(pid, opts = {}) {
  const killImpl = opts.killImpl ?? ((p, s) => process.kill(p, s));
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? /** @type {{code?:string}} */ (err).code
      : undefined;
    return code === 'EPERM';
  }
}

/**
 * Cross-platform kill of a process tree (parent + children).
 *
 * Windows: `taskkill /F /T /PID <pid>` walks the win32 job-object
 * graph to terminate all descendants. Without /T, killing tsx
 * leaves the underlying node child running.
 *
 * POSIX: send SIGTERM first, then SIGKILL after a short grace.
 * For node-child-process spawn() with detached:true the child
 * leads its own process group and `process.kill(-pid, signal)`
 * delivers to the whole group. We try both -pid and pid so the
 * helper works whether or not the caller used detached:true.
 *
 * Returns { ok, message } where ok=true means we believe the
 * pid is now dead; false includes a reason string. Never throws.
 */
export async function killProcessTree(pid, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const execImpl = opts.execImpl;
  const killImpl = opts.killImpl ?? ((p, s) => process.kill(p, s));
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const isAlive = opts.isAliveImpl ?? ((p) => isPidAlive(p, { killImpl }));

  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, message: `invalid pid ${pid}` };
  }
  if (!isAlive(pid)) {
    return { ok: true, message: `pid ${pid} already dead` };
  }

  if (platform === 'win32') {
    if (!execImpl) {
      return { ok: false, message: 'win32 kill requires execImpl injection' };
    }
    try {
      await execImpl('taskkill', ['/F', '/T', '/PID', String(pid)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // taskkill exits non-zero when the pid is already gone (128).
      // Re-probe rather than fail; the post-condition (pid is dead)
      // is what we care about, not the exit code.
      if (!isAlive(pid)) {
        return { ok: true, message: `pid ${pid} already dead (taskkill: ${msg})` };
      }
      return { ok: false, message: `taskkill failed: ${msg}` };
    }
    if (isAlive(pid)) {
      return { ok: false, message: `pid ${pid} still alive after taskkill /F /T` };
    }
    return { ok: true, message: `pid ${pid} terminated via taskkill` };
  }

  // POSIX: SIGTERM the group first, fall back to SIGTERM the bare
  // pid if the group send fails (process is not a group leader).
  let groupKilled = false;
  try {
    killImpl(-pid, 'SIGTERM');
    groupKilled = true;
  } catch {
    // Not a group leader, or already gone. Try the bare pid.
    try { killImpl(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Grace window for graceful shutdown.
  for (let i = 0; i < 10; i++) {
    if (!isAlive(pid)) {
      return { ok: true, message: `pid ${pid} terminated via SIGTERM${groupKilled ? ' (group)' : ''}` };
    }
    await sleepImpl(100);
  }

  // Escalate to SIGKILL.
  try {
    if (groupKilled) killImpl(-pid, 'SIGKILL');
    else killImpl(pid, 'SIGKILL');
  } catch { /* already gone */ }

  for (let i = 0; i < 10; i++) {
    if (!isAlive(pid)) {
      return { ok: true, message: `pid ${pid} terminated via SIGKILL${groupKilled ? ' (group)' : ''}` };
    }
    await sleepImpl(50);
  }
  return { ok: false, message: `pid ${pid} still alive after SIGKILL` };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the cross-platform process-table scan command.
 *
 * Windows: `wmic process get ProcessId,CommandLine /format:csv` is
 * the most portable shape that returns full command-lines. Newer
 * Windows ships PowerShell-only `Get-CimInstance` paths; we stick
 * to wmic because it's universally present on Windows 10/11.
 *
 * POSIX: `ps -eo pid,command` includes the full command-line and
 * matches every Unix in the wild. We do not use BSD `-www` since
 * it's not portable; the parser tolerates truncation.
 */
export function buildScanCommand(platform) {
  if (platform === 'win32') {
    return {
      cmd: 'wmic',
      args: ['process', 'get', 'ProcessId,CommandLine', '/format:csv'],
    };
  }
  return { cmd: 'ps', args: ['-eo', 'pid,command'] };
}

/**
 * Parse the platform-specific scan output into a list of orphan
 * PIDs whose command-line matches our entry pattern.
 *
 * The match contract is intentionally narrow: the command-line
 * MUST contain BOTH the `entry` substring (e.g.
 * `server/index.ts`) AND the `repoRoot` substring (so we never
 * touch a tsx watch from an unrelated repo on the same host).
 * The PID-file path lookup is a separate caller-controlled
 * filter; this function only sees raw stdout.
 *
 * Returns a sorted, de-duplicated array of pids.
 */
export function parseScanOutput(stdout, opts) {
  const platform = opts.platform ?? process.platform;
  const entry = String(opts.entry ?? '');
  const repoRoot = String(opts.repoRoot ?? '');
  const selfPid = typeof opts.selfPid === 'number' ? opts.selfPid : process.pid;
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  if (entry.length === 0) return [];

  const matches = new Set();
  if (platform === 'win32') {
    // wmic CSV: Node,CommandLine,ProcessId
    // (the first column is the host; on POSIX equivalents wmic is
    // not present but we never reach here on POSIX).
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.split(',');
      if (cols.length < 3) continue;
      const pidStr = cols[cols.length - 1].trim();
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (pid === selfPid) continue;
      const cmdline = cols.slice(1, cols.length - 1).join(',').trim();
      if (cmdline.length === 0) continue;
      if (matchesEntry(cmdline, entry, repoRoot)) matches.add(pid);
    }
  } else {
    // POSIX `ps -eo pid,command`: first column is pid (right-aligned
    // with leading whitespace), remainder is the command-line. The
    // first whitespace run is the column separator; cmdline is
    // everything after.
    const lines = stdout.split(/\r?\n/);
    // Skip header line ("PID COMMAND" or similar).
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      const cmdline = m[2].trim();
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (pid === selfPid) continue;
      if (cmdline.length === 0) continue;
      if (matchesEntry(cmdline, entry, repoRoot)) matches.add(pid);
    }
  }
  return Array.from(matches).sort((a, b) => a - b);
}

function matchesEntry(cmdline, entry, repoRoot) {
  // Normalize separators so a Windows backslash command-line still
  // matches a forward-slash entry pattern and vice-versa. Without
  // this the same logical path renders differently on Win and POSIX
  // (`apps\\console\\server\\index.ts` vs `apps/console/server/index.ts`).
  const cmdNorm = cmdline.replace(/\\/g, '/');
  const entryNorm = entry.replace(/\\/g, '/');

  // The entry pattern can appear in cmdline two ways:
  //   1. As an argv item: e.g. `tsx watch server/index.ts` when
  //      tsx was invoked from cwd=apps/console/. The bare basename
  //      portion (`server/index.ts`) is what shows up.
  //   2. As an absolute path: when the launcher uses
  //      `tsx watch /repo/apps/console/server/index.ts` (some
  //      tooling resolves this).
  // We match either the full entryNorm or its basename suffix
  // (everything after the last slash, plus the slash itself).
  const lastSlash = entryNorm.lastIndexOf('/');
  const tail = lastSlash >= 0 ? entryNorm.slice(lastSlash + 1) : entryNorm;
  const suffixForms = [entryNorm, '/' + tail];
  // Also match the trailing two segments (e.g. `server/index.ts`)
  // so a bare `tsx watch server/index.ts` argv matches.
  if (lastSlash >= 0) {
    const beforeLast = entryNorm.slice(0, lastSlash);
    const prevSlash = beforeLast.lastIndexOf('/');
    if (prevSlash >= 0) {
      suffixForms.push(beforeLast.slice(prevSlash + 1) + '/' + tail);
    }
  }
  const entryHit = suffixForms.some((s) => cmdNorm.includes(s));
  if (!entryHit) return false;

  // repoRoot is optional but strongly recommended; when absent we
  // fall back to entry-only matching, which is fine because the
  // entry path is itself project-local (e.g. apps/console/server/
  // index.ts is unique enough on a typical dev box).
  if (repoRoot.length === 0) return true;
  const rootNorm = repoRoot.replace(/\\/g, '/');
  return cmdNorm.includes(rootNorm);
}

/**
 * Orchestrator: clean up any prior dev-server orphans before
 * spawning fresh watchers.
 *
 * Order:
 *   1. Read PID record (b). Kill any live recorded PIDs.
 *   2. Remove the PID record (so a partial-failure path can
 *      restart cleanly).
 *   3. Run the OS scan (a). Kill any matching PIDs not already
 *      handled by step 1 (covers unclean shutdowns where the
 *      PID record was lost).
 *
 * Returns a summary suitable for logging:
 *   { recordedKilled, scannedKilled, source, errors }
 *
 * Never throws. Errors per-pid are aggregated into the summary
 * so the launcher can log and proceed; a flaky scan does not
 * block the dev server from starting.
 */
export async function cleanupOrphans(opts) {
  const pidFile = opts.pidFile;
  const pidDir = opts.pidDir;
  const repoRoot = opts.repoRoot;
  const entry = opts.entry;
  const execImpl = opts.execImpl;
  const platform = opts.platform ?? process.platform;
  const killImpl = opts.killImpl;
  const isAliveImpl = opts.isAliveImpl;
  const sleepImpl = opts.sleepImpl;
  const fs = opts.fs;

  const errors = [];
  const recordedKilled = [];
  const scannedKilled = [];

  // Step 1: PID-file path. Two modes are supported:
  //
  //   - `pidDir`: per-launcher record directory. Each file is
  //     read independently; cleanup walks every file and tracks
  //     which kills failed PER FILE so the next launcher can
  //     retry the unresolved PIDs (rather than losing them when
  //     the file is removed).
  //   - `pidFile`: legacy single-file record. Same retry-on-fail
  //     contract: only delete the file when every recorded PID
  //     is dead.
  //
  // Files are touched atomically: success path removes the file;
  // partial-failure path rewrites the file with only the PIDs
  // that we could not kill.
  const recordsToProcess = [];
  if (typeof pidDir === 'string' && pidDir.length > 0) {
    for (const entry of readPidRecordDir(pidDir, { fs })) {
      recordsToProcess.push(entry);
    }
  } else if (typeof pidFile === 'string' && pidFile.length > 0) {
    const record = readPidRecord(pidFile, { fs });
    if (record !== null) {
      recordsToProcess.push({ launcherPid: 0, record, file: pidFile });
    }
  }

  for (const { record, file } of recordsToProcess) {
    const unresolved = [];
    for (const pid of record.pids) {
      if (!isPidAlive(pid, { killImpl })) continue;
      const result = await killProcessTree(pid, {
        platform,
        execImpl,
        killImpl,
        isAliveImpl,
        sleepImpl,
      });
      if (result.ok) {
        recordedKilled.push(pid);
      } else {
        unresolved.push(pid);
        errors.push(`pid ${pid}: ${result.message}`);
      }
    }
    // Preserve unresolved PIDs so the next launcher retries them.
    // Drop the file only when every recorded PID is verified dead;
    // a partial failure rewrites the record with the leftovers.
    if (unresolved.length === 0) {
      removePidRecord(file, { fs });
    } else {
      writePidRecord(file, {
        ...record,
        pids: unresolved,
      }, { fs });
    }
  }

  // Step 2: scan-fallback. Always runs (even when the PID record
  // was present) because the recorded list can lag behind reality
  // when the launcher crashed mid-write.
  if (typeof entry === 'string' && entry.length > 0) {
    const { cmd, args } = buildScanCommand(platform);
    let stdout = '';
    if (execImpl) {
      try {
        const result = await execImpl(cmd, args, { capture: true });
        stdout = typeof result === 'string' ? result : (result?.stdout ?? '');
      } catch (err) {
        // A failed scan (e.g. wmic disabled, ps not on PATH in a
        // minimal container) degrades to "no scan results"; the
        // PID-file path already ran so we are not silently broken,
        // just less robust.
        errors.push(`scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const pids = parseScanOutput(stdout, { platform, entry, repoRoot });
    for (const pid of pids) {
      if (recordedKilled.includes(pid)) continue;
      if (!isPidAlive(pid, { killImpl })) continue;
      const result = await killProcessTree(pid, {
        platform,
        execImpl,
        killImpl,
        isAliveImpl,
        sleepImpl,
      });
      if (result.ok) scannedKilled.push(pid);
      else errors.push(`pid ${pid}: ${result.message}`);
    }
  }

  const source = recordedKilled.length > 0
    ? (scannedKilled.length > 0 ? 'pid-file+scan' : 'pid-file')
    : (scannedKilled.length > 0 ? 'scan' : 'none');

  return { recordedKilled, scannedKilled, source, errors };
}
