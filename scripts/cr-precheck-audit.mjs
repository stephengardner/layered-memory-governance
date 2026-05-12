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
 *
 * Pure helpers (parseDuration, getCapturedAt, filterAndSortAuditAtoms,
 * formatAuditLine, queryAuditAtoms, parseAuditArgs) live at
 * scripts/lib/cr-precheck-audit.mjs so the test runner imports a
 * shebang-free module (vitest on Windows-CI fails to strip shebangs
 * from imported `.mjs` files; PR #123 landed the same split for
 * git-as helpers).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  parseDuration,
  formatAuditLine,
  queryAuditAtoms,
  parseAuditArgs,
} from './lib/cr-precheck-audit.mjs';
import { resolveStateDir } from './lib/resolve-state-dir.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolveStateDir(REPO_ROOT);

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
