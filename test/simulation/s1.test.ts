import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runScenario } from '../../src/simulation/driver.js';
import { formatReport, summarize } from '../../src/simulation/metrics.js';
import { scenarioS1 } from '../../src/simulation/scenarios/s1-self-bootstrap.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principal = 'scripted-agent-1' as PrincipalId;

describe('Simulation scenario 1 (self-bootstrap)', () => {
  it('runs end-to-end with 100% checkpoint accuracy', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS1, host, principal);
    if (!summarize(result).allPassed) {
      // Surface the failure detail directly to the vitest report.
      throw new Error(formatReport(result));
    }
    expect(result.checkpointsTotal).toBe(2);
    expect(result.checkpointsPassed).toBe(2);
  });

  it('applies the scripted supersession at tick 4', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS1, host, principal);
    expect(result.supersessionsTotal).toBe(1);
    expect(result.supersessionsPassed).toBe(1);
    expect(result.atomsSuperseded).toBe(1);
  });

  it('default retrieval excludes the superseded atom', async () => {
    const host = createMemoryHost();
    await runScenario(scenarioS1, host, principal);
    const hits = await host.atoms.search('Stop hook display', 5);
    // The superseded (tick-1) atom must NOT appear.
    const supersededText = 'intended save-trigger mechanism';
    for (const hit of hits) {
      expect(hit.atom.content).not.toContain(supersededText);
    }
  });

  it('history-mode query includes superseded atoms', async () => {
    const host = createMemoryHost();
    await runScenario(scenarioS1, host, principal);
    const page = await host.atoms.query({ superseded: true }, 100);
    const supersededAtoms = page.atoms.filter(a => a.superseded_by.length > 0);
    expect(supersededAtoms.length).toBe(1);
    expect(supersededAtoms[0]?.content).toContain('intended save-trigger mechanism');
  });

  it('world oracle reports the final fact value correctly', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS1, host, principal);
    const c1 = result.checkpointResults.find(r => r.worldFactExpected !== null);
    expect(c1).toBeDefined();
    expect(c1?.worldFactPassed).toBe(true);
    expect(c1?.worldFactActual).toBe('pass-through-no-error-display');
  });

  it('writes 4 atoms, marks 1 as superseded', async () => {
    const host = createMemoryHost();
    const result = await runScenario(scenarioS1, host, principal);
    expect(result.atomsWritten).toBe(4);
    expect(result.atomsSuperseded).toBe(1);
    expect(host.atoms.size()).toBe(4);
  });

  it('superseded atom still has its supersedes pointer populated too', async () => {
    const host = createMemoryHost();
    await runScenario(scenarioS1, host, principal);
    // Find the tick-4 decision atom and verify its supersedes array.
    const page = await host.atoms.query({ type: ['decision'] }, 10);
    expect(page.atoms.length).toBe(1);
    const decision = page.atoms[0]!;
    expect(decision.supersedes.length).toBe(1);
  });
});
