#!/usr/bin/env node
/**
 * decide: capture an operator-authored canon atom.
 *
 * Closes the gap where operator directives ("CR is non-negotiable",
 * "no stephengardner comments on automation artifacts") stay in chat
 * transcripts and never reach the canon store. A session-local
 * preference that never atomizes is not governance - the next agent
 * never sees it. This CLI writes the atom at the moment the operator
 * states the directive so future agents inherit it via canon.
 *
 * Usage (single-shot via JSON spec on stdin - preferred):
 *   node scripts/decide.mjs --spec-file path/to/spec.json
 *   cat spec.json | node scripts/decide.mjs --spec-file -
 *
 * Usage (flags, ergonomic for quick captures):
 *   node scripts/decide.mjs \
 *     --id dev-coderabbit-required-status-check-non-negotiable \
 *     --type directive \
 *     --content "CodeRabbit is a required status check for main..." \
 *     --alternative "Drop CR from required checks::loses the gate" \
 *     --alternative "Path-scoped conditional::still removes gate for some PRs" \
 *     --what-breaks "Merge quality gate weakens; CR findings become advisory only."
 *
 * Spec shape:
 *   {
 *     "id":        "dev-something-kebab-case",
 *     "type":      "directive" | "decision" | "preference" | "reference",
 *     "content":   "<canon-quality prose>",
 *     "alternatives_rejected": [
 *       { "option": "...", "reason": "..." },
 *       ...
 *     ],
 *     "what_breaks_if_revisited": "<one sentence>",
 *     "derived_from": ["atom-id-1", ...]   // optional; empty array ok
 *   }
 *
 * Writes the atom at layer L3 (operator-signed canon) with
 * principal_id=$LAG_OPERATOR_ID. Idempotent per id: re-running with
 * an unchanged spec is a no-op; a changed spec fails loud so the
 * operator makes the drift decision explicitly.
 *
 * Motivation atom in canon:
 *   dev-capture-operator-directives-as-atoms
 */

import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

function parseArgs(argv) {
  const args = {
    specFile: null,
    id: null,
    type: null,
    content: null,
    alternatives: [],
    whatBreaks: null,
    derivedFrom: [],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec-file') args.specFile = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--content') args.content = argv[++i];
    else if (a === '--alternative') {
      const raw = argv[++i];
      const sep = raw.indexOf('::');
      if (sep === -1) {
        console.error(`ERROR: --alternative expects "option::reason", got: ${raw}`);
        process.exit(2);
      }
      args.alternatives.push({
        option: raw.slice(0, sep).trim(),
        reason: raw.slice(sep + 2).trim(),
      });
    } else if (a === '--what-breaks') args.whatBreaks = argv[++i];
    else if (a === '--derived-from') args.derivedFrom.push(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: see docstring in scripts/decide.mjs');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function loadSpec(args) {
  if (args.specFile) {
    const raw = args.specFile === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(args.specFile, 'utf8');
    return JSON.parse(raw);
  }
  // Flag-composed spec; validate required fields downstream.
  return {
    id: args.id,
    type: args.type,
    content: args.content,
    alternatives_rejected: args.alternatives,
    what_breaks_if_revisited: args.whatBreaks,
    derived_from: args.derivedFrom,
  };
}

const VALID_TYPES = new Set(['directive', 'decision', 'preference', 'reference']);
const ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSpec(spec) {
  const errs = [];
  if (typeof spec.id !== 'string' || !ID_REGEX.test(spec.id)) {
    errs.push('id: required, kebab-case (a-z, 0-9, hyphens)');
  }
  if (!VALID_TYPES.has(spec.type)) {
    errs.push(`type: required, one of ${[...VALID_TYPES].join('|')}`);
  }
  if (typeof spec.content !== 'string' || spec.content.trim().length < 20) {
    errs.push('content: required, >= 20 chars (canon-quality prose, not a one-liner)');
  }
  if (!Array.isArray(spec.alternatives_rejected)) {
    errs.push('alternatives_rejected: required array (may be empty only for reference-type atoms)');
  } else {
    if (spec.type !== 'reference' && spec.alternatives_rejected.length === 0) {
      errs.push('alternatives_rejected: non-reference atoms must list >= 1 alternative per dev-extreme-rigor-and-research');
    }
    for (const [i, alt] of spec.alternatives_rejected.entries()) {
      if (typeof alt?.option !== 'string' || typeof alt?.reason !== 'string') {
        errs.push(`alternatives_rejected[${i}]: must be {option, reason}`);
      }
    }
  }
  if (typeof spec.what_breaks_if_revisited !== 'string' || spec.what_breaks_if_revisited.trim().length === 0) {
    errs.push('what_breaks_if_revisited: required (per dev-forward-thinking-no-regrets)');
  }
  if (spec.derived_from !== undefined && !Array.isArray(spec.derived_from)) {
    errs.push('derived_from: must be an array of atom ids');
  }
  return errs;
}

function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  // Bidirectional metadata diff so extra keys on the stored atom
  // (the hostile-injection class of tampering) are caught too.
  // One-sided iteration would let a tampered atom with an extra
  // metadata.* key read as clean if the original spec's keys all
  // match.
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  const metaKeys = new Set([...Object.keys(em), ...Object.keys(xm)]);
  for (const k of metaKeys) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored=${JSON.stringify(em[k])} expected=${JSON.stringify(xm[k])}`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(`provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} expected=${JSON.stringify(expected.provenance.kind)}`);
  }
  if (JSON.stringify(existing.provenance?.source ?? null) !== JSON.stringify(expected.provenance.source)) {
    diffs.push('provenance.source differs');
  }
  if (JSON.stringify(existing.provenance?.derived_from ?? []) !== JSON.stringify(expected.provenance.derived_from)) {
    diffs.push('provenance.derived_from differs');
  }
  return diffs;
}

function atomFromSpec(spec, operatorId) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content.trim(),
    type: spec.type,
    layer: 'L3',
    provenance: {
      /*
       * `/decide` writes operator-asserted live-conversational atoms,
       * so `'user-directive'` is the canonical kind per the
       * `ProvenanceKind` union in `src/substrate/types.ts`. Distinct
       * from `'operator-seeded'`, which is reserved for atoms minted
       * by bootstrap scripts at initial seed time
       * (`bootstrap-operator-directives.mjs` uses that kind on the
       * same shape; the `atomFromSpec` comment there preserves the
       * same distinction). The earlier `'human-asserted'` value here
       * was not a member of the canonical union and silently scored
       * 0 in `PROVENANCE_RANK` source-rank tiebreaks.
       */
      kind: 'user-directive',
      source: {
        tool: 'decide-cli',
        agent_id: operatorId,
      },
      derived_from: spec.derived_from ?? [],
    },
    confidence: 1.0,
    created_at: now,
    last_reinforced_at: now,
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
      alternatives_rejected: spec.alternatives_rejected,
      what_breaks_if_revisited: spec.what_breaks_if_revisited,
      source: 'decide-cli',
    },
  };
}

async function main() {
  const operatorId = process.env.LAG_OPERATOR_ID;
  if (!operatorId) {
    console.error('ERROR: LAG_OPERATOR_ID is not set.');
    console.error('  export LAG_OPERATOR_ID=<your-operator-principal-id>');
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  const spec = loadSpec(args);
  const errs = validateSpec(spec);
  if (errs.length > 0) {
    console.error('ERROR: spec failed validation:');
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(2);
  }

  const expected = atomFromSpec(spec, operatorId);
  if (args.dryRun) {
    console.log('[decide] (dry-run) would write atom:');
    console.log(JSON.stringify(expected, null, 2));
    return;
  }

  const host = await createFileHost({ rootDir: STATE_DIR });
  const existing = await host.atoms.get(spec.id);
  if (existing === null) {
    await host.atoms.put(expected);
    console.log(`[decide] wrote atom ${spec.id} (type=${spec.type}, layer=L3)`);
    return;
  }

  const diffs = diffAtom(existing, expected);
  if (diffs.length === 0) {
    console.log(`[decide] atom ${spec.id} already present, no drift`);
    return;
  }

  console.error(`ERROR: atom ${spec.id} exists with drift:`);
  for (const d of diffs) console.error(`  - ${d}`);
  console.error('Resolve by either:');
  console.error('  - reconcile your spec with the stored atom, OR');
  console.error('  - supersede the stored atom via a different id + provenance.kind=canon-promoted chain');
  process.exit(1);
}

await main();
