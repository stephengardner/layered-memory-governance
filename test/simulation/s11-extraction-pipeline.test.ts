/**
 * Scenario s11: L0 -> L1 -> L2 -> L3 pipeline end-to-end.
 *
 * The full atom-lifecycle in one test, proving Phase 43's extraction
 * primitive ties ingest (Phase 40) to promotion (Phase 5) to canon
 * rendering (Phase 10):
 *
 *   1. Two L0 atoms from two distinct agents carry logically-equivalent
 *      transcript lines.
 *   2. runExtractionPass lifts both into L1 atoms. Each L1 atom's id is
 *      prefixed by its source atom id, so two agents producing the same
 *      claim yield two distinct L1 atoms (different ids, same content
 *      hash). That preserves per-principal contribution.
 *   3. PromotionEngine sees two distinct principals with the same content
 *      hash at L1; consensus threshold met; promotes to L2.
 *   4. The L2 atom is canon-ready (provenance.kind='canon-promoted') and
 *      points back to both L0 transcript sources through the derived_from
 *      chain that traverses L1.
 *
 * This is Principle 5 made visible: if it cannot self-bootstrap from its
 * own design conversation, it does not work. And also: the full
 * autonomous-org story (multiple agents reinforcing a claim, LAG
 * promoting it automatically) requires all three layers working in
 * concert.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runExtractionPass } from '../../src/extraction/index.js';
import { PromotionEngine } from '../../src/promotion/index.js';
import { EXTRACT_CLAIMS, type ExtractClaimsOutput } from '../../src/schemas/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom, samplePrincipal } from '../fixtures.js';

const operator = 'stephen-human' as PrincipalId;
const agentAlice = 'claude-agent-alice' as PrincipalId;
const agentBob = 'claude-agent-bob' as PrincipalId;
const extractor = 'extraction-pass' as PrincipalId;
const FIXED = '2026-04-19T00:00:00.000Z' as Time;

function registerExtract(
  host: ReturnType<typeof createMemoryHost>,
  atom: Atom,
  output: ExtractClaimsOutput,
) {
  host.llm.register(
    EXTRACT_CLAIMS.jsonSchema,
    EXTRACT_CLAIMS.systemPrompt,
    { content: atom.content, type: atom.type, layer: atom.layer },
    output,
  );
}

describe('s11: L0 -> L1 extraction -> L2 promotion pipeline', () => {
  it('two agents reinforcing the same claim promotes to L2 canon', async () => {
    const host = createMemoryHost();

    // Seed the two-principal org with two agents reporting to the operator.
    await host.principals.put(samplePrincipal({
      id: operator,
      name: 'Operator',
      role: 'user',
      signed_by: null,
      created_at: FIXED,
    }));
    await host.principals.put(samplePrincipal({
      id: agentAlice,
      name: 'Alice',
      role: 'agent',
      signed_by: operator,
      created_at: FIXED,
    }));
    await host.principals.put(samplePrincipal({
      id: agentBob,
      name: 'Bob',
      role: 'agent',
      signed_by: operator,
      created_at: FIXED,
    }));

    // Each agent contributes an L0 transcript line. Text differs; claim
    // is logically equivalent. Real agents rarely phrase things
    // identically, so the extractor's job is to lift the common claim.
    const aliceL0 = sampleAtom({
      id: 'l0-alice' as AtomId,
      content: 'Alice: we agreed in the meeting that Postgres is the canonical OLTP database.',
      type: 'observation',
      layer: 'L0',
      principal_id: agentAlice,
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    const bobL0 = sampleAtom({
      id: 'l0-bob' as AtomId,
      content: 'Bob: confirmed with the VP that OLTP stays on Postgres going forward.',
      type: 'observation',
      layer: 'L0',
      principal_id: agentBob,
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    await host.atoms.put(aliceL0);
    await host.atoms.put(bobL0);

    // Both extractions produce the SAME canonical claim text. Per-source
    // atom id prefix keeps them as distinct L1 atoms with the same
    // content hash; that is what PromotionEngine sees as consensus.
    const sharedClaim = 'Postgres is the canonical OLTP database.';
    registerExtract(host, aliceL0, {
      claims: [{ type: 'decision', content: sharedClaim, confidence: 0.92 }],
    });
    registerExtract(host, bobL0, {
      claims: [{ type: 'decision', content: sharedClaim, confidence: 0.88 }],
    });

    // Step 1: run extraction pass (L0 to L1).
    const extractionReport = await runExtractionPass(host, { principalId: extractor });
    expect(extractionReport.sourcesExtracted).toBe(2);
    expect(extractionReport.totalClaimsWritten).toBe(2);

    // Verify: two L1 atoms, one per agent, each pointing back to its L0
    // source via derived_from.
    const l1Page = await host.atoms.query({ layer: ['L1'] }, 10);
    expect(l1Page.atoms).toHaveLength(2);
    const principalIds = new Set(l1Page.atoms.map((a) => a.principal_id));
    expect(principalIds).toEqual(new Set([agentAlice, agentBob]));
    for (const atom of l1Page.atoms) {
      expect(atom.provenance.kind).toBe('llm-refined');
      expect(atom.provenance.derived_from).toHaveLength(1);
    }

    // The two L1 atoms must share a content hash so promotion sees
    // consensus across distinct principals.
    const hashes = new Set(l1Page.atoms.map((a) => host.atoms.contentHash(a.content)));
    expect(hashes.size).toBe(1);

    // Step 2: run promotion (L1 to L2). Default threshold is consensus >= 2,
    // confidence >= 0.7. We have two distinct principals; average
    // confidence is 0.90; threshold met.
    const engine = new PromotionEngine(host, { principalId: operator });
    const outcomes = await engine.runPass('L2');
    const promoted = outcomes.filter((o) => o.kind === 'promoted');
    expect(promoted).toHaveLength(1);

    // Step 3: verify L2 atom exists, canon-promoted, with derived_from
    // pointing to the L1 atoms (and transitively to L0).
    const l2Page = await host.atoms.query({ layer: ['L2'] }, 10);
    expect(l2Page.atoms).toHaveLength(1);
    const l2 = l2Page.atoms[0]!;
    expect(l2.content).toBe(sharedClaim);
    expect(l2.provenance.kind).toBe('canon-promoted');
    expect(l2.provenance.derived_from.length).toBeGreaterThanOrEqual(1);

    // Audit trail: the full trajectory (2 extraction events + 1 promotion)
    // is reconstructible from the audit log.
    const extractions = await host.auditor.query({ kind: ['extraction.applied'] }, 10);
    expect(extractions).toHaveLength(2);
    const promotions = await host.auditor.query({ kind: ['promotion.applied'] }, 10);
    expect(promotions.length).toBeGreaterThanOrEqual(1);
  });
});
