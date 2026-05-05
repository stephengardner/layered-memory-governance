#!/usr/bin/env node
/**
 * Canon bootstrap for the per-actor pol-resume-strategy atoms.
 *
 * Run from repo root (after `npm run build`):
 *   LAG_OPERATOR_ID=<your-id> node scripts/bootstrap-pol-resume-strategy.mjs
 *
 * Seeds one L3 policy atom into the .lag/atoms store:
 *
 *   pol-resume-strategy-pr-fix-actor   L3 directive: enabled=true,
 *                                      max_stale_hours=8,
 *                                      fresh_spawn_kinds=[...]
 *
 * Promotes the hard-coded posture from scripts/run-pr-fix.mjs (PR #171:
 * SameMachineCliResumeStrategy with maxStaleHours=8) to a canon policy
 * atom per spec section 11.3. A fresh deployment running this seed for
 * the first time observes IDENTICAL resume behavior to the
 * pre-canon-policy run; removing the atom flips PR-fix back to
 * fresh-spawn (regression check vs PR #171, the spec's PR3 acceptance
 * criterion).
 *
 * Atom data lives in scripts/lib/resume-strategy-canon-policies.mjs so
 * the test suite can drive the same builder. This wrapper handles
 * argument parsing, env discovery, the file-host write, and the
 * drift-check.
 *
 * --dry-run prints the atom that would be written without persisting
 * it. Useful for inspecting the seed before committing.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-inbox-canon.mjs and
 * bootstrap-reaper-canon.mjs).
 *
 * cto-actor + code-author policy atoms are intentionally OMITTED here:
 * per spec section 5.2 the policy atom for those principals ships
 * ABSENT so a solo developer's first run-cto-actor.mjs /
 * run-code-author.mjs invocation does not surprise-restore stale
 * context. An org-ceiling deployment that wants resume on cto-actor
 * adds a higher-priority canon atom via /decide or a separate
 * bootstrap; this script is the v1 minimal seed.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  buildPolicies,
  diffPolicyAtom,
  policyAtom,
} from './lib/resume-strategy-canon-policies.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// Operator principal id. Every deployment picks its own; a
// hardcoded default here would leak one instance's shape into
// the script. Require explicit configuration. Mirrors
// bootstrap-reaper-canon.mjs and bootstrap-inbox-canon.mjs.
const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID || OPERATOR_ID.length === 0) {
  console.error(
    '[bootstrap-pol-resume-strategy] ERROR: LAG_OPERATOR_ID is not set. Export your\n'
      + 'operator principal id before running this script, e.g.\n\n'
      + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
      + 'The id signs the seed atom; it must match the principal already seeded\n'
      + 'in .lag/principals/.',
  );
  process.exit(2);
}

async function main() {
  const policies = buildPolicies(OPERATOR_ID);

  if (DRY_RUN) {
    console.log(
      `[bootstrap-pol-resume-strategy] dry-run: ${policies.length} atom(s) would be written:`,
    );
    for (const spec of policies) {
      const expected = policyAtom(spec, OPERATOR_ID);
      console.log(
        `  - ${expected.id} (type=${expected.type} layer=${expected.layer} `
          + `policy.principal_id=${expected.metadata.policy.principal_id} `
          + `enabled=${expected.metadata.policy.content.enabled})`,
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
      console.log(`[bootstrap-pol-resume-strategy] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffPolicyAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-pol-resume-strategy] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
          + 'Resolve by: (a) editing buildPolicies in scripts/lib/resume-strategy-canon-policies.mjs '
          + 'to match stored shape if the stored value is authoritative, or (b) bumping the '
          + 'atom id and superseding the old one if you are intentionally changing policy.',
      );
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-pol-resume-strategy] done. ${written} written, ${ok} already in sync.`);
}

main().catch((err) => {
  console.error('[bootstrap-pol-resume-strategy] FAILED:', err);
  process.exit(1);
});
