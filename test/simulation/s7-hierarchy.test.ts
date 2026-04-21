/**
 * Scenario s7: principal hierarchy as arbitration tiebreaker.
 *
 * The autonomous-organization story, proved end-to-end:
 *   - A root principal (depth 0) signs a VP (depth 1), who signs an IC (depth 2).
 *   - Two conflicting atoms at identical layer + provenance + confidence
 *     should be broken by principal depth: closer-to-root wins.
 *   - The walker handles cycles and broken signed_by chains without
 *     infinite-looping or accidentally outranking legit principals.
 *   - Arbitration wires this through correctly: the arbiter fetches
 *     both principals' depths before scoring, and the decision's reason
 *     string records both depths for auditability.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  arbitrate,
  computePrincipalDepth,
  DETECT_SCHEMA,
  DETECT_SYSTEM,
  MAX_PRINCIPAL_DEPTH,
} from '../../src/arbitration/index.js';
import { sourceRank, sourceRankDecide } from '../../src/arbitration/source-rank.js';
import type { PrincipalId, Time } from '../../src/substrate/types.js';
import { samplePrincipal, sampleAtom } from '../fixtures.js';

const arbiter = 'arbiter_s7' as PrincipalId;

/**
 * Seed a three-level chain: root -> vp-eng -> alice.
 * Returns ids for convenience.
 */
async function seedChain(host: ReturnType<typeof createMemoryHost>): Promise<{
  rootId: PrincipalId;
  vpId: PrincipalId;
  aliceId: PrincipalId;
}> {
  const rootId = 'root_human' as PrincipalId;
  const vpId = 'vp_eng' as PrincipalId;
  const aliceId = 'alice_ic' as PrincipalId;
  const t = '2026-04-19T00:00:00.000Z' as Time;
  await host.principals.put(samplePrincipal({
    id: rootId,
    name: 'Root Human',
    role: 'user',
    signed_by: null,
    created_at: t,
  }));
  await host.principals.put(samplePrincipal({
    id: vpId,
    name: 'VP of Engineering',
    role: 'agent',
    signed_by: rootId,
    created_at: t,
  }));
  await host.principals.put(samplePrincipal({
    id: aliceId,
    name: 'Alice (IC agent)',
    role: 'agent',
    signed_by: vpId,
    created_at: t,
  }));
  return { rootId, vpId, aliceId };
}

describe('s7: principal hierarchy depth', () => {
  it('walks signed_by up to the root, returning correct depth at each level', async () => {
    const host = createMemoryHost();
    const { rootId, vpId, aliceId } = await seedChain(host);
    expect(await computePrincipalDepth(rootId, host.principals)).toBe(0);
    expect(await computePrincipalDepth(vpId, host.principals)).toBe(1);
    expect(await computePrincipalDepth(aliceId, host.principals)).toBe(2);
  });

  it('returns MAX_PRINCIPAL_DEPTH for a principal that does not exist', async () => {
    const host = createMemoryHost();
    const ghost = 'ghost_principal' as PrincipalId;
    expect(await computePrincipalDepth(ghost, host.principals)).toBe(MAX_PRINCIPAL_DEPTH);
  });

  it('returns MAX_PRINCIPAL_DEPTH for a broken chain (signed_by points to missing)', async () => {
    const host = createMemoryHost();
    const orphan = 'orphan' as PrincipalId;
    const dangling = 'never_existed' as PrincipalId;
    await host.principals.put(samplePrincipal({
      id: orphan,
      signed_by: dangling, // points to nothing
    }));
    expect(await computePrincipalDepth(orphan, host.principals)).toBe(MAX_PRINCIPAL_DEPTH);
  });

  it('returns MAX_PRINCIPAL_DEPTH for a cycle (self-signed)', async () => {
    const host = createMemoryHost();
    const selfSigned = 'loop_a' as PrincipalId;
    await host.principals.put(samplePrincipal({
      id: selfSigned,
      signed_by: selfSigned, // points to itself
    }));
    expect(await computePrincipalDepth(selfSigned, host.principals)).toBe(MAX_PRINCIPAL_DEPTH);
  });

  it('returns MAX_PRINCIPAL_DEPTH for a two-hop cycle', async () => {
    const host = createMemoryHost();
    const a = 'loop_x' as PrincipalId;
    const b = 'loop_y' as PrincipalId;
    // Have to seed a first with a placeholder signed_by, then update via re-put
    // (memory adapter's put replaces).
    await host.principals.put(samplePrincipal({ id: a, signed_by: b }));
    await host.principals.put(samplePrincipal({ id: b, signed_by: a }));
    expect(await computePrincipalDepth(a, host.principals)).toBe(MAX_PRINCIPAL_DEPTH);
  });
});

describe('s7: source-rank hierarchy tiebreaker (pure scoring)', () => {
  it('lower-depth principal outranks higher-depth at equal layer/provenance/confidence', () => {
    const atom = sampleAtom({
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
    });
    // Same atom contents; only the caller-supplied depth differs.
    expect(sourceRank(atom, 0)).toBeGreaterThan(sourceRank(atom, 2));
    expect(sourceRank(atom, 1)).toBeGreaterThan(sourceRank(atom, 2));
  });

  it('higher layer still dominates even when depth disadvantages the higher-layer atom', () => {
    const l0Root = sampleAtom({ layer: 'L0', confidence: 1 });
    const l2Deep = sampleAtom({ layer: 'L2', confidence: 0 });
    expect(sourceRank(l2Deep, MAX_PRINCIPAL_DEPTH)).toBeGreaterThan(sourceRank(l0Root, 0));
  });

  it('sourceRankDecide uses depth when layer + provenance are equal', () => {
    const vpAtom = sampleAtom({
      id: 'vp-atom' as never,
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
    });
    const aliceAtom = sampleAtom({
      id: 'alice-atom' as never,
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
    });
    const outcome = sourceRankDecide(
      { a: vpAtom, b: aliceAtom, kind: 'semantic', explanation: 'test' },
      { depthA: 1, depthB: 2 },
    );
    expect(outcome?.kind).toBe('winner');
    if (outcome?.kind === 'winner') {
      expect(outcome.winner).toBe(vpAtom.id);
      expect(outcome.reason).toContain('depthA=1');
      expect(outcome.reason).toContain('depthB=2');
    }
  });

  it('still returns null when depths are also tied (genuine deadlock falls through)', () => {
    const a = sampleAtom({ layer: 'L1', confidence: 0.5 });
    const b = sampleAtom({ layer: 'L1', confidence: 0.5 });
    const outcome = sourceRankDecide(
      { a, b, kind: 'semantic', explanation: 'test' },
      { depthA: 2, depthB: 2 },
    );
    expect(outcome).toBeNull();
  });
});

describe('s7: end-to-end arbitration picks up hierarchy through arbitrate()', () => {
  it('VP atom beats Alice atom when layer + provenance + confidence tie', async () => {
    const host = createMemoryHost();
    const { vpId, aliceId } = await seedChain(host);

    const vpAtom = sampleAtom({
      content: 'API responses must include request_id.',
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
      principal_id: vpId,
    });
    const aliceAtom = sampleAtom({
      content: 'API responses need not include request_id.',
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
      principal_id: aliceId,
    });
    host.llm.register(
      DETECT_SCHEMA,
      DETECT_SYSTEM,
      {
        atom_a: { content: vpAtom.content, type: vpAtom.type, layer: vpAtom.layer, created_at: vpAtom.created_at },
        atom_b: { content: aliceAtom.content, type: aliceAtom.type, layer: aliceAtom.layer, created_at: aliceAtom.created_at },
      },
      { kind: 'semantic', explanation: 'Contradictory claims about request_id.' },
    );

    const decision = await arbitrate(vpAtom, aliceAtom, host, { principalId: arbiter });
    expect(decision.ruleApplied).toBe('source-rank');
    expect(decision.outcome.kind).toBe('winner');
    if (decision.outcome.kind === 'winner') {
      expect(decision.outcome.winner).toBe(vpAtom.id);
      expect(decision.outcome.loser).toBe(aliceAtom.id);
      expect(decision.outcome.reason).toContain('depthA=1');
      expect(decision.outcome.reason).toContain('depthB=2');
    }
  });

  it('Root atom beats Alice atom (depth 0 over depth 2)', async () => {
    const host = createMemoryHost();
    const { rootId, aliceId } = await seedChain(host);

    const rootAtom = sampleAtom({
      content: 'All services must emit structured logs.',
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
      principal_id: rootId,
    });
    const aliceAtom = sampleAtom({
      content: 'Services should log plain text for readability.',
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
      principal_id: aliceId,
    });
    host.llm.register(
      DETECT_SCHEMA,
      DETECT_SYSTEM,
      {
        atom_a: { content: rootAtom.content, type: rootAtom.type, layer: rootAtom.layer, created_at: rootAtom.created_at },
        atom_b: { content: aliceAtom.content, type: aliceAtom.type, layer: aliceAtom.layer, created_at: aliceAtom.created_at },
      },
      { kind: 'semantic', explanation: 'Opposing log-format guidance.' },
    );

    const decision = await arbitrate(rootAtom, aliceAtom, host, { principalId: arbiter });
    expect(decision.ruleApplied).toBe('source-rank');
    expect(decision.outcome.kind).toBe('winner');
    if (decision.outcome.kind === 'winner') {
      expect(decision.outcome.winner).toBe(rootAtom.id);
      expect(decision.outcome.reason).toContain('depthA=0');
      expect(decision.outcome.reason).toContain('depthB=2');
    }
  });

  it('layer still dominates over hierarchy (Alice L2 beats Root L1)', async () => {
    const host = createMemoryHost();
    const { rootId, aliceId } = await seedChain(host);

    const rootAtomL1 = sampleAtom({
      content: 'Root prefers X.',
      layer: 'L1',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
      principal_id: rootId,
    });
    const aliceAtomL2 = sampleAtom({
      content: 'Curated convention: use Y.',
      layer: 'L2',
      confidence: 0.5,
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
      principal_id: aliceId,
    });
    host.llm.register(
      DETECT_SCHEMA,
      DETECT_SYSTEM,
      {
        atom_a: { content: rootAtomL1.content, type: rootAtomL1.type, layer: rootAtomL1.layer, created_at: rootAtomL1.created_at },
        atom_b: { content: aliceAtomL2.content, type: aliceAtomL2.type, layer: aliceAtomL2.layer, created_at: aliceAtomL2.created_at },
      },
      { kind: 'semantic', explanation: 'Layer-vs-hierarchy tie-off.' },
    );

    const decision = await arbitrate(rootAtomL1, aliceAtomL2, host, { principalId: arbiter });
    expect(decision.ruleApplied).toBe('source-rank');
    expect(decision.outcome.kind).toBe('winner');
    if (decision.outcome.kind === 'winner') {
      // L2 curated atom wins despite belonging to a deeper principal.
      expect(decision.outcome.winner).toBe(aliceAtomL2.id);
    }
  });
});
