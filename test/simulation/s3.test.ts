import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runScenario } from '../../src/simulation/driver.js';
import { scenarioS3 } from '../../src/simulation/scenarios/s3-promotion.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principal = 'scripted-agent-3' as PrincipalId;

describe('Simulation scenario 3 (end-to-end promotion)', () => {
  it('promotion pass at tick 4 produces a canon-promoted atom at L2', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS3, host, principal);

    // One promotion record was produced at tick 4.
    expect(result.promotions.length).toBe(1);
    const promotion = result.promotions[0]!;
    expect(promotion.atTick).toBe(4);
    expect(promotion.targetLayer).toBe('L2');
    expect(promotion.outcomeKind).toBe('promoted');
    expect(promotion.promotedAtomId).not.toBeNull();

    // A new L2 atom exists with provenance.kind = 'canon-promoted'.
    const l2 = (await host.atoms.query({ layer: ['L2'] }, 10)).atoms;
    expect(l2.length).toBe(1);
    expect(l2[0]?.provenance.kind).toBe('canon-promoted');
    expect(l2[0]?.content.toLowerCase()).toContain('postgres');
  });

  it('representative L1 atom is superseded by the new L2 atom', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS3, host, principal);
    const promotion = result.promotions[0]!;
    const l2Id = promotion.promotedAtomId!;

    // Fetch all L1 atoms including superseded ones.
    const allL1 = (await host.atoms.query(
      { layer: ['L1'], superseded: true },
      10,
    )).atoms;
    expect(allL1.length).toBe(3);

    const supersededL1 = allL1.filter(a => a.superseded_by.length > 0);
    expect(supersededL1.length).toBe(1);
    expect(supersededL1[0]?.superseded_by).toContain(l2Id);

    // The other two L1 siblings remain unsuperseded (preserve distinct provenance).
    const unsupersededL1 = allL1.filter(a => a.superseded_by.length === 0);
    expect(unsupersededL1.length).toBe(2);
  });

  it('audit log records the promotion', async () => {
    const host = createMemoryHost();
    await runScenario(scenarioS3, host, principal);
    const audits = await host.auditor.query({ kind: ['promotion.applied'] }, 10);
    expect(audits.length).toBe(1);
    expect(audits[0]?.details).toMatchObject({
      target_layer: 'L2',
      consensus_count: 3,
    });
  });

  it('default search prefers the promoted atom over remaining L1 siblings', async () => {
    const host = createMemoryHost();
    await runScenario(scenarioS3, host, principal);
    const hits = await host.atoms.search('canonical production database', 3);
    // The top hit should be a non-superseded atom that contains "postgres".
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.atom.superseded_by.length).toBe(0);
      expect(hit.atom.content.toLowerCase()).toContain('postgres');
    }
    // The L2 atom should be in the results.
    const hitIds = hits.map(h => h.atom.id);
    const l2 = (await host.atoms.query({ layer: ['L2'] }, 10)).atoms;
    expect(hitIds).toContain(l2[0]?.id);
  });

  it('world oracle reflects the canonical database fact', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS3, host, principal);
    const cp = result.checkpointResults[0]!;
    expect(cp.worldFactActual).toBe('postgres');
    expect(cp.worldFactPassed).toBe(true);
  });

  it('atomsWritten counts only agentWrites (3), not the promotion-pass event', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS3, host, principal);
    expect(result.atomsWritten).toBe(3);
    expect(result.atomsSuperseded).toBe(1); // the representative L1
  });
});
