#!/usr/bin/env node
/**
 * cr-precheck-audit: query companion that lists `cr-precheck-skip`
 * and `cr-precheck-run` audit atoms newest-first.
 *
 * Read-only against the project AtomStore (`.lag/atoms/`). Surfaces
 * gate-skip drift before it becomes culture: every push that bypassed
 * cr-precheck (CR CLI not on PATH, or CR CLI errored) writes a skip
 * atom; every push that ran the gate writes a run atom. Operator runs
 * this script to scan the audit trail.
 *
 * Usage:
 *   node scripts/cr-precheck-audit.mjs                   # last 50, all kinds
 *   node scripts/cr-precheck-audit.mjs --since 24h       # last 24 hours
 *   node scripts/cr-precheck-audit.mjs --kind skip       # skip atoms only
 *   node scripts/cr-precheck-audit.mjs --kind run        # run atoms only
 *   node scripts/cr-precheck-audit.mjs --limit 100       # bump cap
 *   node scripts/cr-precheck-audit.mjs --since 7d --kind skip --limit 200
 *
 * Duration suffixes: s (seconds), m (minutes), h (hours), d (days),
 * y (years; approximated as 365 days). Arbitrary suffixes (w for
 * weeks, calendar months) are intentionally not supported so the
 * parser fails closed on typos rather than silently widening the
 * window.
 *
 * Atom shape consumed (matches `scripts/cr-precheck.mjs`):
 *   type='observation', layer='L0', scope='project'
 *   metadata.kind = 'cr-precheck-skip' | 'cr-precheck-run'
 *   metadata.cr_precheck_skip.captured_at OR metadata.cr_precheck_run.captured_at
 *
 * Exit codes:
 *   0 - query completed (zero or more rows printed)
 *   1 - bad arguments OR atom-store read failure
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

// Duration unit -> milliseconds. Year is approximated as 365 days; the
// audit window is intentionally coarse (skip-rate + drift signal), not
// a calendar-accurate range. Weeks and calendar months are excluded so
// a typo (`24w`) fails the parser instead of silently widening to a
// week of skips the operator did not intend to surface.
const DURATION_UNITS = Object.freeze({
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
});

/**
 * Parse a duration string like '24h', '7d', '1y' to milliseconds.
 * Returns null on:
 *   - missing or unsupported suffix
 *   - non-numeric magnitude
 *   - zero or negative magnitude (a zero/negative window is meaningless
 *     for a "since" query and almost always indicates a caller bug)
 *
 * Returning null rather than throwing keeps the helper composable; the
 * CLI surface translates null into a loud arg error one level up.
 */
export function parseDuration(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  const m = /^(-?\d+)([a-z])$/i.exec(input.trim());
  if (m === null) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = DURATION_UNITS[m[2].toLowerCase()];
  if (unit === undefined) return null;
  return n * unit;
}

/**
 * Extract the captured_at ISO string from a cr-precheck-* atom. The
 * timestamp lives under either `metadata.cr_precheck_skip.captured_at`
 * or `metadata.cr_precheck_run.captured_at` depending on the kind.
 *
 * Returns null when the discriminator is missing OR the matching
 * payload key is absent. A null return drops the atom out of duration
 * filtering rather than crashing on a drifted / hostile atom shape.
 */
export function getCapturedAt(atom) {
  const kind = atom?.metadata?.kind;
  if (kind === 'cr-precheck-skip') {
    return atom?.metadata?.cr_precheck_skip?.captured_at ?? null;
  }
  if (kind === 'cr-precheck-run') {
    return atom?.metadata?.cr_precheck_run?.captured_at ?? null;
  }
  return null;
}

function isCrPrecheckKind(kind, filter) {
  if (filter === 'all') return kind === 'cr-precheck-skip' || kind === 'cr-precheck-run';
  if (filter === 'skip') return kind === 'cr-precheck-skip';
  if (filter === 'run') return kind === 'cr-precheck-run';
  return false;
}

/**
 * Pure filter + sort over a candidate atom list. The split between
 * this and queryAuditAtoms keeps the pure logic unit-testable without
 * spinning up a host; queryAuditAtoms is the I/O wrapper.
 *
 * Filter order: kind discriminator first, then duration window, then
 * sort by captured_at desc, then truncate to limit. Filtering before
 * sorting keeps the sort cheap when the corpus is dominated by
 * unrelated observation atoms.
 */
export function filterAndSortAuditAtoms(atoms, opts) {
  const { kind, sinceMs, limit, now } = opts;
  const cutoff = sinceMs === null || sinceMs === undefined ? null : now - sinceMs;
  const matched = [];
  for (const atom of atoms) {
    const k = atom?.metadata?.kind;
    if (!isCrPrecheckKind(k, kind)) continue;
    const ts = getCapturedAt(atom);
    if (cutoff !== null) {
      if (ts === null) continue;
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs < cutoff) continue;
    }
    matched.push(atom);
  }
  matched.sort((a, b) => {
    const ta = getCapturedAt(a) ?? '';
    const tb = getCapturedAt(b) ?? '';
    return tb.localeCompare(ta);
  });
  return matched.slice(0, limit);
}

/**
 * Format one audit atom as a one-line stdout row. Skip rows expose
 * the reason + commit + os; run rows expose the finding counts +
 * cli version + commit. The format is operator-readable, not
 * machine-parseable: callers wanting structured data read atoms
 * directly via the AtomStore.
 */
export function formatAuditLine(atom) {
  const kind = atom?.metadata?.kind;
  const ts = getCapturedAt(atom) ?? '<no-ts>';
  if (kind === 'cr-precheck-skip') {
    const p = atom?.metadata?.cr_precheck_skip ?? {};
    const reason = p.reason ?? 'unknown';
    const sha = (p.commit_sha ?? 'unknown').slice(0, 7);
    const os = p.os ?? '?';
    return `${ts}  skip   ${reason.padEnd(24, ' ')} ${sha}  os=${os}`;
  }
  if (kind === 'cr-precheck-run') {
    const p = atom?.metadata?.cr_precheck_run ?? {};
    const f = p.findings ?? { critical: 0, major: 0, minor: 0 };
    const sha = (p.commit_sha ?? 'unknown').slice(0, 7);
    const ver = p.cli_version ?? '?';
    return `${ts}  run    c=${f.critical ?? 0} m=${f.major ?? 0} n=${f.minor ?? 0}            ${sha}  v${ver}`;
  }
  return `${ts}  unknown-kind ${String(kind)}`;
}

/**
 * I/O wrapper. Queries the host for project-scope observation atoms
 * once and runs the pure filter over the result. The query filter
 * narrows on substrate-level fields (type + scope) so the host loads
 * fewer atoms; the kind discriminator lives on metadata, which the
 * AtomFilter does not index, so post-filter is unavoidable for that
 * dimension.
 */
export async function queryAuditAtoms(host, opts) {
  // Pull a generous batch and post-filter; cr-precheck atoms accumulate
  // slowly (one per push at most) so a single-page read is sufficient
  // for any realistic operator window. If a deployment grows past this,
  // the audit script becomes a follow-up; this is the indie-floor sizing.
  const READ_BATCH = 5000;
  const { atoms } = await host.atoms.query(
    { type: ['observation'], scope: ['project'] },
    READ_BATCH,
  );
  return filterAndSortAuditAtoms(atoms, opts);
}

/**
 * CLI argument parser. Returns a typed-by-shape object the caller
 * threads into validateAuditArgs + queryAuditAtoms. Unknown flags
 * fail loud (process.exit(2)) so a typo never silently widens the
 * query.
 */
export function parseAuditArgs(argv) {
  const args = { since: null, kind: 'all', limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') args.since = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: see header docstring in scripts/cr-precheck-audit.mjs');
      process.exit(0);
    } else {
      console.error(`[cr-precheck-audit] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function validateAuditArgs(args) {
  const errs = [];
  if (args.kind !== 'skip' && args.kind !== 'run' && args.kind !== 'all') {
    errs.push(`--kind must be 'skip', 'run', or 'all'; got ${JSON.stringify(args.kind)}`);
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    errs.push(`--limit must be a positive integer; got ${JSON.stringify(args.limit)}`);
  }
  let sinceMs = null;
  if (args.since !== null && args.since !== undefined) {
    sinceMs = parseDuration(args.since);
    if (sinceMs === null) {
      errs.push(`--since must be a positive duration like 24h, 7d, 1y; got ${JSON.stringify(args.since)}`);
    }
  }
  return { errs, sinceMs };
}

async function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  const { errs, sinceMs } = validateAuditArgs(args);
  if (errs.length > 0) {
    for (const e of errs) console.error(`[cr-precheck-audit] ${e}`);
    return 1;
  }

  let host;
  try {
    host = await createFileHost({ rootDir: STATE_DIR });
  } catch (err) {
    console.error(`[cr-precheck-audit] failed to open atom store at ${STATE_DIR}: ${err?.message ?? err}`);
    return 1;
  }

  let rows;
  try {
    rows = await queryAuditAtoms(host, {
      kind: args.kind,
      sinceMs,
      limit: args.limit,
      now: Date.now(),
    });
  } catch (err) {
    console.error(`[cr-precheck-audit] failed to read atoms: ${err?.message ?? err}`);
    return 1;
  }

  if (rows.length === 0) {
    const window = args.since ? ` in the last ${args.since}` : '';
    const filter = args.kind === 'all' ? '' : ` (kind=${args.kind})`;
    console.error(`[cr-precheck-audit] no cr-precheck atoms found${window}${filter}.`);
    return 0;
  }

  for (const atom of rows) {
    process.stdout.write(`${formatAuditLine(atom)}\n`);
  }
  return 0;
}

// Run main() only when invoked directly. Test imports of the pure
// helpers above must NOT trigger main() (the helpers are pure; main
// is the side-effecting orchestrator).
const invokedAsScript =
  process.argv[1] && /cr-precheck-audit\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[cr-precheck-audit] unexpected error:', err);
      process.exit(2);
    });
}
