#!/usr/bin/env node
/**
 * Canon bootstrap for the work-claim substrate (Task 19 / PR1).
 *
 * Seeds 11 L3 directive atoms into the .lag/atoms store:
 *
 *   3 budget-tier atoms (kind='claim-budget-tier'):
 *     pol-claim-budget-tier-default   max_budget_usd=2.0
 *     pol-claim-budget-tier-raised    max_budget_usd=5.0
 *     pol-claim-budget-tier-max       max_budget_usd=10.0
 *
 *   8 numeric-config atoms (kind matches the atom suffix; value=number):
 *     pol-claim-reaper-cadence-ms                   value=60_000
 *     pol-claim-recovery-max-attempts               value=3
 *     pol-claim-recovery-deadline-extension-ms      value=1_800_000
 *     pol-claim-attesting-grace-ms                  value=300_000
 *     pol-claim-pending-grace-ms                    value=60_000
 *     pol-claim-verifier-timeout-ms                 value=30_000
 *     pol-claim-verifier-failure-cap                value=3
 *     pol-claim-session-post-finalize-grace-ms      value=30_000
 *
 * The atom shapes are consumed at runtime by:
 *   - resolveBudgetTier in src/substrate/policy/claim-budget-tier.ts
 *     (matches kind='claim-budget-tier' + tier=<name>)
 *   - the 8 named readers in src/substrate/policy/claim-reaper-config.ts
 *     (each matches metadata.policy.kind by name)
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-inbox-canon.mjs and
 * bootstrap-reaper-canon.mjs).
 *
 * --dry-run prints the atoms that would be written without persisting
 * them. Useful for inspecting the seed before committing.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { buildPolicies, policyAtom } from './lib/claim-contract-canon-policies.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// Operator principal id. Every deployment picks its own; a hardcoded
// default here would leak one instance's shape into the script. Require
// explicit configuration per canon dev-no-hardcoded-operator-fallback.
const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID || OPERATOR_ID.length === 0) {
  console.error(
    '[bootstrap-claim-contract-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
      + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
      + 'The id signs every seeded atom; it must match the principal already seeded\n'
      + 'in .lag/principals/.',
  );
  process.exit(2);
}

/**
 * Compare a stored claim-contract policy atom payload to the expected
 * shape. Returns a list of drift descriptors (empty = in sync). Mirrors
 * diffPolicyAtom from bootstrap-reaper-canon.mjs so the canon bootstraps
 * share one drift-check pattern.
 *
 * `content` is compared so editing the human-reading rationale surfaces
 * as drift; metadata.policy is walked with a symmetric union over keys
 * so a stale legacy key on either side is caught rather than silently
 * passing.
 */
function diffPolicyAtom(existing, expected) {
  const diffs = [];
  if (existing.type !== expected.type) diffs.push(`type: ${existing.type} -> ${expected.type}`);
  if (existing.layer !== expected.layer) diffs.push(`layer: ${existing.layer} -> ${expected.layer}`);
  if (existing.content !== expected.content) {
    diffs.push('content (rationale): stored vs expected differ; rewrite or bump id to supersede');
  }
  if (existing.principal_id !== expected.principal_id) {
    diffs.push(
      `principal_id: stored=${JSON.stringify(existing.principal_id)} `
        + `expected=${JSON.stringify(expected.principal_id)}`,
    );
  }
  // Reader-eligibility fields. The runtime resolvers
  // (resolveBudgetTier, readNumericClaimPolicyByKind) SKIP atoms whose
  // taint != 'clean' or superseded_by is non-empty. A stored atom that
  // looks shape-identical but is tainted/superseded would make the
  // bootstrap log "already in sync" while runtime resolution still
  // fails closed. Diff these so the drift surface matches the read
  // eligibility surface.
  if ((existing.taint ?? 'clean') !== (expected.taint ?? 'clean')) {
    diffs.push(
      `taint: stored=${JSON.stringify(existing.taint)} `
        + `expected=${JSON.stringify(expected.taint)}`,
    );
  }
  const eSup = existing.superseded_by ?? [];
  const xSup = expected.superseded_by ?? [];
  if (JSON.stringify(eSup) !== JSON.stringify(xSup)) {
    diffs.push(
      `superseded_by: stored=${JSON.stringify(eSup)} `
        + `expected=${JSON.stringify(xSup)}`,
    );
  }
  const ev = existing.provenance ?? {};
  const xv = expected.provenance;
  if (ev.kind !== xv.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(ev.kind)} `
        + `expected=${JSON.stringify(xv.kind)}`,
    );
  }
  if (JSON.stringify(ev.source ?? {}) !== JSON.stringify(xv.source)) {
    diffs.push(
      `provenance.source: stored=${JSON.stringify(ev.source)} `
        + `expected=${JSON.stringify(xv.source)}`,
    );
  }
  if (JSON.stringify(ev.derived_from ?? []) !== JSON.stringify(xv.derived_from)) {
    diffs.push(
      `provenance.derived_from: stored=${JSON.stringify(ev.derived_from)} `
        + `expected=${JSON.stringify(xv.derived_from)}`,
    );
  }
  const ep = existing.metadata?.policy ?? {};
  const xp = expected.metadata.policy;
  const keys = new Set([...Object.keys(ep), ...Object.keys(xp)]);
  for (const k of keys) {
    if (JSON.stringify(ep[k]) !== JSON.stringify(xp[k])) {
      diffs.push(`policy.${k}: stored=${JSON.stringify(ep[k])} expected=${JSON.stringify(xp[k])}`);
    }
  }
  return diffs;
}

async function main() {
  const policies = buildPolicies(OPERATOR_ID);

  if (DRY_RUN) {
    console.log(`[bootstrap-claim-contract-canon] dry-run: ${policies.length} atoms would be written:`);
    for (const spec of policies) {
      const expected = policyAtom(spec, OPERATOR_ID);
      console.log(
        `  - ${expected.id} (type=${expected.type} layer=${expected.layer} `
          + `policy.kind=${expected.metadata.policy.kind})`,
      );
    }
    return;
  }

  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of policies) {
    const expected = policyAtom(spec, OPERATOR_ID);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-claim-contract-canon] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffPolicyAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-claim-contract-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
          + 'Resolve by: (a) editing buildPolicies in scripts/lib/claim-contract-canon-policies.mjs '
          + 'to match the stored shape if stored is authoritative, or (b) bumping the atom id and '
          + 'superseding the old one if intentionally changing policy.',
      );
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-claim-contract-canon] done. ${written} written, ${ok} already in sync.`);
}

main().catch((err) => {
  console.error('[bootstrap-claim-contract-canon] FAILED:', err);
  process.exit(1);
});
