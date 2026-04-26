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

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap] ERROR: LAG_OPERATOR_ID is not set. Export it and re-run.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

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

  // ---- Development principles (Phase 55-pre) ----------------------
  // These directives are the "soul" inputs for the PlanningActor.
  // validatePlan runs every proposed plan through arbitration against
  // L3; a plan that conflicts with any of these either escalates or
  // is rejected. They are canon atoms, not prompt strings, so the
  // enforcement is structural, not advisory.
  {
    id: 'dev-extreme-rigor-and-research',
    type: 'directive',
    content: 'Development decisions require extreme rigor and research before shipping. Never ship what is "mostly right" without sourced reasoning; prior atoms, DECISIONS entries, prior art, and external docs must be searched and weighed. Plans that skip this step are escalated.',
    confidence: 1.0,
  },
  {
    id: 'dev-right-over-easy',
    type: 'directive',
    content: 'When a path is easy but compromises pluggability, composability, substrate discipline, or future-proofing, choose the right path instead. Surface the trade-off explicitly in the plan. The easy path without acknowledgment of what it costs is a plan failure.',
    confidence: 1.0,
  },
  {
    id: 'dev-forward-thinking-no-regrets',
    type: 'directive',
    content: 'Design decisions must survive a 3-month-later review without regret. Proposed plans must articulate how they will still be sound when the org has 10x more actors, 10x more canon, and an order of magnitude more external integrations. Plans that optimize for this week break later.',
    confidence: 1.0,
  },
  {
    id: 'dev-substrate-not-prescription',
    type: 'directive',
    content: 'Framework code under src/ must stay mechanism-focused and pluggable. Role names, specific org shapes, vendor-specific logic, and our instance configuration belong in canon, skills, or examples, never in src/. Plans that encode our org shape into framework primitives are rejected.',
    confidence: 1.0,
  },
  {
    id: 'dev-simple-surface-deep-architecture',
    type: 'directive',
    content: 'LAG must be simple to describe to a human ("governance substrate for autonomous agents") while having architecture deep enough to support orgs running 50+ concurrent actors. Plans that add complexity to the surface or thin the architecture are rejected. Subpath imports, sharp hello-world stories, layered tutorials are mechanisms that serve this.',
    confidence: 1.0,
  },
  {
    id: 'dev-flag-structural-concerns',
    type: 'directive',
    content: 'Any agent or actor operating in this org is required to flag structural concerns proactively when a proposed path compromises pluggability, simple-surface, substrate discipline, or fit for consumers beyond our current scope. Silent execution of a shape-compromising decision is a violation; surfaced concerns are the right behaviour even when the concern is ultimately overruled.',
    confidence: 1.0,
  },
  {
    id: 'dev-no-claude-attribution',
    type: 'directive',
    content: 'Artifacts shipped to this repo must not credit an AI assistant. Commits, PR bodies, PR comments, and any tracked file must not carry Co-Authored-By trailers or "Generated with" markers for Claude or any other AI. The assistant is a tool; authorship is the operator. This rule is strict and governs every future commit.',
    confidence: 1.0,
  },
  {
    id: 'dev-indie-floor-org-ceiling',
    type: 'directive',
    content: 'LAG must be useful to a single developer with a default host and a Claude Code session directory, AND to an org running 50+ concurrent actors with BYO adapters. Both are first-class users. Every design decision must articulate how it serves both ends of this spectrum; plans that optimize only for one end are rejected. The solo developer uses zero-config defaults; the org swaps in BYO adapters without the framework changing shape. Indie floor and org ceiling are both load-bearing; either breaking invalidates the substrate story.',
    confidence: 1.0,
  },
  {
    id: 'dev-no-hacks-without-approval',
    type: 'directive',
    content: 'No hacky workarounds, shortcuts, or quick-fixes without explicit operator approval. If a clean path appears blocked, surface the blocker and propose the right route; do not silently ship a workaround. The operator can approve a hack case-by-case as an escape hatch, but the gate is always present in the plan; you raise the dial, you do not remove the gate. Silent hacks are a violation; surfaced trade-offs with the cleaner alternative articulated are the right behaviour.',
    confidence: 1.0,
  },
  {
    id: 'dev-rigor-tokens-not-constraint',
    type: 'directive',
    content: 'Token spend on research before a load-bearing decision is never the constraint. Better to spend on parallel investigation and synthesis than to guess and ship wrong. When a decision is large, run multiple research passes concurrently and synthesize the findings; do not serialize a single thread of inquiry. This directive reinforces dev-extreme-rigor-and-research with an explicit budget posture; research spend pays back through decisions that survive the 3-month-later review.',
    confidence: 1.0,
  },
  {
    id: 'dev-no-premature-stop',
    type: 'directive',
    content: 'Autonomous agents must not stop prematurely. If a turn announces continuation ("proceeding with X", "starting Y now", "continuing with Z", "moving on to W") it MUST execute the claimed action in the same turn via tool calls. Announcing forward motion without taking it is a discipline failure. The Stop-event hook (.claude/hooks/stop-continuation-guard.mjs) catches this mechanically; this atom is the governance-layer rationale so future agents and the PlanningActor inherit the rule from canon. If the work is genuinely complete, say so explicitly ("done", "awaiting direction") instead of announcing an action.',
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

  // Two principals: human operator (root) and the agent (signed_by operator).
  // This repo IS its own first LAG-governed organization (see DECISIONS.md D12).
  // Changing the operator id is a one-line override per-install.
  const operatorId = OPERATOR_ID;
  const agentId = process.env.LAG_AGENT_ID || 'claude-agent';
  const principalId = operatorId; // L3 canon is operator-signed by default.

  await host.principals.put({
    id: operatorId,
    name: 'Apex Agent',
    role: 'apex',
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

  await host.principals.put({
    id: agentId,
    name: 'Agent (Claude Code instance)',
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2'], // agent cannot write L3 directly; only via consensus or operator gate
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: operatorId, // depth 1
    created_at: BOOTSTRAP_TIME,
  });

  // Seed L3 atoms. Idempotent per id: existing atoms are skipped if
  // their content matches the seed; divergence throws (atoms are
  // content-immutable in the model, so a changed seed text means
  // either a new seed id or a reset of .lag).
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
      supersedes: Array.isArray(seed.supersedes) ? seed.supersedes : [],
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
      // Atoms are content-immutable per the core model. If a seed's
      // text has drifted from what was written, silently skipping
      // would leave the store stale (and the rendered canon with
      // it). Detect divergence and fail loudly so the operator
      // either supersedes the atom with a new id or resets .lag
      // before re-seeding. This is exactly the "fail fast if seed
      // drifts" discipline for canon.
      if (
        existing.content !== atom.content
        || existing.type !== atom.type
        || existing.confidence !== atom.confidence
      ) {
        throw new Error(
          `Seed atom '${seed.id}' drifted from bootstrap source.\n`
          + `  stored content: ${JSON.stringify(existing.content).slice(0, 80)}\n`
          + `  seed content:   ${JSON.stringify(atom.content).slice(0, 80)}\n`
          + `Fix by either (a) creating a new seed with a different id and\n`
          + `marking this one superseded, or (b) resetting .lag before re-running\n`
          + `bootstrap if the store was never shared.`,
        );
      }
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
