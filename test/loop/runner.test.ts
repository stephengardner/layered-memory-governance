import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import { DEFAULT_HALF_LIVES } from '../../src/loop/types.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'loop-test' as PrincipalId;

describe('LoopRunner.tick basics', () => {
  it('first tick runs decay, increments counter, logs audit', async () => {
    const host = createMemoryHost();
    // Seed an atom whose last_reinforced_at is far in the past vs clock now.
    host.clock.setTime('2026-06-01T00:00:00.000Z');
    await host.atoms.put(sampleAtom({
      id: 'old' as AtomId,
      confidence: 0.8,
      type: 'ephemeral',
      layer: 'L1',
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    }));
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.tickNumber).toBe(1);
    expect(report.killSwitchTriggered).toBe(false);
    expect(report.atomsDecayed).toBeGreaterThan(0);
    const audits = await host.auditor.query({ kind: ['loop.tick'] }, 10);
    expect(audits.length).toBe(1);
  });

  it('honors STOP via killswitchCheck', async () => {
    const host = createMemoryHost();
    host.scheduler.kill();
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.killSwitchTriggered).toBe(true);
    expect(report.atomsDecayed).toBe(0);
  });

  it('L2 promotion fires when consensus thresholds met', async () => {
    const host = createMemoryHost();
    for (const agent of ['alice', 'bob']) {
      await host.atoms.put(sampleAtom({
        id: `l1_${agent}` as AtomId,
        content: 'we use postgres',
        layer: 'L1',
        confidence: 0.85,
        principal_id: agent as PrincipalId,
      }));
    }
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.l2Promoted).toBeGreaterThan(0);
    const l2 = (await host.atoms.query({ layer: ['L2'] }, 10)).atoms;
    expect(l2.length).toBeGreaterThan(0);
  });

  it('L3 promotion ticks through timeout (no human respond) and records no proposal', async () => {
    const host = createMemoryHost();
    for (const agent of ['a', 'b', 'c']) {
      await host.atoms.put(sampleAtom({
        id: `l2_${agent}` as AtomId,
        content: 'deeply agreed fact',
        layer: 'L2',
        confidence: 0.95,
        principal_id: agent as PrincipalId,
      }));
    }
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    // Without human approval, L3 human gate times out -> no promotion.
    expect(report.l3Proposed).toBe(0);
  });

  it('disables passes when options say so', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({
      id: 'x' as AtomId,
      content: 'lone atom',
      layer: 'L1',
      confidence: 0.9,
    }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
    });
    const report = await runner.tick();
    expect(report.l2Promoted).toBe(0);
    expect(report.l3Proposed).toBe(0);
  });

  it('decay respects custom half-lives', async () => {
    const host = createMemoryHost();
    host.clock.setTime('2027-01-01T00:00:00.000Z');
    await host.atoms.put(sampleAtom({
      id: 'x' as AtomId,
      type: 'observation',
      confidence: 1.0,
      layer: 'L1',
      last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      halfLives: { ...DEFAULT_HALF_LIVES, observation: 10 },
    });
    await runner.tick();
    const after = await host.atoms.get('x' as AtomId);
    // With a 10ms half-life, confidence should have decayed to the floor.
    expect(after?.confidence).toBeLessThan(0.1);
  });

  it('reports stats across multiple ticks', async () => {
    const host = createMemoryHost();
    const runner = new LoopRunner(host, { principalId: principal });
    await runner.tick();
    await runner.tick();
    await runner.tick();
    const stats = runner.stats();
    expect(stats.totalTicks).toBe(3);
    expect(stats.running).toBe(false);
  });
});
