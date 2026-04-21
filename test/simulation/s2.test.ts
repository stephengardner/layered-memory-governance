import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/arbitration/index.js';
import { runScenario } from '../../src/simulation/driver.js';
import { formatReport, summarize } from '../../src/simulation/metrics.js';
import { scenarioS2 } from '../../src/simulation/scenarios/s2-decision-reversal.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principal = 'scripted-agent-2' as PrincipalId;

/**
 * Pre-register the LLM detector response for the (obs-redux, dir-zustand)
 * pair. The driver calls detectConflict(dirAtom, obsAtom) in that argument
 * order because tick-2 is the "new" atom and arbitration is new-vs-prior.
 */
function prepLlm(
  host: ReturnType<typeof createMemoryHost>,
  dirContent: string,
  obsContent: string,
  dirCreatedAt: string,
  obsCreatedAt: string,
): void {
  host.llm.register(
    DETECT_SCHEMA,
    DETECT_SYSTEM,
    {
      atom_a: {
        content: dirContent,
        type: 'directive',
        layer: 'L1',
        created_at: dirCreatedAt,
      },
      atom_b: {
        content: obsContent,
        type: 'observation',
        layer: 'L1',
        created_at: obsCreatedAt,
      },
    },
    {
      kind: 'semantic',
      explanation: 'State library claims are contradictory (Redux vs Zustand).',
    },
  );
}

function extractContents(): { dir: string; obs: string } {
  // Reach into the scenario data to pull the exact strings the driver writes.
  const obsEvent = scenarioS2.events[0]!;
  const dirEvent = scenarioS2.events[1]!;
  return {
    obs: obsEvent.agentWrite!.content,
    dir: dirEvent.agentWrite!.content,
  };
}

describe('Simulation scenario 2 (auto-arbitration reversal)', () => {
  it('auto-arbitrates the reversal via source-rank', async () => {
    const host = createMemoryHost();
    const { dir, obs } = extractContents();
    // createMemoryHost default clock start is 2026-01-01T00:00:00.000Z.
    // Driver advances 60s per tick, so tick-1 is +1 minute, tick-2 is +2 minutes.
    prepLlm(
      host,
      dir,
      obs,
      '2026-01-01T00:02:00.000Z',
      '2026-01-01T00:01:00.000Z',
    );

    const result = await runScenario(scenarioS2, host, principal);

    if (!summarize(result).allPassed) {
      throw new Error(formatReport(result));
    }
    expect(result.arbitrations.length).toBe(1);
    const arb = result.arbitrations[0]!;
    expect(arb.ruleApplied).toBe('source-rank');
    expect(arb.outcomeKind).toBe('winner');
    expect(arb.winnerLabel).toBe('dir-zustand');
    expect(arb.loserLabel).toBe('obs-redux');
  });

  it('loser atom is marked superseded', async () => {
    const host = createMemoryHost();
    const { dir, obs } = extractContents();
    prepLlm(host, dir, obs, '2026-01-01T00:02:00.000Z', '2026-01-01T00:01:00.000Z');

    const result = await runScenario(scenarioS2, host, principal);
    expect(result.supersessionsPassed).toBe(1);
    expect(result.atomsSuperseded).toBe(1);
  });

  it('default search excludes the superseded Redux observation', async () => {
    const host = createMemoryHost();
    const { dir, obs } = extractContents();
    prepLlm(host, dir, obs, '2026-01-01T00:02:00.000Z', '2026-01-01T00:01:00.000Z');

    await runScenario(scenarioS2, host, principal);

    const hits = await host.atoms.search('state library', 5);
    for (const hit of hits) {
      expect(hit.atom.content).not.toContain('We use Redux');
    }
  });

  it('arbitration decision was audited', async () => {
    const host = createMemoryHost();
    const { dir, obs } = extractContents();
    prepLlm(host, dir, obs, '2026-01-01T00:02:00.000Z', '2026-01-01T00:01:00.000Z');

    await runScenario(scenarioS2, host, principal);
    const auditEntries = await host.auditor.query({ kind: ['arbitration.decision'] }, 10);
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0]?.details).toMatchObject({
      rule: 'source-rank',
      outcome_kind: 'winner',
      conflict_kind: 'semantic',
    });
  });

  it('world oracle transitioned correctly', async () => {
    const host = createMemoryHost();
    const { dir, obs } = extractContents();
    prepLlm(host, dir, obs, '2026-01-01T00:02:00.000Z', '2026-01-01T00:01:00.000Z');

    const result = await runScenario(scenarioS2, host, principal);
    const cp = result.checkpointResults[0]!;
    expect(cp.worldFactPassed).toBe(true);
    expect(cp.worldFactActual).toBe('zustand');
  });
});
