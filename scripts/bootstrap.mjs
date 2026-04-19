#!/usr/bin/env node
/**
 * LAG self-bootstrap.
 *
 * Run from the repo root (after `npm run build`):
 *   node scripts/bootstrap.mjs
 *
 * Or via the npm script:
 *   npm run bootstrap
 *
 * What this does:
 *   1. Creates a `file` host rooted at `.lag/` inside this repo.
 *   2. Registers a single root principal (`lag-self`) with no parent.
 *   3. Writes a curated set of L3 atoms that encode this repo's
 *      settled invariants: principles, architectural decisions,
 *      and references to the source of truth docs.
 *   4. Runs one LoopRunner tick with only the canon applier enabled,
 *      rendering the L3 atoms into a bracketed section of CLAUDE.md.
 *
 * Result: a CLAUDE.md in the repo root that LAG generated from its
 * own L3 atoms, which future agents working on this repo will read.
 * That is the self-bootstrap Principle 5 promised.
 *
 * Determinism: atom timestamps are hardcoded to a frozen date, so
 * re-running the script on unchanged invariants produces a byte-
 * identical CLAUDE.md. The generator derives its "last updated"
 * header from the newest atom's reinforcement time, not wall-clock.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { LoopRunner } from '../dist/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const CANON_FILE = resolve(REPO_ROOT, 'CLAUDE.md');

/**
 * Frozen timestamp for bootstrap atoms. Bumping this date is how we
 * signal "the canon is being refreshed" (the generator's header picks
 * it up automatically). Keep this deterministic.
 */
const BOOTSTRAP_TIME = '2026-04-19T00:00:00.000Z';

/**
 * The curated L3 atom set. Each entry becomes one atom at L3 written
 * by the `lag-self` root principal.
 *
 * Categories (mapped to atom `type`):
 *   - directive:   "always/never do X" rules
 *   - decision:    "we chose approach X over Y"
 *   - preference:  "default value / convention"
 *   - reference:   "canonical source for topic X"
 */
const SEED_ATOMS = [
  // ---- Directives --------------------------------------------------
  {
    id: 'inv-governance-before-autonomy',
    type: 'directive',
    content: 'Governance before autonomy. Build the deterministic rules, then tune the autonomy dial. Never the reverse.',
    confidence: 1.0,
  },
  {
    id: 'inv-provenance-every-write',
    type: 'directive',
    content: 'Every atom must carry provenance with a source chain. No exceptions. Provenance pays back every hard question later (taint cascade, compromise response, audit).',
    confidence: 1.0,
  },
  {
    id: 'inv-conflict-detect-at-write',
    type: 'directive',
    content: 'Conflict detection must happen at write time via the arbitration stack. A nightly batch pass is always too late. The cost of real-time detection is an accepted trade.',
    confidence: 1.0,
  },
  {
    id: 'inv-l3-requires-human',
    type: 'directive',
    content: 'L3 promotion requires human approval by default. The autonomy dial can auto-approve, but the gate is always present in the code path; you raise the dial, you do not remove the gate.',
    confidence: 1.0,
  },
  {
    id: 'inv-kill-switch-first',
    type: 'directive',
    content: 'Design the kill switch before moving the autonomy dial. Soft tier (STOP sentinel) is required; medium and hard tiers are roadmap but the seams are reserved.',
    confidence: 1.0,
  },
  {
    id: 'inv-no-private-terms',
    type: 'directive',
    content: 'CI package-hygiene guard rejects private-term leaks and emdashes anywhere in tracked files. The specific term list lives in .github/workflows/ci.yml; do not echo those terms in source, docs, or committed canon.',
    confidence: 1.0,
  },

  // ---- Decisions ---------------------------------------------------
  {
    id: 'arch-atomstore-source-of-truth',
    type: 'decision',
    content: 'The AtomStore is the single source of truth. Every other artifact (canon markdown, dashboards, audit reports, agent context) is a projection over the atom set. Never derive from or write to a projection directly.',
    confidence: 1.0,
  },
  {
    id: 'arch-principal-hierarchy-signed-by',
    type: 'decision',
    content: 'Principals form a hierarchy via signed_by. Authority cascades from root down. Arbitration respects the chain (source-rank uses principal depth as a tiebreaker). Taint propagates transitively when a leaf is compromised.',
    confidence: 1.0,
  },
  {
    id: 'arch-notifier-is-a-channel',
    type: 'decision',
    content: 'The Notifier is a pluggable channel seam, not a hardcoded file queue. File queue is the V0 implementation; Telegram, Slack, session-inject, and email are channel implementations behind the same interface. Callers never branch on channel type.',
    confidence: 1.0,
  },
  {
    id: 'arch-retrieval-stack-not-embedder',
    type: 'decision',
    content: 'Retrieval is a stack, not a single embedder. Trigram for cheap lexical recall, ONNX MiniLM for semantic, caching decorator for repeat queries. Users compose; the framework does not pick one winner.',
    confidence: 1.0,
  },
  {
    id: 'arch-canon-bracketed-section',
    type: 'decision',
    content: 'Canon renders into a bracketed section of a target CLAUDE.md file via CanonMdManager. Content outside the markers is preserved byte-for-byte. Multi-target canon (one file per scope or role) composes via LoopRunner.canonTargets.',
    confidence: 1.0,
  },
  {
    id: 'arch-host-interface-boundary',
    type: 'decision',
    content: 'The Host interface is the sole boundary between framework logic and any concrete implementation. Eight sub-interfaces: AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock. LAG logic never reaches around this boundary.',
    confidence: 1.0,
  },

  // ---- Preferences / conventions -----------------------------------
  {
    id: 'conv-source-rank-formula',
    type: 'preference',
    content: 'Source-rank scoring formula: Layer x 10000 + Provenance x 100 + (MAX_PRINCIPAL_DEPTH - depth) x 10 + floor(confidence x 10). Layer dominates provenance dominates hierarchy dominates confidence; confidence only breaks ties within a layer.',
    confidence: 1.0,
  },
  {
    id: 'conv-default-l2-threshold',
    type: 'preference',
    content: 'Default L2 promotion threshold: distinct-principal consensus >= 2, confidence >= 0.7. No validator requirement. Override per-tenant via DEFAULT_THRESHOLDS.',
    confidence: 1.0,
  },
  {
    id: 'conv-default-l3-threshold',
    type: 'preference',
    content: 'Default L3 promotion threshold: distinct-principal consensus >= 3, confidence >= 0.9, plus human approval through the Notifier gate. Validators optional but encouraged.',
    confidence: 1.0,
  },
  {
    id: 'conv-max-principal-depth',
    type: 'preference',
    content: 'MAX_PRINCIPAL_DEPTH = 9. Chains deeper than this are capped. Realistic org depth (human -> CEO -> VP -> director -> manager -> IC -> agent) is 6; 9 leaves headroom.',
    confidence: 1.0,
  },

  // ---- References --------------------------------------------------
  {
    id: 'ref-target-architecture',
    type: 'reference',
    content: 'design/target-architecture.md is the north-star diagram with gap analysis and leverage-ordered roadmap. Read this first when scoping a new phase.',
    confidence: 1.0,
  },
  {
    id: 'ref-host-interface',
    type: 'reference',
    content: 'design/host-interface.md is the authoritative specification of the 8-interface Host contract every adapter must satisfy.',
    confidence: 1.0,
  },
  {
    id: 'ref-framework-doc',
    type: 'reference',
    content: 'docs/framework.md is the overall model: layers, atoms, lifecycle, arbitration, retrieval. Read after the target architecture doc.',
    confidence: 1.0,
  },
  {
    id: 'ref-readme-headline',
    type: 'reference',
    content: 'If RAG brings knowledge into an agent, LAG governs knowledge across agents. One-sentence position statement; lives in README.',
    confidence: 1.0,
  },
];

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  const principalId = 'lag-self';

  // Register the root principal. Idempotent: put() replaces if it exists.
  await host.principals.put({
    id: principalId,
    name: 'LAG self-bootstrap root',
    role: 'user',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user', 'global'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2', 'L3'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: null, // root
    created_at: BOOTSTRAP_TIME,
  });

  // Seed L3 atoms. Idempotent per id; re-running the script overwrites.
  let written = 0;
  for (const seed of SEED_ATOMS) {
    const existing = await host.atoms.get(seed.id);
    const atom = {
      schema_version: 1,
      id: seed.id,
      content: seed.content,
      type: seed.type,
      layer: 'L3',
      provenance: {
        kind: 'user-directive',
        source: { agent_id: principalId },
        derived_from: [],
      },
      confidence: seed.confidence,
      created_at: BOOTSTRAP_TIME,
      last_reinforced_at: BOOTSTRAP_TIME,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'global',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: principalId,
      taint: 'clean',
      metadata: { source: 'self-bootstrap' },
    };
    if (existing) {
      // No-op update to bump nothing: atoms are content-immutable. We only
      // need to re-put if the content changed, which is rare. Skip for
      // determinism.
      continue;
    }
    await host.atoms.put(atom);
    written += 1;
  }

  // Run one tick, canon-only, to render the atoms into CLAUDE.md.
  const runner = new LoopRunner(host, {
    principalId,
    runTtlPass: false,
    runL2Promotion: false,
    runL3Promotion: false,
    runCanonApplier: true,
    canonTargets: [
      {
        path: CANON_FILE,
        renderOptions: { now: BOOTSTRAP_TIME },
      },
    ],
  });

  const report = await runner.tick();

  console.log(`\nLAG self-bootstrap complete.`);
  console.log(`  State dir:   ${STATE_DIR}`);
  console.log(`  Canon file:  ${CANON_FILE}`);
  console.log(`  Atoms seeded (this run):  ${written}`);
  const totalPage = await host.atoms.query({}, 1000);
  console.log(`  Atoms in store (total):   ${totalPage.atoms.length}`);
  console.log(`  Canon applied:            ${report.canonApplied === 1 ? 'yes' : 'no change'}`);
  if (report.errors.length > 0) {
    console.log(`  Errors: ${report.errors.join('; ')}`);
    process.exit(1);
  }

  // Do NOT call host.cleanup(): that deletes .lag/. The whole point of the
  // file adapter is persistence across runs. Next invocation picks up the
  // existing state.
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
