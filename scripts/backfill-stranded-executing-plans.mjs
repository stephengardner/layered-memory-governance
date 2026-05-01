#!/usr/bin/env node
/**
 * One-shot backfill for plans stranded in plan_state='executing' before
 * the substrate fix that maps InvokeResult.kind='dispatched' to
 * terminal_kind='succeeded'.
 *
 * Pre-fix posture: when an autonomous-dispatch / code-author invoker
 * returned `kind: 'dispatched'` after opening a PR, the dispatcher
 * deliberately left the plan in 'executing' on the assumption that a
 * downstream PR-merge reaper would close it. No such reaper was ever
 * built, so every successful autonomous-dispatch run since PR #270
 * stranded its plan in 'executing' forever.
 *
 * Post-fix posture (this PR): runDispatchTick stamps the terminal
 * transition synchronously when `kind: 'dispatched'` lands, so all
 * future runs are clean. Plans already stranded need a one-shot
 * sweep to bring them into the new shape.
 *
 * What this script does:
 *   1. Walks .lag/atoms/plan-*.json (the file-backed store; the script
 *      stays read-only for any non-file-backed adapter).
 *   2. Filters to plan_state='executing' AND metadata.dispatch_result.kind='dispatched'
 *      AND no terminal_at/terminal_kind already stamped.
 *   3. Stamps terminal_at + terminal_kind='succeeded' + (when the
 *      summary carries one) dispatch_pr_number + dispatch_pr_summary.
 *   4. Flips plan_state to 'succeeded'.
 *   5. Prints a summary so the operator can verify the sweep.
 *
 * Invariants preserved:
 *   - dispatch_result is left verbatim (legacy back-compat).
 *   - Plans without dispatch_result.kind='dispatched' are skipped
 *     (genuine in-flight executions, error states, etc.).
 *   - Plans with terminal_at already stamped are skipped (idempotent).
 *
 * Usage:
 *   node scripts/backfill-stranded-executing-plans.mjs
 *   node scripts/backfill-stranded-executing-plans.mjs --dry-run
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd());
const ATOMS_DIR = join(REPO_ROOT, '.lag', 'atoms');
const DRY_RUN = process.argv.includes('--dry-run');

function parsePrNumberFromSummary(summary) {
  if (typeof summary !== 'string') return null;
  const match = /#(\d{1,7})\b/.exec(summary);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function loadPlanFiles() {
  const entries = readdirSync(ATOMS_DIR, { withFileTypes: true });
  const planFiles = entries
    .filter((d) => d.isFile() && d.name.startsWith('plan-') && d.name.endsWith('.json'))
    .map((d) => join(ATOMS_DIR, d.name));
  return planFiles;
}

function isStrandedDispatchedExecuting(atom) {
  if (atom.type !== 'plan') return false;
  if (atom.plan_state !== 'executing') return false;
  if (atom.taint !== 'clean') return false;
  if ((atom.superseded_by ?? []).length > 0) return false;
  const md = atom.metadata ?? {};
  // Must already have an executing claim stamp (otherwise this is not
  // a post-PR-#270 plan and the substrate can't reason about it).
  if (typeof md.executing_at !== 'string') return false;
  // Must have dispatch_result.kind='dispatched'; that's the diagnostic
  // marker that the invoker handed off durable work and the dispatcher
  // pre-fix left the plan in executing.
  const dr = md.dispatch_result;
  if (!dr || typeof dr !== 'object') return false;
  if (dr.kind !== 'dispatched') return false;
  // Must not already have a terminal stamp (idempotency).
  if (typeof md.terminal_at === 'string') return false;
  if (typeof md.terminal_kind === 'string') return false;
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

function applyBackfill(atom) {
  const md = atom.metadata ?? {};
  const dr = md.dispatch_result ?? {};
  const summary = typeof dr.summary === 'string' ? dr.summary : '';
  const prNumber = parsePrNumberFromSummary(summary);

  // Use the dispatch_result.at as the terminal_at when present so the
  // backfilled stamp reflects the original dispatch event time, not
  // the time of this sweep. Fallback to nowIso() if dispatch_result.at
  // is missing.
  const terminalAt = typeof dr.at === 'string' && dr.at.length > 0 ? dr.at : nowIso();

  const updated = {
    ...atom,
    plan_state: 'succeeded',
    metadata: {
      ...md,
      terminal_at: terminalAt,
      terminal_kind: 'succeeded',
      ...(prNumber !== null
        ? { dispatch_pr_number: prNumber, dispatch_pr_summary: summary }
        : {}),
    },
  };
  return updated;
}

function main() {
  const planFiles = loadPlanFiles();
  let scanned = 0;
  let stranded = 0;
  let backfilled = 0;
  let prLinked = 0;

  for (const filePath of planFiles) {
    scanned += 1;
    const raw = readFileSync(filePath, 'utf8');
    let atom;
    try {
      atom = JSON.parse(raw);
    } catch (err) {
      console.error(`[backfill] could not parse ${filePath}: ${err.message}`);
      continue;
    }
    if (!isStrandedDispatchedExecuting(atom)) continue;
    stranded += 1;

    const updated = applyBackfill(atom);
    const hasPrLink = typeof updated.metadata.dispatch_pr_number === 'number';
    if (hasPrLink) prLinked += 1;

    if (DRY_RUN) {
      console.log(
        `[backfill] DRY-RUN ${atom.id} -> plan_state=succeeded `
        + `terminal_at=${updated.metadata.terminal_at} `
        + `${hasPrLink ? `dispatch_pr_number=${updated.metadata.dispatch_pr_number}` : 'no_pr_link'}`,
      );
      continue;
    }

    writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    backfilled += 1;
    console.log(
      `[backfill] ${atom.id} -> plan_state=succeeded `
      + `terminal_at=${updated.metadata.terminal_at} `
      + `${hasPrLink ? `dispatch_pr_number=${updated.metadata.dispatch_pr_number}` : 'no_pr_link'}`,
    );
  }

  console.log('');
  console.log(`[backfill] summary: scanned=${scanned} stranded=${stranded} backfilled=${backfilled} pr_linked=${prLinked} ${DRY_RUN ? '(DRY-RUN, no writes)' : ''}`);
}

main();
