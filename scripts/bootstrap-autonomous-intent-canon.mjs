#!/usr/bin/env node
/**
 * Canon bootstrap for three L3 atoms that form the autonomous-intent
 * substrate governance layer, ratified via this PR-gate.
 *
 * Each atom's content is drawn from the corresponding section of the
 * spec (docs/superpowers/specs/2026-04-24-autonomous-intent-substrate-design.md):
 *   - pol-operator-intent-creation (section 4): whitelist of principals
 *     allowed to author operator-intent atoms that the autonomous-intent
 *     approval tick honors.
 *   - pol-plan-autonomous-intent-approve (section 4): policy governing
 *     intent-based auto-approval of plans.
 *   - dev-autonomous-intent-substrate-shape (section 8): directive
 *     describing the authorization model for operator-intent atoms.
 *
 * Atom data lives in scripts/lib/autonomous-intent-canon-atoms.mjs so
 * the test suite can drive the same builder. This wrapper handles
 * argument parsing, env discovery, the file-host write, and the
 * drift-check.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-dev-canon-proposals.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  buildAtomFromSpec,
  buildAutonomousIntentCanonSpecs,
} from './lib/autonomous-intent-canon-atoms.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-autonomous-intent-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

// Drift-check pattern mirrors bootstrap-decisions-canon.mjs +
// bootstrap-dev-canon-proposals.mjs. Identity + provenance integrity
// are load-bearing: a rewritten provenance under unchanged content
// would silently re-attribute authorship, which violates
// inv-provenance-every-write.
function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  // Symmetric key comparison: a stored atom with an EXTRA key (stale
  // key left over from a prior version of the script, or post-seed
  // injection) must surface as drift. One-sided comparison would
  // silently accept legacy/injected metadata, which is exactly the
  // class of tampering the drift check exists to catch.
  const allKeys = new Set([...Object.keys(xm), ...Object.keys(em)]);
  for (const k of allKeys) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored vs expected differ`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} `
      + `expected=${JSON.stringify(expected.provenance.kind)}`,
    );
  }
  if (JSON.stringify(existing.provenance?.source ?? null) !== JSON.stringify(expected.provenance.source)) {
    diffs.push('provenance.source differs');
  }
  if (JSON.stringify(existing.provenance?.derived_from ?? []) !== JSON.stringify(expected.provenance.derived_from)) {
    diffs.push('provenance.derived_from differs');
  }
  if (JSON.stringify(existing.supersedes ?? []) !== JSON.stringify(expected.supersedes ?? [])) {
    diffs.push('supersedes differs');
  }
  if (JSON.stringify(existing.superseded_by ?? []) !== JSON.stringify(expected.superseded_by ?? [])) {
    diffs.push('superseded_by differs');
  }
  return diffs;
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  const specs = buildAutonomousIntentCanonSpecs(OPERATOR_ID);
  let written = 0;
  let ok = 0;
  for (const spec of specs) {
    const expected = buildAtomFromSpec(spec, OPERATOR_ID);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-autonomous-intent-canon] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-autonomous-intent-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-autonomous-intent-canon] done. ${written} written, ${ok} already in sync.`);
}

await main();
