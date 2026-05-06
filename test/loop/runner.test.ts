import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import { DEFAULT_HALF_LIVES } from '../../src/loop/types.js';
import { DEFAULT_REAPER_TTLS } from '../../src/runtime/plans/reaper.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';
import { samplePlanAtom, samplePrincipal, sampleAtom } from '../fixtures.js';

const principal = 'loop-test' as PrincipalId;

const REAPER_NOW_ISO = '2026-04-26T20:00:00.000Z';

/**
 * Build a `pol-reaper-ttls` policy atom with the given warn / abandon
 * pair under metadata.policy.subject='reaper-ttls'. Mirrors the shape
 * the bootstrap-reaper-canon.mjs script writes.
 */
function reaperTtlsPolicyAtom(
  id: string,
  warnMs: unknown,
  abandonMs: unknown,
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'reaper TTLs',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: REAPER_NOW_ISO as Time,
    last_reinforced_at: REAPER_NOW_ISO as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'reaper-ttls',
        warn_ms: warnMs,
        abandon_ms: abandonMs,
      },
    },
  };
}

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

/**
 * TTL resolution chain tests:
 *   canon `pol-reaper-ttls` > LoopOptions env / CLI override > DEFAULT_REAPER_TTLS
 *
 * Each case asserts both the bucket result of the sweep (the visible
 * effect of which TTLs were applied) and the stderr log line that
 * names the source. The log assertion makes the resolution path
 * directly observable so a future refactor that silently drops a rung
 * surfaces here, not in production.
 *
 * Helper: install a console.error capture and return the captured
 * calls + a restore fn. Direct property replacement (vs. vi.spyOn)
 * because the vitest config in this repo runs with `globals: false`
 * and the spy-based interception has been unreliable in that mode.
 */
function captureStderr(): {
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  restore: () => void;
} {
  const original = console.error;
  const captured: unknown[][] = [];
  // Wrap as `typeof console.error` so we don't reach for an `any` cast
  // (the architectural guard rejects `any` in tracked TS sources).
  const replacement: typeof console.error = (...args: unknown[]): void => {
    captured.push(args);
  };
  console.error = replacement;
  return {
    calls: captured,
    restore: () => {
      console.error = original;
    },
  };
}

describe('LoopRunner.tick reaper TTL resolution chain', () => {
  // Ages chosen so each test seed lands UNAMBIGUOUSLY in one bucket
  // for the ttls under test. The clock pin is REAPER_NOW_ISO
  // (2026-04-26T20:00:00.000Z); ages are computed from there.
  const NOW_MS = new Date(REAPER_NOW_ISO).getTime();

  it('canon policy atom WINS over env when both are present', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // Canon: warn=1h, abandon=2h. Env: warn=24h, abandon=72h.
    // Plan age = 90 minutes (between 1h and 2h). Under canon, plan
    // is in WARN bucket. Under env, plan would be FRESH.
    await host.atoms.put(
      reaperTtlsPolicyAtom('pol-reaper-ttls-default', 60 * 60 * 1000, 2 * 60 * 60 * 1000),
    );
    const planAgeMs = 90 * 60 * 1000; // 90 minutes
    const planCreatedAt = new Date(NOW_MS - planAgeMs).toISOString();
    await host.atoms.put(samplePlanAtom('p-canon-test', planCreatedAt));
    // Capture stderr so we can assert the source label.
    const cap = captureStderr();
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
      reaperWarnMs: 24 * 60 * 60 * 1000,
      reaperAbandonMs: 72 * 60 * 60 * 1000,
    });
    const report = await runner.tick();
    cap.restore();
    // Canon TTL applied -> plan is in WARN bucket (not FRESH).
    expect(report.reaperReport).not.toBeNull();
    expect(report.reaperReport?.warned).toBe(1);
    expect(report.reaperReport?.fresh).toBe(0);
    // Source label confirms canon path was chosen.
    const lines = cap.calls.map((c) => String(c[0]));
    expect(
      lines.some((c) => c.includes('[reaper] using TTLs from canon-policy')),
    ).toBe(true);
  });

  it('falls through to env fallback when no canon atom exists', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // No canon atom seeded. Env: warn=1h, abandon=2h.
    // Plan age = 90 minutes -> WARN under env TTLs.
    const planAgeMs = 90 * 60 * 1000;
    const planCreatedAt = new Date(NOW_MS - planAgeMs).toISOString();
    await host.atoms.put(samplePlanAtom('p-env-test', planCreatedAt));
    const cap = captureStderr();
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
      reaperWarnMs: 60 * 60 * 1000,
      reaperAbandonMs: 2 * 60 * 60 * 1000,
    });
    const report = await runner.tick();
    cap.restore();
    expect(report.reaperReport).not.toBeNull();
    expect(report.reaperReport?.warned).toBe(1);
    expect(report.reaperReport?.fresh).toBe(0);
    const lines = cap.calls.map((c) => String(c[0]));
    expect(
      lines.some(
        (c) =>
          c.includes('[reaper] using TTLs from env')
          && !c.includes('canon-policy'),
      ),
    ).toBe(true);
  });

  it('falls through to DEFAULT_REAPER_TTLS when neither canon nor env override is supplied', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // No canon atom and no LoopOptions override -> hardcoded floor
    // (24h warn / 72h abandon) applies.
    // Plan age = 30 minutes -> FRESH under defaults.
    const planAgeMs = 30 * 60 * 1000;
    const planCreatedAt = new Date(NOW_MS - planAgeMs).toISOString();
    await host.atoms.put(samplePlanAtom('p-default-test', planCreatedAt));
    const cap = captureStderr();
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
      // No reaperWarnMs / reaperAbandonMs supplied: env-override is false.
    });
    const report = await runner.tick();
    cap.restore();
    expect(report.reaperReport).not.toBeNull();
    expect(report.reaperReport?.fresh).toBe(1);
    expect(report.reaperReport?.warned).toBe(0);
    expect(report.reaperReport?.abandoned).toBe(0);
    const lines = cap.calls.map((c) => String(c[0]));
    expect(
      lines.some((c) =>
        c.includes(
          `[reaper] using TTLs from defaults: warn=${DEFAULT_REAPER_TTLS.staleWarnMs}ms `
            + `abandon=${DEFAULT_REAPER_TTLS.staleAbandonMs}ms`,
        ),
      ),
    ).toBe(true);
  });

  it('falls through to env when canon atom is malformed (and emits a warning)', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // Malformed: abandon_ms <= warn_ms (would merge buckets). The
    // reader emits a stderr WARN and returns null; the loop falls
    // through to env. Env TTLs put the plan in WARN.
    await host.atoms.put(
      reaperTtlsPolicyAtom('pol-reaper-ttls-default', 5_000, 5_000),
    );
    const planAgeMs = 90 * 60 * 1000;
    const planCreatedAt = new Date(NOW_MS - planAgeMs).toISOString();
    await host.atoms.put(samplePlanAtom('p-malformed-test', planCreatedAt));
    const cap = captureStderr();
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
      reaperWarnMs: 60 * 60 * 1000,
      reaperAbandonMs: 2 * 60 * 60 * 1000,
    });
    const report = await runner.tick();
    cap.restore();
    // Env path applied -> plan in WARN bucket.
    expect(report.reaperReport).not.toBeNull();
    expect(report.reaperReport?.warned).toBe(1);
    const lines = cap.calls.map((c) => String(c[0]));
    // (1) Reader logged the malformed-payload warning.
    expect(
      lines.some(
        (c) =>
          c.includes('[reaper-ttls] WARN')
          && c.includes('reaper-ttls policy atom')
          && c.includes('malformed payload'),
      ),
    ).toBe(true);
    // (2) Loop logged the env-source label (NOT canon-policy).
    expect(
      lines.some(
        (c) =>
          c.includes('[reaper] using TTLs from env')
          && !c.includes('canon-policy'),
      ),
    ).toBe(true);
  });

  it('canon-policy edit takes effect on the NEXT tick (re-read every pass)', async () => {
    const host = createMemoryHost();
    host.clock.setTime(REAPER_NOW_ISO);
    await host.principals.put(samplePrincipal({ id: 'lag-loop' as PrincipalId }));
    // Plan age = 90 min. Tick 1 with canon TTLs (1h/2h) -> WARN.
    await host.atoms.put(
      reaperTtlsPolicyAtom('pol-reaper-ttls-default', 60 * 60 * 1000, 2 * 60 * 60 * 1000),
    );
    const planAgeMs = 90 * 60 * 1000;
    const planCreatedAt = new Date(NOW_MS - planAgeMs).toISOString();
    await host.atoms.put(samplePlanAtom('p-canon-edit-test', planCreatedAt));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runReaperPass: true,
      reaperPrincipal: 'lag-loop',
    });
    const tick1 = await runner.tick();
    expect(tick1.reaperReport?.warned).toBe(1);
    // Operator edits canon: warn=2h, abandon=3h. Plan now FRESH.
    // Replace by writing a NEW atom id and superseding the old, since
    // the AtomStore puts are content-immutable. The new atom takes
    // precedence by being clean + non-superseded; the prior atom is
    // marked superseded so the reader skips it.
    await host.atoms.update('pol-reaper-ttls-default' as AtomId, {
      superseded_by: ['pol-reaper-ttls-tighter' as AtomId],
    });
    await host.atoms.put(
      reaperTtlsPolicyAtom(
        'pol-reaper-ttls-tighter',
        2 * 60 * 60 * 1000,
        3 * 60 * 60 * 1000,
      ),
    );
    const tick2 = await runner.tick();
    expect(tick2.reaperReport?.warned).toBe(0);
    expect(tick2.reaperReport?.fresh).toBe(1);
  });
});

/**
 * Build a pr-observation atom suitable for the in-process reconcile +
 * refresh ticks. The shape mirrors the inline factory in
 * test/runtime/plans/pr-merge-reconcile.test.ts; it's rebuilt here
 * locally rather than re-extracted into test/fixtures.ts because the
 * reconcile-test uses a slightly different arg shape (overrides bag
 * vs. positional arg) and merging the two would force every existing
 * call site to rewrite. Per dev-no-hacky-workarounds, the parallel
 * factories share the schema-1 atom contract; if a third call site
 * lands the right move is the extraction not the third copy.
 */
function prObservationAtom(
  id: string,
  overrides: {
    readonly pr_state?: string;
    readonly merge_state_status?: string;
    readonly plan_id?: string;
    readonly observed_at?: string;
  } = {},
): Atom {
  const meta: Record<string, unknown> = {
    kind: 'pr-observation',
    pr: { owner: 'o', repo: 'r', number: 42 },
    plan_id: overrides.plan_id ?? 'p1',
    pr_state: overrides.pr_state ?? 'OPEN',
    merge_state_status: overrides.merge_state_status ?? 'CLEAN',
  };
  if (overrides.observed_at !== undefined) {
    meta['observed_at'] = overrides.observed_at;
  }
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'pr-observation body',
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'lag-pr-landing' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: '2026-04-30T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-04-30T00:00:00.000Z' as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'lag-pr-landing' as PrincipalId,
    taint: 'clean',
    metadata: meta,
  };
}

describe('LoopRunner.tick plan-reconcile integration', () => {
  it('default (runPlanReconcilePass: false) leaves planReconcileReport null and does not transition', async () => {
    const host = createMemoryHost();
    // Seed a plan + merged-pr-observation that WOULD reconcile if the
    // pass were enabled. With reconcile off, the plan stays executing.
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    await host.atoms.put(prObservationAtom('obs1', { pr_state: 'MERGED' }));
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.planReconcileReport).toBeNull();
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('executing');
  });

  it('enabled reconciles a merged-PR plan from executing to succeeded in one tick', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    await host.atoms.put(prObservationAtom('obs1', { pr_state: 'MERGED' }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanReconcilePass: true,
    });
    const report = await runner.tick();
    expect(report.planReconcileReport).not.toBeNull();
    expect(report.planReconcileReport?.matched).toBe(1);
    expect(report.planReconcileReport?.transitioned).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('succeeded');
    // Audit row carries the reconcile counts.
    const audits = await host.auditor.query({ kind: ['loop.tick'] }, 5);
    const last = audits[audits.length - 1];
    expect(last?.details?.['plan_reconcile_transitioned']).toBe(1);
  });

  it('reconcile-pass internal failure does not fail the tick (best-effort semantics)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    await host.atoms.put(prObservationAtom('obs1', { pr_state: 'MERGED' }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanReconcilePass: true,
    });
    // Stub host.atoms.put to throw on the marker atom write the
    // reconcile pass relies on. Other writes (decay, etc.) keep
    // working. The error must surface in errors[] without aborting
    // the tick.
    const realPut = host.atoms.put.bind(host.atoms);
    (host.atoms as { put: typeof host.atoms.put }).put = async (atom) => {
      if (atom.type === 'plan-merge-settled') {
        throw new Error('synthetic reconcile failure');
      }
      return realPut(atom);
    };
    const report = await runner.tick();
    expect(report.planReconcileReport).toBeNull();
    expect(report.errors.some((e) => e.startsWith('plan-reconcile:'))).toBe(true);
    // Plan is still executing (transition aborted on the failed marker write).
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('executing');
  });
});

describe('LoopRunner.tick plan-observation refresh integration', () => {
  it('default (runPlanObservationRefreshPass: false) leaves planObservationRefreshReport null and does not call the refresher', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    // Stale OPEN observation that WOULD refresh if the pass were on.
    await host.atoms.put(
      prObservationAtom('obs1', {
        pr_state: 'OPEN',
        observed_at: '2026-04-29T00:00:00.000Z',
      }),
    );
    let refreshCalls = 0;
    const refresher = {
      async refresh() {
        refreshCalls += 1;
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      prObservationRefresher: refresher,
    });
    const report = await runner.tick();
    expect(report.planObservationRefreshReport).toBeNull();
    expect(refreshCalls).toBe(0);
  });

  it('enabled-but-refresher-absent silently skips and warns ONCE across many ticks', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    await host.atoms.put(
      prObservationAtom('obs1', {
        pr_state: 'OPEN',
        observed_at: '2026-04-29T00:00:00.000Z',
      }),
    );
    // Capture stderr so we can assert the once-per-runner gap warning.
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const runner = new LoopRunner(host, {
        principalId: principal,
        runPlanObservationRefreshPass: true,
        // No prObservationRefresher supplied.
      });
      // Run 5 ticks. Long-running daemons would otherwise flood stderr
      // at 1440 warnings/day on a 60s interval; the once-per-runner
      // latch caps it at one.
      for (let i = 0; i < 5; i += 1) {
        const report = await runner.tick();
        expect(report.planObservationRefreshReport).toBeNull();
      }
      const gapWarnings = captured.filter(
        (l) => l.includes('[plan-obs-refresh]') && l.includes('no prObservationRefresher seam'),
      );
      expect(gapWarnings.length).toBe(1);
    } finally {
      console.error = original;
    }
  });

  it('enabled-with-refresher refreshes a stale OPEN observation and reports the count', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    // Observed_at far enough in the past to clear the default 5min freshness.
    await host.atoms.put(
      prObservationAtom('obs1', {
        pr_state: 'OPEN',
        observed_at: '2026-04-29T00:00:00.000Z',
      }),
    );
    const refreshCalls: Array<{ pr: { number: number }; plan_id: string }> = [];
    const refresher = {
      async refresh(args: { pr: { owner: string; repo: string; number: number }; plan_id: string }) {
        refreshCalls.push({ pr: { number: args.pr.number }, plan_id: args.plan_id });
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanObservationRefreshPass: true,
      prObservationRefresher: refresher,
    });
    const report = await runner.tick();
    expect(report.planObservationRefreshReport).not.toBeNull();
    expect(report.planObservationRefreshReport?.refreshed).toBe(1);
    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0]?.pr.number).toBe(42);
    expect(refreshCalls[0]?.plan_id).toBe('p1');
    // Audit row carries the refresh counts.
    const audits = await host.auditor.query({ kind: ['loop.tick'] }, 5);
    const last = audits[audits.length - 1];
    expect(last?.details?.['plan_obs_refresh_refreshed']).toBe(1);
  });

  it('refresh-pass refresher failure does not fail the tick (counted as skipped)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    await host.atoms.put(
      prObservationAtom('obs1', {
        pr_state: 'OPEN',
        observed_at: '2026-04-29T00:00:00.000Z',
      }),
    );
    const refresher = {
      async refresh(): Promise<void> {
        throw new Error('synthetic refresher failure');
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanObservationRefreshPass: true,
      prObservationRefresher: refresher,
    });
    const report = await runner.tick();
    // The tick framework's error handling treats a refresher throw as
    // a skip-with-reason inside runPlanObservationRefreshTick, NOT as
    // a thrown tick error: the refresh tick catches the inner throw
    // and bumps skipped['refresh-failed']. The outer LoopRunner sees
    // a successful pass with refreshed=0.
    expect(report.planObservationRefreshReport).not.toBeNull();
    expect(report.planObservationRefreshReport?.refreshed).toBe(0);
    expect(report.planObservationRefreshReport?.skipped['refresh-failed']).toBe(1);
  });
});

describe('LoopRunner.tick plan-reconcile + refresh combined wiring (e2e)', () => {
  it('refresh runs BEFORE reconcile so a stale OPEN observation rewritten this tick is reconciled the SAME tick', async () => {
    // This is the canonical end-to-end test the operator asked for:
    // a plan in 'executing' with a stale OPEN observation; the
    // refresher writes a fresh terminal observation; the reconcile
    // pass picks it up on the same tick and flips the plan.
    const host = createMemoryHost();
    await host.atoms.put(
      samplePlanAtom('p1', '2026-04-30T00:00:00.000Z', { plan_state: 'executing' }),
    );
    await host.atoms.put(
      prObservationAtom('obs1', {
        pr_state: 'OPEN',
        observed_at: '2026-04-29T00:00:00.000Z',
      }),
    );
    // A faithful refresher writes a fresh observation atom carrying
    // the terminal pr_state. The framework's reconcile pass reads
    // observation atoms of any age (the freshness threshold guards
    // refresh, NOT reconcile), so as long as the new atom is in the
    // store before reconcilePass runs, the same tick transitions p1.
    const refresher = {
      async refresh(args: {
        pr: { owner: string; repo: string; number: number };
        plan_id: string;
      }): Promise<void> {
        await host.atoms.put(
          prObservationAtom('obs2', {
            pr_state: 'MERGED',
            plan_id: args.plan_id,
            observed_at: '2026-04-30T00:00:00.000Z',
          }),
        );
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanObservationRefreshPass: true,
      runPlanReconcilePass: true,
      prObservationRefresher: refresher,
    });
    const report = await runner.tick();
    expect(report.planObservationRefreshReport?.refreshed).toBe(1);
    expect(report.planReconcileReport?.transitioned).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('succeeded');
  });
});

describe('LoopRunner.tick plan-proposal notify integration', () => {
  it('default (runPlanProposalNotifyPass: false) leaves planProposalNotifyReport null and does not call the notifier', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    let notifyCalls = 0;
    const notifier = {
      async notify(): Promise<void> {
        notifyCalls += 1;
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).toBeNull();
    expect(notifyCalls).toBe(0);
  });

  it('enabled-but-notifier-absent silent-skips and warns ONCE across many ticks', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const runner = new LoopRunner(host, {
        principalId: principal,
        runPlanProposalNotifyPass: true,
        // No planProposalNotifier supplied.
      });
      // Run 5 ticks. Long-running daemons would otherwise flood
      // stderr with one warning per tick; the once-per-runner
      // latch caps it at one.
      for (let i = 0; i < 5; i += 1) {
        const report = await runner.tick();
        expect(report.planProposalNotifyReport).toBeNull();
      }
      const gapWarnings = captured.filter(
        (l) =>
          l.includes('[plan-proposal-notify]') && l.includes('no planProposalNotifier seam'),
      );
      expect(gapWarnings.length).toBe(1);
    } finally {
      console.error = original;
    }
  });

  it('enabled-with-notifier pushes a proposed cto-actor plan and reports the count', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    const notifyCalls: Array<{ planId: string }> = [];
    const notifier = {
      async notify(args: { plan: { id: string } }): Promise<void> {
        notifyCalls.push({ planId: args.plan.id });
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).not.toBeNull();
    expect(report.planProposalNotifyReport?.notified).toBe(1);
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]?.planId).toBe('p1');
    // Audit row carries the count.
    const audits = await host.auditor.query({ kind: ['loop.tick'] }, 5);
    const last = audits[audits.length - 1];
    expect(last?.details?.['plan_proposal_notify_notified']).toBe(1);
  });

  it('idempotent across two ticks: second tick sees already-pushed', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    let notifyCalls = 0;
    const notifier = {
      async notify(): Promise<void> {
        notifyCalls += 1;
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const first = await runner.tick();
    const second = await runner.tick();
    expect(first.planProposalNotifyReport?.notified).toBe(1);
    expect(second.planProposalNotifyReport?.notified).toBe(0);
    expect(second.planProposalNotifyReport?.skipped['already-pushed']).toBe(1);
    expect(notifyCalls).toBe(1);
  });

  it('notifier failure does not fail the tick (counted as skipped)', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    const notifier = {
      async notify(): Promise<void> {
        throw new Error('synthetic Telegram failure');
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).not.toBeNull();
    expect(report.planProposalNotifyReport?.notified).toBe(0);
    expect(report.planProposalNotifyReport?.skipped['notify-failed']).toBe(1);
    // No push-record was written; next tick will retry.
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 5);
    expect(records.atoms.length).toBe(0);
  });

  it('best-effort: synthetic internal failure does not fail the tick', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    // Stub host.atoms.query so a query for proposed plans throws.
    // The tick first scans push-records, then directives (canon
    // read), then the plan set. We throw on the plan-set query
    // specifically.
    const realQuery = host.atoms.query.bind(host.atoms);
    (host.atoms as { query: typeof host.atoms.query }).query = async (
      filter,
      limit,
      cursor,
    ) => {
      if (
        filter.type
        && Array.isArray(filter.type)
        && filter.type.includes('plan')
        && Array.isArray(filter.plan_state)
      ) {
        throw new Error('synthetic notify-pass failure');
      }
      return realQuery(filter, limit, cursor);
    };
    const notifier = {
      async notify(): Promise<void> {
        // unreachable -- the throw happens before delegate
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).toBeNull();
    expect(report.errors.some((e) => e.startsWith('plan-proposal-notify:'))).toBe(true);
  });
});
