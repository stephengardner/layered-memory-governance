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
 *         severity in "critical" | "major" | "minor" (extra labels treated as minor)
 *     - {"type":"complete", status, findings}
 *     - {"type":"error", errorType, message, recoverable, details}
 *
 * Pure helpers (findCoderabbitOnPath, parseCrCliAgentFindings,
 * isCliErrorResult, decideExitCode) live at scripts/lib/cr-precheck.mjs
 * so the test runner imports a shebang-free module (vitest on
 * Windows-CI fails to strip shebangs from imported `.mjs` files;
 * PR #123 landed the same split for git-as helpers).
 */

import { execSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  findCoderabbitOnPath,
  parseCrCliAgentFindings,
  isCliErrorResult,
  decideExitCode,
} from './lib/cr-precheck.mjs';
import { resolveStateDir } from './lib/resolve-state-dir.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolveStateDir(REPO_ROOT);

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
  // (spec section 3.1 step 2) so the audit log does not fill with empty-diff noise.
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
