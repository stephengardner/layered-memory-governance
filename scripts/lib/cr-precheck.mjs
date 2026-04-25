// Pure helpers for scripts/cr-precheck.mjs. Extracted into their
// own shebang-free module so the test can static-import them
// (PR #123 landed the same pattern after observing vitest's
// Windows-CI runner failing to strip shebangs from imported `.mjs`
// files: importing a shebanged `.mjs` from a `.test.ts` causes
// SyntaxError at line 1 column 1 even though Node's own loader
// handles it fine when the file is invoked directly).
//
// No I/O, no spawn, no host. Each export is a pure function over
// its arguments so unit tests can drive every classification branch
// without spinning up a fake process tree or an AtomStore.

import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';

// Cross-platform PATH walk. Equivalent to POSIX `command -v <name>` /
// Windows `where.exe <name>` but implemented in pure Node so the
// behaviour is identical on Linux, macOS, and Windows (Git Bash, cmd,
// PowerShell). On Windows, callers typically omit the extension; we
// resolve via PATHEXT (.exe, .cmd, .bat, ...) so a request for
// `coderabbit` matches `coderabbit.exe` in the install dir. POSIX
// systems have no PATHEXT analogue; the bare name is the executable.
//
// Returns the absolute path of the first match, or null.
function defaultWhich(name) {
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  if (pathEnv.length === 0) return null;
  const isWindows = process.platform === 'win32';
  // PATHEXT defaults match Windows shell behaviour. The empty-string
  // entry handles the case where the file already includes its
  // extension (e.g., `coderabbit.exe` passed in directly).
  const exts = isWindows
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // Permission errors / EACCES / EBUSY: keep walking. A directory
        // we can't stat shouldn't kill the search.
      }
    }
  }
  return null;
}

// Find the coderabbit binary on PATH. Tries the canonical name first
// so we never accidentally pick up an unrelated `cr` alias on the
// operator's PATH (crystal lang's REPL, personal aliases, etc).
export function findCoderabbitOnPath(opts = {}) {
  const which = opts.which ?? defaultWhich;
  for (const name of ['coderabbit', 'cr']) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

// Parse CR CLI v0.4.2 `--agent` mode NDJSON output into per-severity
// counts. Tolerates non-JSON lines (CR may emit a banner or trailing
// warning); unrecognized severities surface as `minor` so the gate
// never accidentally escalates a label we don't understand.
export function parseCrCliAgentFindings(output) {
  const counts = { critical: 0, major: 0, minor: 0 };
  if (typeof output !== 'string' || output.length === 0) return counts;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Non-JSON banner / warning. Skip rather than fail closed; the
      // alternative (throwing) would treat a noisy CR run as an
      // unparseable error and route through the cli-error skip path,
      // wasting an audit atom on the operator's transient stderr.
      continue;
    }
    if (obj?.type !== 'finding') continue;
    const sev = String(obj.severity ?? '').toLowerCase();
    if (sev === 'critical') counts.critical++;
    else if (sev === 'major') counts.major++;
    else counts.minor++;
  }
  return counts;
}

// Classify a `spawnSync` result as cli-error or runnable.
//
// A CR CLI run is treated as a cli-error when ANY of:
//   - `result.error` is set (spawn-level failure: ENOENT, EACCES,
//     explicit timeout via `spawnSync` opts, etc).
//   - `result.signal` is non-null (SIGTERM, SIGKILL, SIGINT, ...). A
//     signal-terminated child returns `{status: null, signal: 'SIG*'}`
//     and `result.error` is NOT populated for that case, so the
//     status-only check would silently fall through to the parser.
//     The parser would then read a truncated NDJSON stream as zero
//     findings, write a clean `cr-precheck-run` atom, and exit 0:
//     the exact silent-skip vector the spec is built to close.
//   - `result.status` is a non-zero numeric exit code. Note that
//     `status === null` alone is NOT a cli-error (e.g., spawn failures
//     are caught via `result.error`); the signal check above handles
//     the signal-termination case explicitly.
//
// Pure helper so tests can drive every classification branch via a
// fake `result` shape without spawning a real process.
export function isCliErrorResult(result) {
  if (result === null || typeof result !== 'object') return false;
  if (result.error) return true;
  if (result.signal !== null && result.signal !== undefined) return true;
  if (typeof result.status === 'number' && result.status !== 0) return true;
  return false;
}

// Map findings to exit code + human-readable reason. The default gate
// fires on critical+major; --strict additionally blocks on minor.
export function decideExitCode(findings, opts = {}) {
  const { strict = false } = opts;
  const c = findings?.critical ?? 0;
  const m = findings?.major ?? 0;
  const n = findings?.minor ?? 0;
  if (c > 0) return { exitCode: 1, reason: `${c} critical finding(s)` };
  if (m > 0) return { exitCode: 1, reason: `${m} major finding(s)` };
  if (strict && n > 0) return { exitCode: 1, reason: `${n} minor finding(s) with --strict` };
  return { exitCode: 0, reason: 'clean' };
}
