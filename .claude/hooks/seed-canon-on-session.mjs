#!/usr/bin/env node
/**
 * PreToolUse hook: once per Claude Code session, seed canon atoms
 * from `bootstrap-all-canon.mjs` so session agents see the authored
 * canon the moment they start operating.
 *
 * Context: session 2026-04-21 surfaced the gap. The cto-actor drafted
 * a plan and correctly flagged a cited atom as absent - the edit to
 * `bootstrap-decisions-canon.mjs` had landed on main, but the script
 * was never executed, so the canon store lagged the source. This hook
 * closes that mechanically: first tool call per session runs
 * bootstrap-all, writes a guard file, subsequent calls noop instantly.
 *
 * Fires on PreToolUse/Bash (the established matcher). Claude Code's
 * PreToolUse payload includes `session_id`, which we use as the guard
 * key. New session re-seeds; mid-session restart re-seeds (cheap +
 * idempotent). Second-plus tool calls in one session skip.
 *
 * Two levels of mutual exclusion:
 *   - Per-session guard file (`.lag/session-seeds/<id>.done`) short-
 *     circuits warm paths in the same session.
 *   - Repo-wide lock file (`.lag/session-seeds/repo-bootstrap.lock`)
 *     serialises bootstrap subprocesses so two Claude Code sessions
 *     cannot race on the bootstrap scripts' get-then-put drift checks.
 *     Acquired atomically via `open(..., 'wx')`; stale locks past
 *     LOCK_STALE_MS are reclaimed.
 *
 * Scope: this repo only. In another project the hook does not exist.
 * Fail-open: any crash, lock timeout, subprocess hang, or bootstrap
 * failure allows the tool call to proceed with a stderr diagnostic.
 * Performance: cold seed ~1s; warm seed short-circuits before the
 * lock attempt.
 */

import {
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_DIR = resolve(REPO_ROOT, '.lag', 'session-seeds');
const BOOTSTRAP_SCRIPT = resolve(REPO_ROOT, 'scripts', 'bootstrap-all-canon.mjs');
const REPO_LOCK_PATH = resolve(GUARD_DIR, 'repo-bootstrap.lock');

// Session ids are Claude Code UUIDs; tighten to a safe filename
// pattern before using one in resolve() to prevent `../` path
// traversal or absolute-path overrides of the guard file.
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// Hard timeout on the bootstrap subprocess so a hung child cannot
// violate the fail-open contract. 30s is >> the observed cold-seed
// time (~1s) and leaves plenty of slack for cold-cache file systems.
const BOOTSTRAP_TIMEOUT_MS = 30_000;

// Max time to wait for the repo-wide bootstrap lock before giving up.
// A concurrent session's seed completes in ~1s; 15s covers the
// worst-case sequential queue of a few sessions.
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 100;
// If a lock file is older than this, assume the previous holder
// crashed without releasing it and reclaim. Bootstrap takes ~1-2s;
// 60s is a very generous stale threshold.
const LOCK_STALE_MS = 60_000;

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    process.stderr.write('[seed-canon] no session_id in payload; skipping seed + allow\n');
    process.exit(0);
  }
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    // Untrusted id: refuse to build a filename path from it. Fail open
    // so the session work proceeds; the caller can investigate the
    // payload shape if this stderr line appears.
    process.stderr.write(
      `[seed-canon] session_id failed safety check (${sessionId.length} chars); skipping seed + allow\n`,
    );
    process.exit(0);
  }

  const guardPath = resolve(GUARD_DIR, `${sessionId}.done`);
  if (existsSync(guardPath)) process.exit(0);

  if (!process.env.LAG_OPERATOR_ID) {
    process.stderr.write(
      '[seed-canon] LAG_OPERATOR_ID not set; skipping canon seed for this session.\n'
      + '[seed-canon] Set it in your shell profile and restart to re-seed.\n',
    );
    tryWriteGuard(guardPath);
    process.exit(0);
  }

  // Acquire the repo-wide bootstrap lock BEFORE spawning the
  // subprocess. If another Claude Code session is mid-seed we wait
  // for it to finish; if we timeout we fail open (the other session
  // is presumed to have seeded the canon anyway, and worst case our
  // own session runs without canon for this tick).
  let lockAcquired = false;
  try {
    lockAcquired = await acquireRepoLock();
  } catch (err) {
    process.stderr.write(`[seed-canon] lock acquire failed: ${err?.message ?? err}\n`);
  }
  if (!lockAcquired) {
    process.stderr.write('[seed-canon] could not acquire repo-bootstrap lock in time; allowing tool call\n');
    process.exit(0);
  }

  try {
    const t0 = Date.now();
    const result = spawnSync('node', [BOOTSTRAP_SCRIPT], {
      stdio: 'inherit',
      env: process.env,
      timeout: BOOTSTRAP_TIMEOUT_MS,
    });
    const elapsed = Date.now() - t0;

    // spawnSync on timeout: result.error is { code: 'ETIMEDOUT' } + signal
    // set; result.status is null. Cover that branch explicitly.
    if (result.error) {
      const code = result.error?.code;
      if (code === 'ETIMEDOUT') {
        process.stderr.write(
          `[seed-canon] bootstrap-all timed out after ${BOOTSTRAP_TIMEOUT_MS}ms (signal=${result.signal ?? '?'}). Canon may be out of sync.\n`,
        );
      } else {
        process.stderr.write(`[seed-canon] failed to spawn bootstrap-all: ${result.error.message} (${elapsed}ms)\n`);
      }
      process.exit(0);
    }
    if (result.status !== 0) {
      process.stderr.write(`[seed-canon] bootstrap-all exited with status ${result.status} (${elapsed}ms). Canon may be out of sync.\n`);
      process.exit(0);
    }

    tryWriteGuard(guardPath);
    process.stderr.write(`[seed-canon] canon seeded in ${elapsed}ms for session ${sessionId.slice(0, 8)}\n`);
    process.exit(0);
  } finally {
    releaseRepoLock();
  }
}

/**
 * Acquire the repo-wide bootstrap lock by creating
 * `.lag/session-seeds/repo-bootstrap.lock` atomically with `wx`
 * (fails if exists). On EEXIST, poll every LOCK_POLL_MS until either
 * the lock clears or we hit LOCK_WAIT_MS. If the existing lock is
 * older than LOCK_STALE_MS, reclaim it (previous holder presumed
 * crashed). Returns true on success, false on timeout.
 */
async function acquireRepoLock() {
  try {
    mkdirSync(GUARD_DIR, { recursive: true });
  } catch {
    // if we cannot even mkdir the guard dir, fail open
    return false;
  }

  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    // Try atomic create. 'wx' throws EEXIST if the file already exists.
    try {
      const fd = openSync(REPO_LOCK_PATH, 'wx');
      closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    // File exists. If it is older than LOCK_STALE_MS, reclaim.
    try {
      const st = statSync(REPO_LOCK_PATH);
      const age = Date.now() - st.mtimeMs;
      if (age > LOCK_STALE_MS) {
        try {
          unlinkSync(REPO_LOCK_PATH);
          continue; // retry create on next loop iteration
        } catch {
          // lost the race to another session; fall through to poll
        }
      }
    } catch {
      // lock vanished between our open and our stat; retry
      continue;
    }
    await sleep(LOCK_POLL_MS);
  }
  return false;
}

function releaseRepoLock() {
  try {
    unlinkSync(REPO_LOCK_PATH);
  } catch (err) {
    // releasing a non-existent lock is fine (timeout path); other
    // errors get logged to stderr but do not change exit code.
    if (err?.code !== 'ENOENT') {
      process.stderr.write(`[seed-canon] lock release failed: ${err?.message ?? err}\n`);
    }
  }
}

function tryWriteGuard(guardPath) {
  try {
    mkdirSync(dirname(guardPath), { recursive: true });
    writeFileSync(guardPath, new Date().toISOString() + '\n');
  } catch (err) {
    process.stderr.write(`[seed-canon] could not write guard ${guardPath}: ${err?.message ?? err}\n`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(() => process.exit(0));
