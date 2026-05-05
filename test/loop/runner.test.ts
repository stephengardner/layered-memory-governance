import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import { DEFAULT_HALF_LIVES } from '../../src/loop/types.js';
import type { AtomId, PrincipalId, Time } from '../../src/types.js';
import { samplePlanAtom, samplePrincipal, sampleAtom } from '../fixtures.js';

const principal = 'loop-test' as PrincipalId;

const REAPER_NOW_ISO = '2026-04-26T20:00:00.000Z';

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

describe('LoopRunner.tick reaper integration', () => {
  it('default (runReaperPass: false) leaves reaperReport null and does not transition plans', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    // Seed a stale proposed plan that WOULD be reaped if the pass
    // were enabled. With reaper off, it must stay proposed.
    await host.atoms.put(samplePlanAtom('p-stale-default', '2026-04-23T18:00:00.000Z'));
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.reaperReport).toBeNull();
    const stale = await host.atoms.get('p-stale-default' as AtomId);
    expect(stale?.plan_state).toBe('proposed');
  });

  it('runReaperPass: true with no stale plans yields a zero-abandon report', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // Only fresh plans seeded -> sweep should produce zero abandons.
    await host.atoms.put(samplePlanAtom('p-fresh', '2026-04-26T19:30:00.000Z'));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
    });
    const report = await runner.tick();
    expect(report.reaperReport).not.toBeNull();
    expect(report.reaperReport?.swept).toBe(1);
    expect(report.reaperReport?.fresh).toBe(1);
    expect(report.reaperReport?.warned).toBe(0);
    expect(report.reaperReport?.abandoned).toBe(0);
    const fresh = await host.atoms.get('p-fresh' as AtomId);
    expect(fresh?.plan_state).toBe('proposed');
  });

  it('runReaperPass: true with a >72h stale-proposed plan abandons it', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // 73h old (just past the 72h abandon line) so the reaper buckets
    // it as abandon and applies the transition.
    await host.atoms.put(samplePlanAtom('p-stale', '2026-04-23T19:00:00.000Z'));
    // A fresh plan that should be left alone by the same sweep.
    await host.atoms.put(samplePlanAtom('p-fresh-other', '2026-04-26T19:30:00.000Z'));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
    });
    const report = await runner.tick();
    expect(report.reaperReport).not.toBeNull();
    expect(report.reaperReport?.abandoned).toBe(1);
    expect(report.reaperReport?.fresh).toBe(1);
    const stale = await host.atoms.get('p-stale' as AtomId);
    expect(stale?.plan_state).toBe('abandoned');
    const fresh = await host.atoms.get('p-fresh-other' as AtomId);
    expect(fresh?.plan_state).toBe('proposed');
    // Audit row carries the reaper counts so an operator scanning
    // the loop.tick log sees what happened on this pass.
    const audits = await host.auditor.query({ kind: ['loop.tick'] }, 5);
    const last = audits[audits.length - 1];
    expect(last?.details?.['reaper_abandoned']).toBe(1);
  });

  it('runReaperPass: true with missing reaperPrincipal throws at construction', () => {
    const host = createMemoryHost();
    expect(
      () =>
        new LoopRunner(host, {
          principalId: principal,
          runReaperPass: true,
          // reaperPrincipal intentionally omitted
        }),
    ).toThrow(/reaperPrincipal/);
  });

  it('reaper internal failure does not fail the tick (best-effort semantics)', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
    });
    /*
     * Stub host.atoms.query so the reaper's pagination throws. The
     * stub is installed AFTER the constructor (which only validates
     * the configured principal exists - that lookup hits
     * host.principals, not host.atoms.query). The first tick must
     * record the failure in `errors` but otherwise complete - other
     * passes (decay, promotion, canon) stay unaffected by reaper
     * faults.
     */
    const realQuery = host.atoms.query.bind(host.atoms);
    let queryCallsBeforeFailure = 0;
    (host.atoms as { query: typeof host.atoms.query }).query = async (filter, limit, cursor) => {
      // The reaper queries by `type: ['plan'], plan_state: ['proposed']`.
      // Other passes use other filters; do not break them.
      const types = (filter as { type?: ReadonlyArray<string> } | undefined)?.type;
      if (types && types.includes('plan')) {
        throw new Error('synthetic reaper failure');
      }
      queryCallsBeforeFailure += 1;
      return realQuery(filter, limit, cursor);
    };
    const report = await runner.tick();
    expect(report.reaperReport).toBeNull();
    expect(report.errors.some((e) => e.startsWith('reaper-pass:'))).toBe(true);
    // Other passes still ran (queries fired for their layer filters).
    expect(queryCallsBeforeFailure).toBeGreaterThan(0);
  });

  it('rejects a non-positive reaperWarnMs at construction', () => {
    const host = createMemoryHost();
    expect(
      () =>
        new LoopRunner(host, {
          principalId: principal,
          runReaperPass: true,
          reaperPrincipal: 'lag-loop',
          reaperWarnMs: 0,
        }),
    ).toThrow(/reaperWarnMs/);
  });

  it('rejects abandonMs <= warnMs at construction (would merge buckets)', () => {
    const host = createMemoryHost();
    expect(
      () =>
        new LoopRunner(host, {
          principalId: principal,
          runReaperPass: true,
          reaperPrincipal: 'lag-loop',
          reaperWarnMs: 5_000,
          reaperAbandonMs: 5_000,
        }),
    ).toThrow(/reaperAbandonMs/);
  });

  it('first tick fails loud when reaperPrincipal is not in the PrincipalStore', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    // Intentionally do NOT seed the lag-loop principal so the runtime
    // PrincipalStore lookup misses on the first reaper pass.
    await host.atoms.put(samplePlanAtom('p-stale', '2026-04-23T19:00:00.000Z'));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
    });
    const report = await runner.tick();
    // Best-effort semantics: tick completes, principal-mismatch is
    // surfaced via errors[] and reaperReport stays null.
    expect(report.reaperReport).toBeNull();
    expect(
      report.errors.some((e) => e.includes('reaperPrincipal') && e.includes('lag-loop')),
    ).toBe(true);
    // The stale plan is untouched because the principal check failed
    // before the sweep applied any transitions.
    const stale = await host.atoms.get('p-stale' as AtomId);
    expect(stale?.plan_state).toBe('proposed');
  });

  it('recovers on a later tick after the missing principal is provisioned', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    // First tick: principal absent, reaper fails loud.
    await host.atoms.put(samplePlanAtom('p-recovery', '2026-04-23T19:00:00.000Z'));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
    });
    const first = await runner.tick();
    expect(first.reaperReport).toBeNull();
    expect(
      first.errors.some((e) => e.includes('reaperPrincipal') && e.includes('lag-loop')),
    ).toBe(true);
    // Operator provisions the principal between ticks.
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // Next tick must re-attempt the lookup (the previous miss did
    // NOT poison the cache flag) and the sweep then succeeds.
    const second = await runner.tick();
    expect(second.reaperReport).not.toBeNull();
    expect(second.reaperReport?.abandoned).toBe(1);
    const recovered = await host.atoms.get('p-recovery' as AtomId);
    expect(recovered?.plan_state).toBe('abandoned');
  });
});
