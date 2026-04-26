#!/usr/bin/env node
/**
 * canon-suggest-triage: operator-facing CLI for triaging a canon-
 * proposal-suggestion atom written by the canon-scout. Three actions:
 *
 *   --action promote  — print the matching `decide.mjs` invocation so
 *                       the operator can review + run it. Then mark the
 *                       suggestion `review_state: promoted` with a
 *                       `derived_canon_id` pointer once the operator
 *                       passes --derived-canon-id back in. Promotion is
 *                       a TWO-STEP flow on purpose: the suggestion atom
 *                       NEVER triggers L3 writes by itself per
 *                       inv-l3-requires-human. The operator is the
 *                       gate.
 *   --action dismiss  — mark `review_state: dismissed`. Atom stays for
 *                       audit; nothing is deleted.
 *   --action defer    — mark `review_state: deferred`. Same as
 *                       dismissed for storage; semantically "later".
 *
 * Why no auto-promote: the spec is a substrate-respecting design.
 * scripts/decide.mjs requires the operator to articulate
 * `alternatives_rejected` + `what_breaks_if_revisited` per
 * dev-extreme-rigor-and-research, which is friction by design. Auto-
 * promoting from a suggestion would short-circuit that gate. The
 * triage CLI prints the decide invocation; the operator runs it.
 *
 * Usage:
 *   node scripts/canon-suggest-triage.mjs --atom-id <id> --action <promote|dismiss|defer> [--reason "..."] [--derived-canon-id <id>]
 *
 * --derived-canon-id is required AFTER promote; the workflow is:
 *   1. canon-suggest-triage --atom-id <s> --action promote
 *      -> prints `node scripts/decide.mjs --id ... --type ... --content ...`
 *   2. operator runs decide.mjs (filling in alternatives + what_breaks)
 *   3. canon-suggest-triage --atom-id <s> --action promote --derived-canon-id <new>
 *      -> updates suggestion review_state=promoted with the linkage
 *
 * Pure logic lives in scripts/lib/canon-suggestion.mjs (shebang-free
 * per dev-shebang-import-from-tests so vitest+esbuild on Windows-CI
 * imports cleanly from .test.ts).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  isCanonSuggestionAtom,
  applyTriageAction,
  buildTriagedMetadata,
  CANON_SUGGESTION_ACTIONS,
  CANON_SUGGESTION_ACTION_TO_STATE,
} from './lib/canon-suggestion.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

function parseArgs(argv) {
  const args = {
    atomId: null,
    action: null,
    reason: null,
    derivedCanonId: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--atom-id') args.atomId = argv[++i];
    else if (a === '--action') args.action = argv[++i];
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--derived-canon-id') args.derivedCanonId = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: see docstring in scripts/canon-suggest-triage.mjs');
      process.exit(0);
    } else {
      console.error(`[canon-suggest-triage] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printDecideHint(atom) {
  const meta = atom.metadata;
  const sid = String(meta.suggested_id);
  const styp = String(meta.suggested_type);
  // CodeQL: incomplete-string-escaping. Escape backslashes BEFORE
  // double-quotes so a `\` in the suggestion text does not combine
  // with a later escaped-quote to break out of the shell-quoted
  // string. The order matters: replacing `"` first would later double-
  // escape any `\` we add for it. Applies the same defense to backticks
  // (shells expand them even inside double quotes) and `$` (parameter
  // expansion), so the printed `decide.mjs --content "..."` invocation
  // is safe to paste into a shell verbatim.
  const content = String(meta.proposed_content)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  // Emit a usable shell invocation. Operator MUST fill in alternatives
  // + what_breaks per dev-extreme-rigor-and-research; we surface the
  // fields rather than auto-fabricate them.
  console.log('[canon-suggest-triage] promote workflow (operator runs each step):');
  console.log('');
  console.log('  1) Review the suggestion above. If it is canon-quality:');
  console.log('');
  console.log('     node scripts/decide.mjs \\');
  console.log(`       --id ${sid} \\`);
  console.log(`       --type ${styp} \\`);
  console.log(`       --content "${content}" \\`);
  console.log('       --alternative "<rejected option>::<reason>" \\');
  console.log('       --what-breaks "<one-sentence consequence of revisiting>"');
  console.log('');
  console.log('  2) Note the new atom id printed by decide.mjs, then mark the suggestion:');
  console.log('');
  console.log(`     node scripts/canon-suggest-triage.mjs --atom-id ${atom.id} --action promote --derived-canon-id <new-canon-atom-id>`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.atomId) {
    console.error('[canon-suggest-triage] --atom-id is required');
    process.exit(2);
  }
  if (!args.action) {
    console.error('[canon-suggest-triage] --action is required');
    process.exit(2);
  }
  if (!CANON_SUGGESTION_ACTIONS.includes(args.action)) {
    console.error(`[canon-suggest-triage] --action must be one of ${CANON_SUGGESTION_ACTIONS.join('|')}`);
    process.exit(2);
  }

  const actorId = process.env.LAG_OPERATOR_ID;
  if (!actorId) {
    console.error('[canon-suggest-triage] LAG_OPERATOR_ID is not set; export the operator principal id first.');
    process.exit(2);
  }

  const host = await createFileHost({ rootDir: STATE_DIR });
  const atom = await host.atoms.get(args.atomId);
  if (atom === null) {
    console.error(`[canon-suggest-triage] atom ${args.atomId} not found`);
    process.exit(1);
  }
  if (!isCanonSuggestionAtom(atom)) {
    console.error(
      `[canon-suggest-triage] atom ${args.atomId} is not a canon-proposal-suggestion `
      + `(type=${atom.type}, metadata.kind=${atom.metadata?.kind ?? 'undefined'})`,
    );
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('[canon-suggest-triage] --dry-run');
    if (args.action === 'promote' && !args.derivedCanonId) {
      printDecideHint(atom);
      return;
    }
    const targetState = CANON_SUGGESTION_ACTION_TO_STATE[args.action];
    const metadataPatch = buildTriagedMetadata(atom.metadata, targetState, {
      actorId,
      nowIso: new Date().toISOString(),
      ...(args.derivedCanonId ? { derivedCanonId: args.derivedCanonId } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    console.log('[canon-suggest-triage] would update metadata to:');
    console.log(JSON.stringify(metadataPatch, null, 2));
    return;
  }

  const result = await applyTriageAction(host, atom, {
    action: args.action,
    actorId,
    nowIso: new Date().toISOString(),
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.derivedCanonId ? { derivedCanonId: args.derivedCanonId } : {}),
  });

  if (result.awaitingDecide) {
    printDecideHint(atom);
    return;
  }
  console.log(
    `[canon-suggest-triage] ${args.atomId} review_state=${result.atom.metadata.review_state}`
    + (args.derivedCanonId ? ` (derived_canon_id=${args.derivedCanonId})` : ''),
  );
}

main().catch((err) => {
  console.error(`[canon-suggest-triage] ${err.message}`);
  process.exit(1);
});
