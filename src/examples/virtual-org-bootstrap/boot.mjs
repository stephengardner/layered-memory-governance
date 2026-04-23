#!/usr/bin/env node
/**
 * Virtual-org bootstrap entry point.
 *
 * Spins up a two-agent deliberation (CTO + Code Author) against a
 * memory-backed substrate and prints the resulting Decision or
 * Escalation. The question prompt comes from argv[2] or stdin; if
 * neither is provided a default smoke prompt is used.
 *
 * Runtime wiring:
 *   - Memory-backed Host (in-process AtomStore, PrincipalStore, Clock).
 *     Replaceable with createFileHost when persistence is wanted; the
 *     downstream code is Host-shape-agnostic.
 *   - Kill-switch watching `.lag/STOP` in the current working directory.
 *   - Default LLM backend: Claude Code CLI subprocess (no API key). Set
 *     LAG_LLM_BACKEND=sdk + ANTHROPIC_API_KEY to opt into the direct
 *     Anthropic SDK; the SDK path is the only one that surfaces
 *     plaintext extended-thinking blocks.
 *
 * All substrate imports resolve to `../../../dist/` (the compiled
 * output). Run `npm run build` before `node boot.mjs`.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';

import { createMemoryHost } from '../../../dist/adapters/memory/index.js';
import { createKillSwitch } from '../../../dist/kill-switch/index.js';
import {
  createCanonRenderer,
  createDeliberationSink,
  createReasoningSink,
  defaultLlmClient,
  loadCanonFixtures,
  loadSeedPrincipals,
  runDeliberation,
} from '../../../dist/examples/virtual-org-bootstrap/boot-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const STATE_DIR = resolve(CWD, '.lag');

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });

  const args = parseArgs(process.argv.slice(2));

  const principalsDir = join(HERE, 'principals');
  const canonDir = join(HERE, 'canon');
  const seeds = loadSeedPrincipals({ dir: principalsDir });
  const canonAtoms = loadCanonFixtures(canonDir);

  const host = createMemoryHost();
  for (const seed of seeds) {
    await host.principals.put(seed.principal);
  }
  for (const atom of canonAtoms) {
    await host.atoms.put(atom);
  }

  const killSwitch = createKillSwitch({ stateDir: STATE_DIR });

  const prompt = await readPrompt(args.prompt);
  const question = {
    id: `q-${Date.now()}`,
    type: 'question',
    prompt,
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };

  // Default: CLI client (no API key). When LAG_LLM_BACKEND=sdk is set,
  // dynamic-import @anthropic-ai/sdk to avoid pulling it in on the
  // CLI-only path. If ANTHROPIC_API_KEY is also unset the SDK throws
  // at first request; we surface that error loudly rather than
  // silently falling back.
  let sdkFactory;
  if (process.env.LAG_LLM_BACKEND === 'sdk') {
    const { Anthropic } = await import('@anthropic-ai/sdk');
    sdkFactory = () => new Anthropic();
  }
  const anthropic = defaultLlmClient(
    sdkFactory !== undefined ? { sdkFactory } : {},
  );

  const participating = seeds.filter(
    (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
  );

  try {
    const result = await runDeliberation({
      question,
      participants: participating,
      atomStore: host.atoms,
      principalStore: host.principals,
      anthropic,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      signal: killSwitch.signal,
      execute: !args.deliberateOnly,
      executorPrincipalId: 'vo-code-author',
      // Full Host thread-through for the executor path: runCodeAuthor
      // reaches beyond atoms/principals into notifier/scheduler/auditor/
      // canon/clock/llm, so the deliberate-only path is the only one
      // that can skip this field.
      host,
    });
    console.log(JSON.stringify(result, null, 2));
    const typeCounts = await summarizeAtomCounts(host.atoms);
    console.error(`[boot] atoms written by type: ${JSON.stringify(typeCounts)}`);
    if (args.deliberateOnly) {
      console.error('[boot] --deliberate-only: skipped execution path');
    } else if (result.execution) {
      console.error(`[boot] execution: ${result.execution.kind}`);
    } else {
      console.error('[boot] execution: not triggered (escalation outcome)');
    }
  } finally {
    killSwitch.dispose();
  }
}

function parseArgs(argv) {
  let deliberateOnly = false;
  const positional = [];
  for (const a of argv) {
    if (a === '--deliberate-only') {
      deliberateOnly = true;
    } else {
      positional.push(a);
    }
  }
  return { deliberateOnly, prompt: positional[0] };
}

async function readPrompt(fromArgs) {
  if (fromArgs) return fromArgs;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const combined = Buffer.concat(chunks).toString('utf8').trim();
    if (combined.length > 0) return combined;
  }
  return 'Smoke test: propose a patch-level version bump rationale.';
}

async function summarizeAtomCounts(atomStore) {
  const page = await atomStore.query({}, 10_000);
  const counts = {};
  for (const atom of page.atoms) {
    const kindTag = typeof atom.metadata?.kind === 'string'
      ? `${atom.type}:${atom.metadata.kind}`
      : atom.type;
    counts[kindTag] = (counts[kindTag] ?? 0) + 1;
  }
  return counts;
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
