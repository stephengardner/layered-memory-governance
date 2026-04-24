#!/usr/bin/env node
/**
 * Canon bootstrap for the worktree-workflow L3 directive.
 *
 * Directive: dev-parallel-workstreams-use-worktrees
 *   Parallel workstreams must use isolated .worktrees/<slug>/ branched off
 *   main; one worktree per branch. Shared-checkout parallel work is
 *   rejected. Stacking is permitted only for genuinely-dependent work;
 *   every stack branch still gets its own worktree. Cleanup is
 *   operator-invoked via `wt clean`; no scheduled or auto-cleanup job.
 *   Mechanics live in the worktree-workflow skill, not canon.
 *
 * Idempotent per atom id; drift against stored shape fails loud
 * (same discipline as bootstrap-dev-canon-proposals.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-21T00:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-workflow-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

const ATOMS = [
  {
    id: 'dev-parallel-workstreams-use-worktrees',
    content:
      'Parallel workstreams must use isolated `.worktrees/<slug>/` branched off main; one worktree '
      + 'per branch. Shared-checkout parallel work is rejected. Stacking is permitted for '
      + 'genuinely-dependent work (child branch cannot compile or pass its own tests without the '
      + 'parent merged, and interface-extraction in the parent does not resolve the dependency); '
      + 'every branch in a stack still gets its own worktree, and cascading rebases go through '
      + '`git-spice`. Cleanup is operator-invoked via `wt clean`; no scheduled or auto-cleanup job. '
      + 'Mechanics (CLI surface, NOTES.md schema, default thresholds) live in the '
      + 'worktree-workflow skill, not canon.',
    alternatives_rejected: [
      'Continue with sibling-directory worktrees per apps/console/CLAUDE.md convention',
      'Adopt sessions/<name>/ with per-session NOTES.md across repos',
      'Ban stacking entirely (too strict; genuinely-dependent work pays an avoidable tax)',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: the rule scales with actor count (every new actor wants its own '
      + 'isolated workspace) and with repo-count (if a second repo joins, the pattern '
      + 'generalizes - one .worktrees/ per repo). Revisit would be prompted only by a shift to '
      + 'a filesystem-transparent orchestration layer (e.g., per-actor containers) where the '
      + 'worktree abstraction moves below the line; the rule still applies, the mechanism changes.',
    derived_from: [
      'dev-canon-is-strategic-not-tactical',
      'inv-governance-before-autonomy',
      'inv-kill-switch-first',
      'dev-indie-floor-org-ceiling',
      'dev-forward-thinking-no-regrets',
    ],
  },
];

function atomFromSpec(spec) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-workflow-canon', agent_id: 'bootstrap' },
      derived_from: spec.derived_from,
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
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata: {
      alternatives_rejected: spec.alternatives_rejected,
      what_breaks_if_revisit: spec.what_breaks_if_revisit,
    },
  };
}

function diffAtom(existing, expected) {
  const diffs = [];
  // `scope` added to the integrity set (CR #128 Major): atomFromSpec
  // pins scope='project'; a drift there must fail loud because scope
  // is what scope-filtered canon renders use to pick atoms.
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint', 'scope']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  // Lifecycle fields (CR #128 Major): if an operator has superseded the
  // directive out-of-band (non-empty `superseded_by`, or an unexpected
  // `supersedes` entry), treating it as "already in sync" would let the
  // revoked directive survive the rebuild silently. The bootstrap has
  // no authority to reconcile supersession state unilaterally; any
  // mismatch forces operator review. Matches the diffFenceAtom
  // discipline in src/examples/virtual-org-bootstrap/fence-seed.ts.
  if (JSON.stringify(existing.supersedes ?? []) !== JSON.stringify(expected.supersedes)) {
    diffs.push(
      `supersedes: stored=${JSON.stringify(existing.supersedes)} `
      + `expected=${JSON.stringify(expected.supersedes)}`,
    );
  }
  if (JSON.stringify(existing.superseded_by ?? []) !== JSON.stringify(expected.superseded_by)) {
    diffs.push(
      `superseded_by: stored=${JSON.stringify(existing.superseded_by)} `
      + `expected=${JSON.stringify(expected.superseded_by)}`,
    );
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
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of ATOMS) {
    const expected = atomFromSpec(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-workflow-canon] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-workflow-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-workflow-canon] done. ${written} written, ${ok} already in sync.`);
}

await main();
