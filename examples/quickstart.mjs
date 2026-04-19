#!/usr/bin/env node
/**
 * Quickstart for layered-autonomous-governance.
 *
 * Run from the repo root (after `npm run build`):
 *   node examples/quickstart.mjs
 *
 * What it does end to end:
 *   1. Spins up an in-memory Host.
 *   2. Seeds three atoms at L1 from three distinct principals, all
 *      agreeing on the same fact (normalized-equal content).
 *   3. Searches for one of them to demonstrate retrieval.
 *   4. Runs a promotion pass targeting L2 and shows consensus lifting
 *      the atom into the curated trust layer.
 *   5. Prints the final state + audit log so the user can see what
 *      happened.
 *
 * This shows the Host factory, AtomStore put / search, the promotion
 * engine, and the audit log in under 90 lines of user-facing code.
 * Arbitration (which involves the LLM judge) lives in its own example
 * because it needs either a real Claude CLI or a pre-registered
 * MemoryLLM response.
 */

import { createMemoryHost } from '../dist/adapters/memory/index.js';
import {
  DEFAULT_THRESHOLDS,
  PromotionEngine,
  // Top-level re-exports prove `main` resolves.
  ConflictError,
} from '../dist/index.js';

async function main() {
  const host = createMemoryHost();
  const loopPrincipal = 'lag-loop';

  const baseAtom = (overrides) => ({
    schema_version: 1,
    type: 'decision',
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'demo' }, derived_from: [] },
    confidence: 0.95,
    created_at: host.clock.now(),
    last_reinforced_at: host.clock.now(),
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    taint: 'clean',
    metadata: {},
    ...overrides,
  });

  // 1. Three principals observe the same decision. Content differs in
  // casing and punctuation but collapses under the content-hash
  // normalizer, which is how consensus is counted.
  await host.atoms.put(baseAtom({
    id: 'alice-obs',
    content: 'Use Postgres as the canonical production database.',
    principal_id: 'alice',
  }));
  await host.atoms.put(baseAtom({
    id: 'bob-obs',
    content: 'use postgres as the canonical production database',
    principal_id: 'bob',
  }));
  await host.atoms.put(baseAtom({
    id: 'carol-obs',
    content: 'USE POSTGRES AS THE CANONICAL PRODUCTION DATABASE!',
    principal_id: 'carol',
  }));

  // 2. Search: the trigram embedder retrieves all three (same content).
  const hits = await host.atoms.search('production database', 5);
  console.log(`\nSearch "production database" returned ${hits.length} hits:`);
  for (const h of hits) {
    console.log(`  [${h.score.toFixed(3)}] ${h.atom.id} (principal=${h.atom.principal_id})`);
  }

  // 3. Promotion: with DEFAULT_THRESHOLDS L2 requires consensus=2,
  // confidence>=0.7. Three principals on the same content-hash class
  // satisfies both; the engine creates a new L2 atom with provenance
  // kind="canon-promoted" and supersedes the representative L1 atom.
  const engine = new PromotionEngine(host, { principalId: loopPrincipal });
  const outcomes = await engine.runPass('L2');
  console.log(`\nPromotion pass against L2 produced ${outcomes.length} candidate(s):`);
  for (const o of outcomes) {
    console.log(`  kind=${o.kind} promoted=${o.promotedAtomId ?? '(none)'}`);
    console.log(`    reason: ${o.reason}`);
  }

  // 4. Final state: one curated L2 atom plus the original L1 siblings
  // (with one of them marked superseded by the new L2).
  const l2 = await host.atoms.query({ layer: ['L2'] }, 10);
  console.log(`\nL2 atoms after promotion (${l2.atoms.length}):`);
  for (const a of l2.atoms) {
    console.log(`  ${a.id}`);
    console.log(`    content: ${a.content}`);
    console.log(`    provenance: ${a.provenance.kind}, derived_from=${JSON.stringify(a.provenance.derived_from)}`);
  }

  const allL1 = await host.atoms.query({ layer: ['L1'], superseded: true }, 10);
  const superseded = allL1.atoms.filter(a => a.superseded_by.length > 0);
  console.log(`\nL1 siblings (${allL1.atoms.length}, ${superseded.length} superseded by promotion):`);
  for (const a of allL1.atoms) {
    const marker = a.superseded_by.length > 0 ? ' [superseded]' : '';
    console.log(`  ${a.id}${marker}`);
  }

  // 5. Audit log.
  const audits = await host.auditor.query({ kind: ['promotion.applied'] }, 10);
  console.log(`\nAudit log (${audits.length} promotion.applied event(s)):`);
  for (const e of audits) {
    console.log(`  kind=${e.kind} by=${e.principal_id}`);
    console.log(`    target_layer=${e.details.target_layer} consensus=${e.details.consensus_count}`);
  }

  // Reference top-level re-exports so their resolution is exercised.
  console.log(`\nConfig reference: L2 threshold ${JSON.stringify(DEFAULT_THRESHOLDS.L2)}`);
  if (ConflictError.name !== 'ConflictError') {
    throw new Error('top-level ConflictError re-export broken');
  }

  console.log('\nQuickstart OK.');
}

main().catch(err => {
  console.error('Quickstart failed:', err);
  process.exit(1);
});
