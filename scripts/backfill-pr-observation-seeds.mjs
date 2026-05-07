#!/usr/bin/env node
/**
 * One-shot backfill: write pr-observation seed atoms for code-author
 * dispatches that landed before the substrate fix shipped.
 *
 * Substrate gap #8 part 2: until this PR shipped, the code-author
 * dispatch path emitted only a `code-author-invoked` atom and zero
 * `pr-observation` atoms. The pr-observation-refresh tick filters
 * strictly on `metadata.kind === 'pr-observation'`, so any plan
 * dispatched before the fix has a `pr_state: OPEN` (or no PR state
 * at all) record that the refresh tick cannot see, and the
 * pr-merge-reconcile loop therefore never closes the plan when the
 * PR merges.
 *
 * The fix in the runtime is forward-only (new dispatches write both
 * atoms). This script backfills history: scan every
 * `code-author-invoked` atom whose executor_result.kind === 'dispatched',
 * check if a corresponding pr-observation atom already exists for
 * the (owner, repo, number) tuple, and write a synthesized seed if
 * one is missing. Idempotent: re-running the script is a no-op when
 * every dispatch already has a seed.
 *
 * Usage:
 *
 *   # Dry-run (default unless --apply): classify-only, no writes.
 *   node scripts/backfill-pr-observation-seeds.mjs
 *
 *   # Apply: write the missing seeds.
 *   node scripts/backfill-pr-observation-seeds.mjs --apply
 *
 *   # Custom root (test fixtures, alternate workspace):
 *   LAG_ROOT=/path/to/repo node scripts/backfill-pr-observation-seeds.mjs --apply
 *
 * Exit codes:
 *   0 - scan completed (zero or more seeds written)
 *   1 - fatal error
 *
 * Output: a JSON summary on stdout for parseability:
 *   { scanned, seeded, skipped_already_exists, skipped_malformed }
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import { mkPrObservationSeedAtom } from '../dist/runtime/actor-message/pr-observation-seed.js';
import { parsePrHtmlUrl } from '../dist/external/github/parse-pr-url.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    rootDir: undefined,
  };
  const rootIdx = argv.findIndex((a) => a === '--root');
  if (rootIdx >= 0 && argv[rootIdx + 1]) {
    args.rootDir = argv[rootIdx + 1];
  } else if (process.env.LAG_ROOT) {
    args.rootDir = process.env.LAG_ROOT;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.rootDir ?? resolve(REPO_ROOT, '.lag');
  const host = await createFileHost({ rootDir });

  const summary = {
    scanned: 0,
    seeded: 0,
    skipped_already_exists: 0,
    skipped_malformed: 0,
    skipped_non_dispatched: 0,
    plans: [],
  };

  // Page through observation atoms and collect the
  // code-author-invoked ones with executor_result.kind === 'dispatched'.
  const PAGE_SIZE = 500;
  let cursor;
  /** @type {Array<{ atomId: string, planId: string, executorResult: any, observedAt: string, principalId: string }>} */
  const dispatched = [];
  /** @type {Map<string, true>} key = `${owner}/${repo}#${number}` */
  const existingSeeds = new Map();

  do {
    const page = await host.atoms.query({ type: ['observation'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      summary.scanned += 1;
      const meta = atom.metadata ?? {};
      // Catalog existing pr-observation atoms so we can skip seeding
      // when one already exists for the same (owner, repo, number).
      if (meta.kind === 'pr-observation') {
        const pr = meta.pr;
        if (pr && typeof pr.owner === 'string' && typeof pr.repo === 'string' && Number.isInteger(pr.number)) {
          existingSeeds.set(`${pr.owner}/${pr.repo}#${pr.number}`, true);
        }
        continue;
      }
      if (meta.kind !== 'code-author-invoked') continue;
      const exec = meta.executor_result;
      if (!exec || exec.kind !== 'dispatched') {
        summary.skipped_non_dispatched += 1;
        continue;
      }
      const planId = meta.plan_id;
      if (typeof planId !== 'string' || planId.length === 0) {
        summary.skipped_malformed += 1;
        continue;
      }
      dispatched.push({
        atomId: atom.id,
        planId,
        executorResult: {
          kind: 'dispatched',
          prNumber: exec.pr_number,
          prHtmlUrl: exec.pr_html_url,
          branchName: exec.branch_name,
          commitSha: exec.commit_sha,
          totalCostUsd: exec.total_cost_usd,
          modelUsed: exec.model_used,
          confidence: exec.confidence,
          touchedPaths: exec.touched_paths ?? [],
        },
        observedAt: atom.created_at,
        principalId: atom.principal_id,
      });
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  // Write a seed for each dispatched code-author-invoked that does
  // not already have a pr-observation atom for its (owner, repo,
  // number). parsePrHtmlUrl + the seed builder both throw on
  // malformed inputs; we catch and count as skipped_malformed
  // rather than abort the whole backfill (one corrupt history
  // record should not block the rest).
  for (const d of dispatched) {
    const url = d.executorResult.prHtmlUrl;
    let parsed;
    try {
      parsed = parsePrHtmlUrl(url);
    } catch (err) {
      summary.skipped_malformed += 1;
      continue;
    }
    const key = `${parsed.owner}/${parsed.repo}#${parsed.number}`;
    if (existingSeeds.has(key)) {
      summary.skipped_already_exists += 1;
      summary.plans.push({ plan_id: d.planId, pr: key, action: 'skipped-exists' });
      continue;
    }
    let seed;
    try {
      seed = mkPrObservationSeedAtom({
        principal: d.principalId,
        planId: d.planId,
        pr: parsed,
        headSha: d.executorResult.commitSha,
        observedAt: d.observedAt,
      });
    } catch (err) {
      summary.skipped_malformed += 1;
      continue;
    }
    if (args.apply) {
      try {
        await host.atoms.put(seed);
        summary.seeded += 1;
        existingSeeds.set(key, true);
        summary.plans.push({ plan_id: d.planId, pr: key, action: 'seeded' });
      } catch (err) {
        // Duplicate-id (id-collision) is benign: another path wrote
        // the same id in the meantime. Count as already-exists.
        if (err && /AlreadyExistsError|already exists/i.test(String(err.message || err))) {
          summary.skipped_already_exists += 1;
          summary.plans.push({ plan_id: d.planId, pr: key, action: 'skipped-collision' });
          continue;
        }
        throw err;
      }
    } else {
      // Dry-run: count as would-seed.
      summary.seeded += 1;
      summary.plans.push({ plan_id: d.planId, pr: key, action: 'would-seed' });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('backfill-pr-observation-seeds failed:', err);
  process.exit(1);
});
