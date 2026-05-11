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
 * Output: a JSON summary on stdout for parseability:
 *   {
 *     scanned,                       // total pr-observation atoms inspected
 *     stale,                         // observations older than staleness window
 *     terminal_on_github,            // PRs that GitHub reports MERGED/CLOSED
 *     refreshed,                     // heal atoms written (or would write in dry-run)
 *     skipped_malformed,             // atoms with bad metadata
 *     skipped_already_fresh,         // observation is fresh (under threshold)
 *     skipped_already_terminal,      // observation already shows MERGED/CLOSED
 *     skipped_pr_still_open,         // GitHub reports OPEN -- no heal needed
 *     skipped_pr_query_failed,       // GitHub query errored or timed out
 *     refreshed_atoms: [ {pr_number, before_state, after_state, atom_id }, ... ]
 *   }
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { createFileHost } from '../dist/adapters/file/index.js';
import { mkPrObservationAtomId } from '../dist/runtime/atoms/pr-observation-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Default staleness window: 1 hour. Matches the synthesizer default. */
export const DEFAULT_STALENESS_MS = 60 * 60 * 1_000;

/** Default per-PR GitHub query timeout: 10 seconds. */
export const DEFAULT_PR_TIMEOUT_MS = 10_000;

/**
 * Parse argv into a structured options bag. Exposed for unit testing
 * so the tests can pin the contract without spawning a subprocess.
 *
 * @param {ReadonlyArray<string>} argv  argv slice WITHOUT `node script.mjs`
 * @returns {{
 *   apply: boolean,
 *   rootDir: string | undefined,
 *   stalenessMsOverride: number | undefined,
 *   prTimeoutMs: number,
 *   bot: string,
 * }}
 */
export function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    rootDir: undefined,
    stalenessMsOverride: undefined,
    prTimeoutMs: DEFAULT_PR_TIMEOUT_MS,
    bot: 'lag-ceo',
  };
  const rootIdx = argv.findIndex((a) => a === '--root');
  if (rootIdx >= 0 && argv[rootIdx + 1]) {
    args.rootDir = argv[rootIdx + 1];
  } else if (process.env.LAG_ROOT) {
    args.rootDir = process.env.LAG_ROOT;
  }
  const stalenessIdx = argv.findIndex((a) => a === '--staleness-ms');
  if (stalenessIdx >= 0 && argv[stalenessIdx + 1]) {
    const v = Number(argv[stalenessIdx + 1]);
    if (Number.isFinite(v) && v > 0) {
      args.stalenessMsOverride = v;
    }
  }
  const timeoutIdx = argv.findIndex((a) => a === '--pr-timeout-ms');
  if (timeoutIdx >= 0 && argv[timeoutIdx + 1]) {
    const v = Number(argv[timeoutIdx + 1]);
    if (Number.isFinite(v) && v > 0) {
      args.prTimeoutMs = v;
    }
  }
  const botIdx = argv.findIndex((a) => a === '--bot');
  if (botIdx >= 0 && argv[botIdx + 1]) {
    args.bot = argv[botIdx + 1];
  }
  return args;
}

/**
 * Read the staleness window from the canon atom set. Returns the
 * configured ms value, the override (when supplied), or
 * DEFAULT_STALENESS_MS.
 *
 * Pure: takes the atom array and returns a number. Exposed for tests.
 *
 * Mirrors the framework-side `readPrObservationStalenessMs` in the
 * Console synthesizer (apps/console/server/intent-outcome.ts).
 *
 * @param {ReadonlyArray<unknown>} atoms
 * @param {number | undefined} override
 * @returns {number}
 */
export function resolveStalenessMs(atoms, override) {
  if (Number.isFinite(override) && override > 0) return override;
  for (const atom of atoms) {
    if (!atom || typeof atom !== 'object') continue;
    if (atom.type !== 'directive') continue;
    if (atom.layer !== undefined && atom.layer !== 'L3') continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    if (atom.superseded_by && atom.superseded_by.length > 0) continue;
    const meta = atom.metadata ?? {};
    const policy = meta.policy;
    if (!policy) continue;
    if (policy.subject !== 'pr-observation-staleness-ms') continue;
    const raw = policy.staleness_ms ?? policy.value;
    if (raw === 'Infinity') return Number.POSITIVE_INFINITY;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    return raw;
  }
  return DEFAULT_STALENESS_MS;
}

/**
 * Query GitHub for the live PR state. Returns null on timeout or
 * subprocess error so a single stuck PR does not halt the script.
 *
 * Per-PR timeout is enforced by killing the subprocess after the
 * configured budget.
 *
 * @param {{ owner: string, repo: string, number: number }} pr
 * @param {{ bot: string, prTimeoutMs: number }} opts
 * @returns {Promise<{ state: 'MERGED' | 'CLOSED' | 'OPEN', mergedAt: string | null, mergeCommitSha: string | null, headSha: string } | null>}
 */
export async function queryPrState(pr, opts) {
  const { bot, prTimeoutMs } = opts;
  const ghAsPath = resolve(__dirname, 'gh-as.mjs');
  try {
    const result = await execa('node', [
      ghAsPath,
      bot,
      'pr',
      'view',
      String(pr.number),
      '--repo', `${pr.owner}/${pr.repo}`,
      '--json',
      'state,mergedAt,mergeCommit,headRefOid',
    ], {
      timeout: prTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if (result.exitCode !== 0) return null;
    const raw = (result.stdout ?? '').toString().trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.state !== 'string') return null;
    const state = parsed.state.toUpperCase();
    if (state !== 'MERGED' && state !== 'CLOSED' && state !== 'OPEN') {
      return null;
    }
    return {
      state,
      mergedAt: typeof parsed.mergedAt === 'string' ? parsed.mergedAt : null,
      mergeCommitSha: parsed.mergeCommit && typeof parsed.mergeCommit.oid === 'string'
        ? parsed.mergeCommit.oid
        : null,
      headSha: typeof parsed.headRefOid === 'string' && parsed.headRefOid.length > 0
        ? parsed.headRefOid
        : '',
    };
  } catch {
    // Timeout, JSON parse error, missing gh-as -- all treat as "couldn't
    // query". The script reports the skip in the summary; the operator
    // re-runs after fixing the transport issue.
    return null;
  }
}

/**
 * Build the fresh pr-observation atom that supersedes the stale one.
 *
 * Pure: takes structured inputs and returns the atom object. Exposed
 * for tests so a backfill heal can be verified without spawning the
 * full script.
 *
 * @param {{
 *   stale: any,
 *   live: { state: 'MERGED' | 'CLOSED' | 'OPEN', mergedAt: string | null, mergeCommitSha: string | null, headSha: string },
 *   nowIso: string,
 * }} inputs
 * @returns {object}
 */
export function buildHealAtom(inputs) {
  const { stale, live, nowIso } = inputs;
  const staleMeta = stale.metadata ?? {};
  const pr = staleMeta.pr;
  const planId = staleMeta.plan_id;
  // headSha priority: live > staleMeta.head_sha > 'unknown'. Empty
  // string is the seam between "we know nothing" and the atom-id
  // generator; the generator slices the first 12 chars so an empty
  // input collapses to a stable 'unknown' bucket.
  const headSha = live.headSha.length > 0
    ? live.headSha
    : (typeof staleMeta.head_sha === 'string' && staleMeta.head_sha.length > 0
      ? staleMeta.head_sha
      : 'unknown');
  const atomId = mkPrObservationAtomId(
    pr.owner,
    pr.repo,
    pr.number,
    headSha,
    nowIso,
  );
  // Note: backfill-heal carries `partial: true` and `partial_surfaces:
  // ['all']` because the gh pr view query gives state + mergedAt +
  // mergeCommitSha but NOT the full review-tree (counts, reviews,
  // check-runs). A later full re-observation (run-pr-landing.mjs
  // --observe-only) hydrates those surfaces.
  return {
    schema_version: 1,
    id: atomId,
    content: [
      `**pr-observation heal for ${pr.owner}/${pr.repo}#${pr.number}** (substrate backfill)`,
      '',
      `observed_at: ${nowIso}`,
      `head_sha: \`${headSha}\``,
      `pr_state: ${live.state}`,
      live.mergedAt ? `merged_at: ${live.mergedAt}` : null,
      live.mergeCommitSha ? `merge_commit_sha: \`${live.mergeCommitSha}\`` : null,
      `plan_id: ${planId ?? '(none)'}`,
      'partial: true (backfill heal; full review tree not re-queried)',
      '',
      'Backfill rationale: the prior observation atom for this PR was',
      'older than the staleness window AND GitHub reports the PR in a',
      'terminal state. This atom supersedes the stale row so consumers',
      `(intent-outcome synthesizer, Pulse tile) see the live state.`,
    ].filter((line) => line !== null).join('\n'),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: 'backfill-stale-pr-observations',
        tool: 'backfill-stale-pr-observations',
      },
      // Chain through the stale atom AND the original plan so an audit
      // walk lands on both. The stale atom is the prior observation;
      // chaining to it preserves the supersession history.
      derived_from: [
        stale.id,
        ...(typeof planId === 'string' ? [planId] : []),
      ],
    },
    confidence: 0.85,
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [stale.id],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'pr-landing-agent',
    taint: 'clean',
    metadata: {
      kind: 'pr-observation',
      pr: { owner: pr.owner, repo: pr.repo, number: pr.number },
      head_sha: headSha,
      observed_at: nowIso,
      pr_state: live.state,
      ...(planId ? { plan_id: planId } : {}),
      partial: true,
      partial_surfaces: ['all'],
      counts: {
        line_comments: 0,
        body_nits: 0,
        submitted_reviews: 0,
        check_runs: 0,
        legacy_statuses: 0,
      },
      mergeable: null,
      merge_state_status: null,
      ...(live.mergedAt ? { merged_at: live.mergedAt } : {}),
      ...(live.mergeCommitSha ? { merge_commit_sha: live.mergeCommitSha } : {}),
      backfill: {
        reason: 'staleness-window-exceeded-pr-terminal-on-github',
        superseded_atom_id: stale.id,
        backfilled_at: nowIso,
      },
    },
  };
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

  // Pass 1: dedupe — for each PR (owner/repo#number), find the LATEST
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
