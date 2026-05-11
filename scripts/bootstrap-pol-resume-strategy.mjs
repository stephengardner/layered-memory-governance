#!/usr/bin/env node
/**
 * Canon bootstrap for the per-actor pol-resume-strategy atoms.
 *
 * Run from repo root (after `npm run build`):
 *   LAG_OPERATOR_ID=<your-id> node scripts/bootstrap-pol-resume-strategy.mjs
 *
 * Seeds L3 policy atoms into the .lag/atoms store:
 *
 *   pol-resume-strategy-pr-fix-actor   L3 directive: enabled=true,
 *                                      max_stale_hours=8,
 *                                      fresh_spawn_kinds=[...]
 *
 *   pol-resume-strategy-code-author    L3 directive: enabled=true,
 *                                      max_stale_hours=4,
 *                                      fresh_spawn_kinds=[...]
 *
 * Promotes the hard-coded posture from scripts/run-pr-fix.mjs (PR #171:
 * SameMachineCliResumeStrategy with maxStaleHours=8) to a canon policy
 * atom per spec section 11.3, and extends the symmetric posture to
 * code-author (task #155, completed after task #293 / PR #397 wired the
 * auditor feedback re-prompt loop that makes code-author re-invocation
 * a real pattern). A fresh deployment running this seed observes
 * IDENTICAL resume behavior to the pre-canon-policy run for pr-fix-actor,
 * and resume-on for code-author whenever the agentic code-author
 * dispatch path is wired against the registry bridge. Removing either
 * atom flips that actor back to fresh-spawn (regression check vs PR #171
 * + task #155).
 *
 * Atom data lives in scripts/lib/resume-strategy-canon-policies.mjs so
 * the test suite can drive the same builder. This wrapper handles
 * argument parsing, env discovery, the file-host write, and the
 * drift-check.
 *
 * --dry-run prints the atoms that would be written without persisting
 * them. Useful for inspecting the seeds before committing.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-inbox-canon.mjs and
 * bootstrap-reaper-canon.mjs).
 *
 * cto-actor + pipeline-auditor policy atoms are intentionally OMITTED
 * here: per spec section 5.2 the policy atom for principals with no
 * observed re-invocation pattern ships ABSENT so a solo developer's
 * first invocation does not surprise-restore stale context. An
 * org-ceiling deployment that wants resume on those principals adds a
 * higher-priority canon atom via /decide or a separate bootstrap.
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
