#!/usr/bin/env node
/**
 * cr-precheck: pre-push CodeRabbit-CLI helper with progressive enhancement.
 *
 * Detects whether the CodeRabbit CLI is on PATH. If found: runs the
 * review against the local diff, blocks the push on critical/major
 * findings, writes a `cr-precheck-run` audit atom on success. If NOT
 * found: emits a LOUD stderr warning, writes a `cr-precheck-skip`
 * audit atom, exits 0 (the CI backstop runs the review server-side).
 *
 * Usage:
 *   node scripts/cr-precheck.mjs                   # default base origin/main
 *   node scripts/cr-precheck.mjs --base origin/dev # override base ref
 *   node scripts/cr-precheck.mjs --strict          # also block on minor
 *   CR_PRECHECK_DRY_RUN=1 node scripts/cr-precheck.mjs   # skip audit-atom write
 *
 * Why no `--no-audit` flag: the audit atom is the LOUD-skip discipline.
 * A flag to suppress it would be a silent-skip vector. Operators
 * legitimately testing the helper set CR_PRECHECK_DRY_RUN=1 at the
 * shell; a sub-agent dispatched from a clean env cannot do that
 * without explicit operator action.
 *
 * CR CLI agent-mode output shape (verified against v0.4.2 on probe
 * diff 2026-04-25):
 *   NDJSON, one JSON object per line. Discriminator on `type`:
 *     - {"type":"review_context", reviewType, currentBranch, baseBranch, workingDirectory}
 *     - {"type":"status", phase, status}
 *     - {"type":"finding", severity, fileName, codegenInstructions, suggestions}
 *         severity ∈ "critical" | "major" | "minor" (extra labels treated as minor)
 *     - {"type":"complete", status, findings}
 *     - {"type":"error", errorType, message, recoverable, details}
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

/**
 * Cross-platform PATH walk. Equivalent to POSIX `command -v <name>` /
 * Windows `where.exe <name>` but implemented in pure Node so behaviour
 * is identical on Linux, macOS, and Windows (Git Bash, cmd, PowerShell).
 *
 * On Windows, callers typically omit the extension; we resolve via
 * PATHEXT (.exe, .cmd, .bat, ...) so a request for `coderabbit`
 * matches `coderabbit.exe` in the install dir. POSIX systems have no
 * PATHEXT analogue; the bare name is the executable.
 *
 * Returns the absolute path of the first match, or null.
 */
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

/**
 * Find the coderabbit binary on PATH. Tries the canonical name first
 * so we never accidentally pick up an unrelated `cr` alias on the
 * operator's PATH (crystal lang's REPL, personal aliases, etc).
 */
export function findCoderabbitOnPath(opts = {}) {
  const which = opts.which ?? defaultWhich;
  for (const name of ['coderabbit', 'cr']) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/**
 * Parse CR CLI v0.4.2 `--agent` mode NDJSON output into per-severity
 * counts. Tolerates non-JSON lines (CR may emit a banner or trailing
 * warning); unrecognized severities surface as `minor` so the gate
 * never accidentally escalates a label we don't understand.
 */
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

/**
 * Classify a `spawnSync` result as cli-error or runnable.
 *
 * A CR CLI run is treated as a cli-error when ANY of:
 *   - `result.error` is set (spawn-level failure: ENOENT, EACCES,
 *     explicit timeout via `spawnSync` opts, etc).
 *   - `result.signal` is non-null (SIGTERM, SIGKILL, SIGINT, ...). A
 *     signal-terminated child returns `{status: null, signal: 'SIG*'}`
 *     and `result.error` is NOT populated for that case, so the
 *     status-only check would silently fall through to the parser.
 *     The parser would then read a truncated NDJSON stream as zero
 *     findings, write a clean `cr-precheck-run` atom, and exit 0:
 *     the exact silent-skip vector the spec is built to close.
 *   - `result.status` is a non-zero numeric exit code. Note that
 *     `status === null` alone is NOT a cli-error (e.g., spawn failures
 *     are caught via `result.error`); the signal check above handles
 *     the signal-termination case explicitly.
 *
 * Pure helper so tests can drive every classification branch via a
 * fake `result` shape without spawning a real process.
 */
export function isCliErrorResult(result) {
  if (result === null || typeof result !== 'object') return false;
  if (result.error) return true;
  if (result.signal !== null && result.signal !== undefined) return true;
  if (typeof result.status === 'number' && result.status !== 0) return true;
  return false;
}

/**
 * Map findings to exit code + human-readable reason. The default gate
 * fires on critical+major; --strict additionally blocks on minor.
 */
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

function parseArgs(argv) {
  const args = { base: null, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--strict') args.strict = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: see header docstring in scripts/cr-precheck.mjs');
      process.exit(0);
    } else {
      console.error(`[cr-precheck] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.base) args.base = 'origin/main';
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function shortHex(bytes = 8) {
  return randomBytes(bytes).toString('hex').slice(0, bytes);
}

function safeHeadSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Build a project-scope `observation` atom carrying a cr-precheck
 * payload. Discriminated by metadata.kind; exactly one of the two
 * payload keys is populated per atom.
 */
function buildAtom(kind, payload) {
  if (kind !== 'cr-precheck-skip' && kind !== 'cr-precheck-run') {
    throw new Error(`[cr-precheck] invalid atom kind: ${kind}`);
  }
  const ts = nowIso();
  const id = `${kind}-${ts.replace(/[:.]/g, '-')}-${shortHex(8)}`;
  const metadata = { kind };
  // One payload key per atom; the other is intentionally absent so a
  // consumer reading metadata.kind never has to disambiguate via
  // shape inspection.
  if (kind === 'cr-precheck-skip') metadata.cr_precheck_skip = payload;
  else metadata.cr_precheck_run = payload;

  return {
    schema_version: 1,
    id,
    content: kind === 'cr-precheck-skip'
      ? `cr-precheck skipped: ${payload?.reason ?? 'unknown'}`
      : `cr-precheck ran: critical=${payload?.findings?.critical ?? 0} major=${payload?.findings?.major ?? 0} minor=${payload?.findings?.minor ?? 0}`,
    type: 'observation',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'cr-precheck' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: ts,
    last_reinforced_at: ts,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cr-precheck',
    taint: 'clean',
    metadata,
  };
}

async function writeAtom(kind, payload) {
  const atom = buildAtom(kind, payload);
  try {
    const host = await createFileHost({ rootDir: STATE_DIR });
    await host.atoms.put(atom);
    return atom.id;
  } catch (err) {
    // Atom write failure is loud but not fatal: the helper's primary
    // job is the gate, not the audit. The stderr line ensures the
    // operator sees the failure even when the gate itself is green.
    console.error(`[cr-precheck] atom write failed: ${err?.message ?? err}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = process.env.CR_PRECHECK_DRY_RUN === '1';
  if (dryRun) {
    console.error('[cr-precheck] CR_PRECHECK_DRY_RUN=1 set; running in dry-run mode (no audit atom write).');
  }

  const cliPath = findCoderabbitOnPath();
  if (cliPath === null) {
    console.error('[cr-precheck] coderabbit NOT FOUND on PATH; canon dev-coderabbit-cli-pre-push expects this run. Skipping local pre-push CR review (CI backstop will run it server-side).');
    if (!dryRun) {
      await writeAtom('cr-precheck-skip', {
        reason: 'coderabbit-not-on-path',
        commit_sha: safeHeadSha(),
        cwd: process.cwd(),
        os: process.platform,
        captured_at: nowIso(),
      });
    }
    return 0;
  }

  // Resolve version (best effort; the binary may stutter on first invocation).
  let version = 'unknown';
  try {
    version = execSync(`"${cliPath}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch {
    // Non-fatal: a binary on PATH that fails --version still gets a
    // chance to run the review; we just record the version as unknown.
  }
  console.error(`[cr-precheck] found coderabbit at ${cliPath} v${version}`);

  // Compute diff. Empty diff is a no-op (not a skip): nothing to review,
  // no audit atom emitted. The skip-vs-empty asymmetry matches the spec
  // (§3.1 step 2) so the audit log doesn't fill with empty-diff noise.
  let diff = '';
  try {
    diff = execSync(`git diff ${args.base}...HEAD`, { encoding: 'utf8' });
  } catch (err) {
    console.error(`[cr-precheck] git diff failed against ${args.base}: ${err?.message ?? err}`);
    return 1;
  }
  if (diff.trim().length === 0) {
    console.error(`[cr-precheck] no diff vs ${args.base}; nothing to review.`);
    return 0;
  }

  // Invoke CR CLI in agent mode (NDJSON). --no-color keeps the stream
  // parseable even when stderr is a TTY in some shells.
  const start = Date.now();
  const result = spawnSync(cliPath, ['review', '--agent', '--no-color', '--base', args.base.replace(/^origin\//, '')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const duration = Date.now() - start;

  // Treat spawn errors, signal-termination, and non-zero exits as
  // cli-error. Note: a findings-bearing successful run typically exits
  // 0 in agent mode; the gate logic is downstream of parsing, not the
  // exit code. Signal-termination is included explicitly because a
  // SIGTERM/SIGKILL'd child returns `{status: null, signal: 'SIG*'}`
  // with `result.error` unset; without the signal check, control would
  // flow to the parser, read a truncated stream as 0 findings, and
  // write a clean atom (the silent-skip vector). isCliErrorResult is
  // a pure helper so the classification is unit-testable.
  if (isCliErrorResult(result)) {
    const stderrSlice = (result.stderr ?? '').slice(0, 500);
    console.error(`[cr-precheck] coderabbit exited ${result.status} (signal=${result.signal ?? 'none'}); treating as cli-error.`);
    if (stderrSlice.length > 0) console.error(stderrSlice);
    if (!dryRun) {
      await writeAtom('cr-precheck-skip', {
        reason: 'cli-error',
        commit_sha: safeHeadSha(),
        cwd: process.cwd(),
        os: process.platform,
        cli_error_message: stderrSlice,
        captured_at: nowIso(),
      });
    }
    return 1;
  }

  const findings = parseCrCliAgentFindings(result.stdout ?? '');
  const decision = decideExitCode(findings, { strict: args.strict });

  if (!dryRun) {
    await writeAtom('cr-precheck-run', {
      commit_sha: safeHeadSha(),
      findings,
      cli_version: version,
      duration_ms: duration,
      captured_at: nowIso(),
    });
  }

  console.error(
    `[cr-precheck] findings: critical=${findings.critical} major=${findings.major} minor=${findings.minor}; decision=${decision.reason}`,
  );
  if (decision.exitCode !== 0) {
    // Print stdout so the operator/agent reads the per-finding detail
    // without having to re-run CR CLI.
    process.stderr.write(result.stdout ?? '');
  }
  return decision.exitCode;
}

// Run main() only when invoked directly. Test imports of the pure
// helpers above must NOT trigger main() (the helpers are pure; main
// is the side-effecting orchestrator).
const invokedAsScript = process.argv[1] && /cr-precheck\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[cr-precheck] unexpected error:', err);
      process.exit(2);
    });
}
