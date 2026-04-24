#!/usr/bin/env node
/**
 * Canon bootstrap for the proactive-CTO inbox (V1 hardening).
 *
 * Seeds L3 policy atoms whose runtime behaviour is consumed by the
 * inbox + plan-lifecycle primitives in src/runtime/*. The POLICIES
 * payload lives in scripts/lib/inbox-canon-policies.mjs so drift
 * tests can import it without spawning Node; this script is the CLI
 * entry point and owns env + host side effects.
 *
 * Every threshold is a policy atom so tuning is a canon edit, not a
 * code release -- per the `dev-substrate-not-prescription` canon
 * directive and the revised v2.1 CTO plan
 * (plan-v2-1-hardening-circuit-breaker-policy-re-*).
 *
 * Shape note: these atoms reuse the `metadata.policy` convention but
 * with per-subject fields. The existing `checkToolPolicy` path ignores
 * non-`tool-use` subjects; consumers added in PRs A/B/D read these
 * atoms by id and parse the subject-specific fields. Layer L3 so the
 * canon-applier renders the human reason into CLAUDE.md.
 *
 * Idempotent per atom id; drift against the expected spec fails loud
 * (same discipline as bootstrap-cto-actor-canon.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { buildPolicies, policyAtom } from './lib/inbox-canon-policies.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

// Operator principal id. Every deployment picks its own; a
// hardcoded default here would leak one instance's shape into
// the script. Require explicit configuration. Matches the
// bootstrap-cto-actor-canon.mjs convention but without any
// fallback to a specific person's id.
const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-inbox] ERROR: LAG_OPERATOR_ID is not set. Export your\n'
    + 'operator principal id before running this script, e.g.\n\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
    + 'The id is referenced by pol-circuit-breaker-reset-authority and must\n'
    + 'match the principal already seeded in .lag/principals/.',
  );
  process.exit(2);
}

/**
 * Compare a stored inbox-policy atom's payload to the expected shape.
 * Returns a list of drift descriptors (empty = in sync). Every subject-
 * specific numeric or id field is compared so a silent edit to the
 * POLICIES table is loud on the next bootstrap run.
 *
 * `content` and `metadata.policy.reason` are both compared so editing the
 * human-reading rationale is surfaced as drift (a policy whose reason
 * was "root-only because depth-based is attackable" quietly becoming
 * "any operator" would misrepresent the governance posture without
 * changing any numeric field; that silent edit is exactly the class of
 * bug this drift check is here to catch).
 */
function diffPolicyAtom(existing, expected) {
  const diffs = [];
  if (existing.type !== expected.type) diffs.push(`type: ${existing.type} -> ${expected.type}`);
  if (existing.layer !== expected.layer) diffs.push(`layer: ${existing.layer} -> ${expected.layer}`);
  if (existing.content !== expected.content) {
    diffs.push(`content (rationale): stored vs expected differ; rewrite or bump id to supersede`);
  }
  // Signer / provenance integrity. These fields establish WHO authored the
  // atom and WHERE it came from. Editing them while the policy payload stays
  // unchanged would misattribute the atom without changing any numeric
  // threshold; the drift check must surface that, otherwise a compromised
  // principal could silently re-sign policies without triggering any alarm.
  if (existing.principal_id !== expected.principal_id) {
    diffs.push(
      `principal_id: stored=${JSON.stringify(existing.principal_id)} `
      + `expected=${JSON.stringify(expected.principal_id)}`,
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
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  const policies = buildPolicies(OPERATOR_ID);
  let written = 0;
  let ok = 0;
  for (const spec of policies) {
    const expected = policyAtom(spec, OPERATOR_ID);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-inbox] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffPolicyAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-inbox] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
        + 'Resolve by: (a) editing POLICIES[] to match stored shape if the '
        + 'stored value is authoritative, or (b) bumping the atom id and '
        + 'superseding the old one if you are intentionally changing policy.',
      );
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-inbox] done. ${written} written, ${ok} already in sync.`);
}

await main();
