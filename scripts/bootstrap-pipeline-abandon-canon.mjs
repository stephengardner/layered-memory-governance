#!/usr/bin/env node
/**
 * Canon bootstrap for the pipeline-abandon authority gate.
 *
 * Seeds one L3 policy atom into the .lag/atoms store:
 *
 *   pol-pipeline-abandon   L3 directive: allowed_principals=[operator]
 *
 * Authorizes principals to sign a pipeline-abandoned atom against a
 * running or hil-paused pipeline. The Console's
 * `/api/pipeline.abandon` route handler and any future authoring path
 * re-walks this canon atom on every request and refuses the write
 * unless the caller's principal id appears in `allowed_principals`.
 *
 * Indie-floor default ships with the deployment's operator principal
 * only. Widening the allowlist to a delegated human or bot is a
 * conscious canon edit (write a higher-priority pol- atom), not a
 * config knob; an org-ceiling deployment that wants its pr-landing
 * agent to abandon a runaway pipeline writes a separate atom with
 * the additional principal.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-pol-resume-strategy.mjs).
 *
 * --dry-run prints the atom that would be written without persisting
 * it. Useful for inspecting the seed before committing.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID || OPERATOR_ID.length === 0) {
  console.error(
    '[bootstrap-pipeline-abandon-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
      + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
      + 'The id signs the seed atom AND seeds the initial allowed_principals\n'
      + 'list. It must match the principal already seeded in .lag/principals/.',
  );
  process.exit(2);
}

const BOOTSTRAP_TIME = '2026-05-11T12:00:00.000Z';

/*
 * Source atom-id for the upstream operator-intent that authorized the
 * pipeline-abandon control to land in canon. Held constant here so the
 * derived_from chain is stable across re-runs (drift detection compares
 * provenance). A future operator-edit that re-seeds against a fresh
 * intent flips this constant alongside the schema-version bump.
 */
const SOURCE_INTENT = 'operator-intent-pipeline-abandon-1778420000000';

const sharedDerivedFrom = Object.freeze([
  'inv-l3-requires-human',
  'inv-governance-before-autonomy',
  'inv-kill-switch-first',
  'inv-provenance-every-write',
  'arch-atomstore-source-of-truth',
  'arch-host-interface-boundary',
  'dev-substrate-not-prescription',
  'dev-indie-floor-org-ceiling',
  SOURCE_INTENT,
]);

function buildPolicy(operatorId) {
  return {
    schema_version: 1,
    id: 'pol-pipeline-abandon',
    content:
      'Authority gate for pipeline-abandoned atom writes. Principals listed in '
      + '`allowed_principals` may sign a pipeline-abandoned atom that flips a '
      + 'running or hil-paused pipeline to terminal `abandoned`. Indie-floor '
      + 'default ships with the deployment operator only; widening to a '
      + 'delegated human or bot resumer is a conscious canon edit via a '
      + 'higher-priority pol- atom, not a config knob. Mirrors '
      + 'pol-pipeline-stage-hil-* authority shape so the Console abandon '
      + 'route and the substrate runner both walk the same canon entry on '
      + 'every check.',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-pipeline-abandon-canon', agent_id: 'bootstrap' },
      derived_from: [...sharedDerivedFrom],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: operatorId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'pipeline-abandon',
        allowed_principals: [operatorId],
      },
      alternatives_rejected: [
        'Ship without a canon gate; any caller that reaches the origin-allowed Console route could abandon any pipeline',
        'Hardcode the operator principal in the route handler; loses the canon-edit knob for adding a delegated bot resumer',
        'Reuse the pol-pipeline-stage-hil allowed_resumers list; conflates stage-resume authority with pipeline-kill authority (a principal authorized to resume a paused stage is not necessarily authorized to kill the entire run)',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: the allowed_principals array is additive (a new authorized bot ships its own canon edit). '
        + 'Removing a principal is a canon edit visible in the diff. The substrate runner re-reads the canon entry on '
        + 'every abandon-check so a canon edit takes effect on the next request without a code change. Tightening the '
        + 'gate (removing the operator) would block all UI-initiated abandons and force the operator back to the global '
        + 'STOP kill switch -- a deliberate trade-off, not a silent regression.',
    },
  };
}

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
  return diffs;
}

async function main() {
  const expected = buildPolicy(OPERATOR_ID);

  if (DRY_RUN) {
    console.log('[bootstrap-pipeline-abandon-canon] dry-run: 1 atom would be written:');
    console.log(
      `  - ${expected.id} (type=${expected.type} layer=${expected.layer} `
        + `allowed_principals=${JSON.stringify(expected.metadata.policy.allowed_principals)})`,
    );
    return;
  }

  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  const existing = await host.atoms.get(expected.id);
  if (existing === null) {
    await host.atoms.put(expected);
    console.log(`[bootstrap-pipeline-abandon-canon] wrote ${expected.id}`);
    return;
  }
  const diffs = diffAtom(existing, expected);
  if (diffs.length > 0) {
    console.error(
      `[bootstrap-pipeline-abandon-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
        + 'Resolve by: (a) editing buildPolicy() to match stored shape if the stored value is authoritative, '
        + 'or (b) bumping the atom id and superseding the old one if you are intentionally changing policy.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[bootstrap-pipeline-abandon-canon] ${expected.id} already in sync.`);
}

main().catch((err) => {
  console.error('[bootstrap-pipeline-abandon-canon] FAILED:', err);
  process.exit(1);
});
