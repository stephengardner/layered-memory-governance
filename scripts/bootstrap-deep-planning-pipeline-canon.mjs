#!/usr/bin/env node
/**
 * Canon bootstrap for the deep planning pipeline substrate.
 *
 * Seeds eight atoms into the .lag/atoms store:
 *
 *   pol-planning-pipeline-stages-default      L3 directive: 5-stage default ordering
 *   pol-pipeline-stage-hil-brainstorm-stage   L3 directive: pause_mode='never'
 *   pol-pipeline-stage-hil-spec-stage         L3 directive: pause_mode='on-critical-finding'
 *   pol-pipeline-stage-hil-plan-stage         L3 directive: pause_mode='on-critical-finding'
 *   pol-pipeline-stage-hil-review-stage       L3 directive: pause_mode='never'
 *   pol-pipeline-stage-hil-dispatch-stage     L3 directive: pause_mode='on-critical-finding'
 *   pol-planning-pipeline-default-mode        L3 directive: mode='single-pass'
 *   dev-deep-planning-pipeline                L0 pending_review (operator promotes via /decide)
 *
 * The substrate-shape directive ships at L0 with
 * validation_status='pending_review' so the operator gates the L3
 * promotion via /decide post-merge. Auto-writing at L3 from a
 * bootstrap script would bypass the human gate that the three-layer
 * architecture is built around.
 *
 * Atom data lives in scripts/lib/deep-planning-pipeline-canon-atoms.mjs
 * so the test suite can drive the same builder. This wrapper handles
 * argument parsing, env discovery, the file-host write, and the
 * drift-check.
 *
 * --dry-run prints the eight atoms that would be written without
 * persisting them. Useful for inspecting the seed before committing.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-autonomous-intent-canon.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  buildAtomFromSpec,
  buildDeepPlanningPipelineSpecs,
} from './lib/deep-planning-pipeline-canon-atoms.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-deep-planning-pipeline-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

// Drift-check pattern mirrors the existing canon-bootstrap scripts.
// Identity + provenance integrity are load-bearing: a rewritten
// provenance under unchanged content would silently re-attribute
// authorship, which the every-write provenance invariant exists to
// prevent. Symmetric metadata-key comparison (walks union of stored +
// expected keys) so a stale legacy key on either side surfaces as
// drift rather than silently passing.
function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint', 'scope']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
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
  if (existing.signals?.validation_status !== expected.signals.validation_status) {
    diffs.push(
      `signals.validation_status: stored=${JSON.stringify(existing.signals?.validation_status)} `
      + `expected=${JSON.stringify(expected.signals.validation_status)}`,
    );
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
  const specs = buildDeepPlanningPipelineSpecs(OPERATOR_ID);

  if (DRY_RUN) {
    console.log(`[bootstrap-deep-planning-pipeline-canon] dry-run: ${specs.length} atoms would be written:`);
    for (const spec of specs) {
      const expected = buildAtomFromSpec(spec, OPERATOR_ID);
      console.log(
        `  - ${expected.id} (type=${expected.type} layer=${expected.layer} `
        + `validation_status=${expected.signals.validation_status})`,
      );
    }
    return;
  }

  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of specs) {
    const expected = buildAtomFromSpec(spec, OPERATOR_ID);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-deep-planning-pipeline-canon] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-deep-planning-pipeline-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-deep-planning-pipeline-canon] done. ${written} written, ${ok} already in sync.`);
}

await main();
