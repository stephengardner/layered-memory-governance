#!/usr/bin/env node
/**
 * canon-scout-sweep: stub scout that writes a single canon-proposal-
 * suggestion atom from explicit flag input. The real LLM-backed chat
 * scanner is a follow-up (see docs/proposals/ when shipped); v1 just
 * needs the data shape + operator UX path working end-to-end so the
 * triage CLI + console panel have something to read.
 *
 * The atom written here is at L1 with metadata.kind='canon-proposal-
 * suggestion' and provenance.kind='agent-observed'. It NEVER promotes
 * to L3; promotion happens via scripts/decide.mjs invoked by the
 * operator, gated by inv-l3-requires-human.
 *
 * Usage:
 *   node scripts/canon-scout-sweep.mjs \
 *     --from-text "<operator chat excerpt>" \
 *     --suggested-id dev-foo-bar \
 *     --suggested-type directive \
 *     --proposed-content "<canon-quality prose, >= 20 chars>" \
 *     [--confidence 0.7] \
 *     [--scout-id canon-scout-stub] \
 *     [--dry-run]
 *
 * The stub principal id defaults to `canon-scout-stub`; operators can
 * pass --scout-id to use a real registered principal once the LLM scout
 * lands.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createFileHost } from '../dist/adapters/file/index.js';
import { buildSuggestionAtom } from './lib/canon-suggestion.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

function parseArgs(argv) {
  const args = {
    fromText: null,
    suggestedId: null,
    suggestedType: null,
    proposedContent: null,
    confidence: 0.7,
    scoutId: 'canon-scout-stub',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-text') args.fromText = argv[++i];
    else if (a === '--suggested-id') args.suggestedId = argv[++i];
    else if (a === '--suggested-type') args.suggestedType = argv[++i];
    else if (a === '--proposed-content') args.proposedContent = argv[++i];
    else if (a === '--confidence') args.confidence = Number(argv[++i]);
    else if (a === '--scout-id') args.scoutId = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: see docstring in scripts/canon-scout-sweep.mjs');
      process.exit(0);
    } else {
      console.error(`[canon-scout-sweep] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = [];
  if (!args.fromText) missing.push('--from-text');
  if (!args.suggestedId) missing.push('--suggested-id');
  if (!args.suggestedType) missing.push('--suggested-type');
  if (!args.proposedContent) missing.push('--proposed-content');
  if (missing.length > 0) {
    console.error(`[canon-scout-sweep] missing required flags: ${missing.join(', ')}`);
    process.exit(2);
  }

  const spec = {
    suggested_id: args.suggestedId,
    suggested_type: args.suggestedType,
    proposed_content: args.proposedContent,
    chat_excerpt: args.fromText,
    confidence: args.confidence,
    scout_principal_id: args.scoutId,
  };

  const now = new Date();
  const nonce = randomBytes(4).toString('hex');
  let atom;
  try {
    atom = buildSuggestionAtom(spec, { now, nonce });
  } catch (err) {
    console.error(`[canon-scout-sweep] ${err.message}`);
    process.exit(2);
  }

  if (args.dryRun) {
    console.log('[canon-scout-sweep] --dry-run; would write:');
    console.log(JSON.stringify(atom, null, 2));
    return;
  }

  const host = await createFileHost({ rootDir: STATE_DIR });
  await host.atoms.put(atom);
  console.log(`[canon-scout-sweep] wrote suggestion ${atom.id}`);
  console.log(`  suggested ${atom.metadata.suggested_type}: ${atom.metadata.suggested_id}`);
  console.log(`  triage: node scripts/canon-suggest-triage.mjs --atom-id ${atom.id} --action <promote|dismiss|defer>`);
}

main().catch((err) => {
  console.error(`[canon-scout-sweep] ${err.message}`);
  process.exit(1);
});
