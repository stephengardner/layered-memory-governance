#!/usr/bin/env node
/**
 * Plan staleness reaper driver.
 *
 * Sweeps every proposed plan atom in the FileHost atom store, classifies
 * it against the TTLs (defaults: 24h warn / 72h auto-abandon), and
 * transitions abandon-bucket plans to `abandoned` via the existing
 * plan state-machine helper. Each transition emits an audit event;
 * the run summary lands on stdout for operator visibility.
 *
 * Usage:
 *
 *   # Default thresholds (24h warn / 72h abandon):
 *   node scripts/reap-stale-plans.mjs
 *
 *   # Custom thresholds via env var (milliseconds):
 *   LAG_REAPER_WARN_MS=43200000 LAG_REAPER_ABANDON_MS=259200000 \
 *     node scripts/reap-stale-plans.mjs
 *
 *   # Dry-run mode: classify-only, no transitions written:
 *   node scripts/reap-stale-plans.mjs --dry-run
 *
 * Exit codes:
 *   0 - sweep completed (zero or more abandons applied)
 *   1 - fatal error
 *   2 - kill switch active (.lag/STOP present)
 *
 * Kill switch: respects `.lag/STOP`. The driver halts before any
 * mutation when the sentinel exists, per `inv-kill-switch-first`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import {
  classifyPlans,
  loadAllProposedPlans,
  runReaperSweep,
  DEFAULT_REAPER_TTLS,
} from '../dist/runtime/plans/reaper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/*
 * Principal that the reaper attributes its abandonment transitions to
 * in the audit log. Defaults to `apex-agent` (already registered in
 * every LAG instance) because:
 *   1. The reaper is operator-policy execution: the operator
 *      authorized the TTL by invoking the script; apex-agent is the
 *      operator's principal of record.
 *   2. Picking a bespoke `plan-reaper` id would require seeding a new
 *      principal entry on every fresh install, which contradicts the
 *      indie-floor zero-config goal.
 * Override via --principal or LAG_REAPER_PRINCIPAL when a deployment
 * registers a dedicated reaper principal and wants the audit chain to
 * cite it explicitly.
 */
const DEFAULT_REAPER_PRINCIPAL = 'apex-agent';

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    rootDir: undefined,
    principal: undefined,
  };
  const rootIdx = argv.findIndex((a) => a === '--root');
  if (rootIdx >= 0 && argv[rootIdx + 1]) {
    args.rootDir = argv[rootIdx + 1];
  } else if (process.env.LAG_ROOT) {
    args.rootDir = process.env.LAG_ROOT;
  }
  const principalIdx = argv.findIndex((a) => a === '--principal');
  if (principalIdx >= 0 && argv[principalIdx + 1]) {
    args.principal = argv[principalIdx + 1];
  } else if (process.env.LAG_REAPER_PRINCIPAL) {
    args.principal = process.env.LAG_REAPER_PRINCIPAL;
  }
  return args;
}

function parseEnvTtls() {
  const warnRaw = process.env.LAG_REAPER_WARN_MS;
  const abandonRaw = process.env.LAG_REAPER_ABANDON_MS;
  const ttls = {
    staleWarnMs: warnRaw !== undefined ? Number(warnRaw) : DEFAULT_REAPER_TTLS.staleWarnMs,
    staleAbandonMs:
      abandonRaw !== undefined ? Number(abandonRaw) : DEFAULT_REAPER_TTLS.staleAbandonMs,
  };
  // Require positive integer milliseconds. Number('12.5') and
  // Number('1e3') pass Number.isFinite but neither is a meaningful
  // operator-set ms; treating fractional / scientific values as
  // typos matches the fence-validation idiom used in PR #74 fence
  // atoms and elsewhere in the repo.
  const isPositiveIntMs = (n) =>
    typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0;
  if (!isPositiveIntMs(ttls.staleWarnMs)) {
    throw new Error(`Invalid LAG_REAPER_WARN_MS: ${warnRaw} (must be positive integer ms)`);
  }
  if (!isPositiveIntMs(ttls.staleAbandonMs) || ttls.staleAbandonMs <= ttls.staleWarnMs) {
    throw new Error(
      `Invalid LAG_REAPER_ABANDON_MS: must be a positive integer ms greater than warn (warn=${ttls.staleWarnMs}, abandon=${ttls.staleAbandonMs})`,
    );
  }
  return ttls;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ttls = parseEnvTtls();

  const rootDir = args.rootDir ?? resolve(REPO_ROOT, '.lag');
  /*
   * Kill-switch sentinel lives inside the resolved store root, not
   * REPO_ROOT, so a sweep targeting an alternate atom store (--root
   * or LAG_ROOT) honors that store's own STOP. Per inv-kill-switch-
   * first the gate halts before any mutation, so we check it BEFORE
   * constructing the host.
   */
  const stopSentinel = resolve(rootDir, 'STOP');
  if (existsSync(stopSentinel)) {
    console.error(`[plan-reaper] STOP sentinel present at ${stopSentinel}; halting before any sweep.`);
    // Exit 2 (governance halt, expected) so shell pipelines can
    // distinguish "STOP armed" from "code threw"; matches the
    // run-pr-landing.mjs convention.
    process.exit(2);
  }

  const host = await createFileHost({ rootDir });

  const warnHours = Math.round(ttls.staleWarnMs / 3600000);
  const abandonHours = Math.round(ttls.staleAbandonMs / 3600000);
  console.log(
    `[plan-reaper] sweep starting (warn=${warnHours}h abandon=${abandonHours}h dryRun=${args.dryRun})`,
  );

  /*
   * Two-phase: in dry-run we only classify; in live mode we
   * classify + apply via runReaperSweep. The classify-only path is
   * useful for operator-visibility ("what WOULD be reaped if I ran
   * for real?") and as a non-mutating audit before raising the
   * autonomy dial.
   */
  if (args.dryRun) {
    // Reuse the substrate-exported helper so the script stays a
    // thin driver - if the helper grows (e.g., truncation surfacing,
    // see RunReaperSweepResult.truncated) the script tracks it.
    const { atoms, truncated } = await loadAllProposedPlans(host);
    const nowMs = Date.parse(host.clock.now());
    const c = classifyPlans(atoms, nowMs, ttls);
    console.log(
      `[plan-reaper] DRY RUN: fresh=${c.fresh.length} warn=${c.warn.length} would-abandon=${c.abandon.length}${truncated ? ' (TRUNCATED - more atoms remain)' : ''}`,
    );
    for (const entry of c.abandon) {
      const ageHours = Math.floor(entry.ageMs / 3600000);
      console.log(`  would-abandon: ${entry.atomId} (age=${ageHours}h)`);
    }
    return;
  }

  const principal = args.principal ?? DEFAULT_REAPER_PRINCIPAL;
  const out = await runReaperSweep(host, principal, ttls);
  console.log(
    `[plan-reaper] classified: fresh=${out.classifications.fresh.length} warn=${out.classifications.warn.length} abandon=${out.classifications.abandon.length}${out.truncated ? ' (TRUNCATED - more atoms remain; will pick up next run)' : ''}`,
  );
  console.log(
    `[plan-reaper] applied: abandoned=${out.apply.abandoned.length} skipped=${out.apply.skipped.length}`,
  );
  for (const entry of out.apply.abandoned) {
    console.log(`  abandoned: ${entry.atomId} (age=${entry.ageHours}h)`);
  }
  for (const entry of out.apply.skipped) {
    console.log(`  skipped: ${entry.atomId} (${entry.error})`);
  }
}

main().catch((err) => {
  console.error('[plan-reaper] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
