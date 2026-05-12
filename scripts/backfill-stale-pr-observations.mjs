#!/usr/bin/env node
/**
 * One-shot heal: write fresh pr-observation atoms for PRs whose latest
 * observation is older than the configured staleness window AND whose
 * underlying PR has already transitioned to a terminal state on GitHub.
 *
 * Substrate gap (2026-05-11): the pr-observation refresh tick widened
 * its filter to handle terminal plan states (`succeeded`/`abandoned`),
 * so on a healthy loop tick every stale OPEN observation is healed
 * automatically. This script is the one-shot heal for an existing store
 * that accumulated stale rows BEFORE the widened filter shipped. Once
 * the loop tick has run once after this fix lands, this script is a
 * no-op (every stale row gets healed via the refresh tick), and the
 * script stays available as a manual-recovery tool for operators who
 * notice an inflated Pulse "awaiting merge" count.
 *
 * The script never mutates the existing stale atom: it writes a NEW
 * pr-observation atom dated `now` whose metadata reflects the live
 * GitHub state. Standard atom-store put semantics handle the
 * supersession: a future query that picks the LATEST observation by
 * created_at sees the fresh one, while audit walks over the chain
 * still resolve the original. This preserves atomicity per the
 * substrate's append-only invariant.
 *
 * Usage:
 *
 *   # Dry-run (default unless --apply): classify-only, no writes.
 *   node scripts/backfill-stale-pr-observations.mjs
 *
 *   # Apply: write the heal atoms for every stale row.
 *   node scripts/backfill-stale-pr-observations.mjs --apply
 *
 *   # Override staleness window (default reads pol-pr-observation-
 *   # staleness-ms canon atom, falls back to 1 hour):
 *   node scripts/backfill-stale-pr-observations.mjs --staleness-ms 1800000
 *
 *   # Explicit root via --root flag (overrides LAG_ROOT env var):
 *   node scripts/backfill-stale-pr-observations.mjs --root /path/to/.lag --apply
 *
 *   # Per-PR GitHub query timeout (default 10s):
 *   node scripts/backfill-stale-pr-observations.mjs --pr-timeout-ms 5000
 *
 *   # Bot identity for GitHub queries (default lag-ceo):
 *   node scripts/backfill-stale-pr-observations.mjs --bot lag-ceo
 *
 * Exit codes:
 *   0 - scan completed (zero or more atoms written; success regardless
 *       of count, by design -- the script reports the count via a JSON
 *       summary on stdout. The operator interprets the count, not the
 *       exit code, because exit==0 means "scan ran cleanly", not
 *       "store is now healed").
 *   1 - fatal error (couldn't read atoms, unrecoverable GitHub failure,
 *       malformed canon)
 *
 * Output: a JSON summary on stdout for parseability. See the lib
 * module for the schema.
 *
 * Pure helpers (parseArgs, resolveStalenessMs, queryPrState,
 * buildHealAtom) live at scripts/lib/backfill-stale-pr-observations.mjs
 * so the test runner imports a shebang-free module (vitest on
 * Windows-CI fails to strip shebangs from imported `.mjs` files;
 * canon feedback_shebang_import_from_tests).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import { mkPrObservationAtomId } from '../dist/runtime/atoms/pr-observation-id.js';
import {
  DEFAULT_STALENESS_MS,
  DEFAULT_PR_TIMEOUT_MS,
  buildHealAtom as buildHealAtomImpl,
  parseArgs,
  queryPrState,
  resolveStalenessMs,
} from './lib/backfill-stale-pr-observations.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Re-export the pure helpers so callers (and tests, which import the
// shebang-free lib module directly) can pin the same contract.
export { DEFAULT_STALENESS_MS, DEFAULT_PR_TIMEOUT_MS, parseArgs, queryPrState, resolveStalenessMs };

/**
 * Production-mode buildHealAtom: thin wrapper that supplies the canonical
 * mkPrObservationAtomId from the dist tree. Tests import the lib version
 * directly and inject a stub generator.
 *
 * @param {{
 *   stale: any,
 *   live: { state: 'MERGED' | 'CLOSED' | 'OPEN', mergedAt: string | null, mergeCommitSha: string | null, headSha: string },
 *   nowIso: string,
 * }} inputs
 */
export function buildHealAtom(inputs) {
  return buildHealAtomImpl({ ...inputs, mkPrObservationAtomId });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.rootDir ?? resolve(REPO_ROOT, '.lag');
  const host = await createFileHost({ rootDir });

  const summary = {
    scanned: 0,
    stale: 0,
    terminal_on_github: 0,
    refreshed: 0,
    skipped_malformed: 0,
    skipped_already_fresh: 0,
    skipped_already_terminal: 0,
    skipped_pr_still_open: 0,
    skipped_pr_query_failed: 0,
    refreshed_atoms: [],
  };

  // Pre-load directives so resolveStalenessMs can scan canon.
  const allAtoms = [];
  const PAGE_SIZE = 500;
  let cursor;
  do {
    const page = await host.atoms.query({}, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      allAtoms.push(atom);
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  const stalenessMs = resolveStalenessMs(allAtoms, args.stalenessMsOverride);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Pass 1: dedupe -- for each PR (owner/repo#number), find the LATEST
  // observation by created_at. We only consider that latest atom; an
  // older atom in the chain is already-superseded by the latest, and
  // healing an older one would create a new latest atom referring to
  // a path that's no longer the active state.
  const latestByPr = new Map();
  for (const atom of allAtoms) {
    if (atom.type !== 'observation') continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    if (atom.superseded_by && atom.superseded_by.length > 0) continue;
    const meta = atom.metadata ?? {};
    if (meta.kind !== 'pr-observation') continue;
    const pr = meta.pr;
    if (!pr || typeof pr !== 'object') continue;
    if (typeof pr.owner !== 'string' || typeof pr.repo !== 'string') continue;
    if (!Number.isInteger(pr.number) || pr.number <= 0) continue;
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const prior = latestByPr.get(key);
    if (prior === undefined || atom.created_at > prior.created_at) {
      latestByPr.set(key, atom);
    }
  }

  // Pass 2: for each latest observation, classify and (when warranted)
  // heal. The classification ladder is intentionally explicit so the
  // summary counts add up to scanned exactly; every atom hits exactly
  // one branch.
  for (const atom of latestByPr.values()) {
    summary.scanned += 1;
    const meta = atom.metadata ?? {};
    const prState = meta.pr_state;
    if (typeof prState === 'string' && (prState === 'MERGED' || prState === 'CLOSED')) {
      summary.skipped_already_terminal += 1;
      continue;
    }
    const observedAtRaw = meta.observed_at;
    if (typeof observedAtRaw !== 'string') {
      summary.skipped_malformed += 1;
      continue;
    }
    const observedAtMs = Date.parse(observedAtRaw);
    if (!Number.isFinite(observedAtMs)) {
      summary.skipped_malformed += 1;
      continue;
    }
    if (Number.isFinite(stalenessMs) && (nowMs - observedAtMs) < stalenessMs) {
      summary.skipped_already_fresh += 1;
      continue;
    }
    summary.stale += 1;
    const pr = meta.pr;
    const live = await queryPrState(
      { owner: pr.owner, repo: pr.repo, number: pr.number },
      { bot: args.bot, prTimeoutMs: args.prTimeoutMs },
    );
    if (live === null) {
      summary.skipped_pr_query_failed += 1;
      continue;
    }
    if (live.state === 'OPEN') {
      summary.skipped_pr_still_open += 1;
      continue;
    }
    summary.terminal_on_github += 1;
    const healAtom = buildHealAtom({ stale: atom, live, nowIso });
    if (args.apply) {
      await host.atoms.put(healAtom);
    }
    summary.refreshed += 1;
    summary.refreshed_atoms.push({
      pr_number: pr.number,
      before_state: prState ?? 'UNKNOWN',
      after_state: live.state,
      atom_id: healAtom.id,
      ...(args.apply ? { applied: true } : { dry_run: true }),
    });
  }

  const out = {
    apply: args.apply,
    staleness_ms: Number.isFinite(stalenessMs) ? stalenessMs : 'Infinity',
    now: nowIso,
    ...summary,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  // Exit code is always 0 on a successful scan; the count is reported
  // via the JSON summary, not the exit code. See the script doc-comment.
  process.exit(0);
}

// Allow this module to be imported by tests without auto-executing.
const isDirectInvocation = (() => {
  try {
    return resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(
      `[backfill-stale-pr-observations] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
