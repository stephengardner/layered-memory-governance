/**
 * Tests for the pr-observation refresh tick.
 *
 * Closes substrate gap #8: plans stuck in plan_state='executing' after
 * their PR merges or closes because the only pr-observation atom carries
 * pr_state='OPEN' from PR-creation time.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  DEFAULT_FRESHNESS_MS,
  readPrObservationFreshnessMs,
  runPlanObservationRefreshTick,
} from '../../../src/runtime/plans/pr-observation-refresh.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-01T00:00:00.000Z' as Time;

function policyAtom(id: string, value: unknown): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
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
      policy: { subject: 'pr-observation-freshness-threshold-ms', freshness_ms: value },
    },
  };
}

describe('readPrObservationFreshnessMs', () => {
  it('returns DEFAULT_FRESHNESS_MS when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
  });

  it('returns the configured value when a valid canon atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-pr-observation-freshness-threshold-ms', 60_000));
    expect(await readPrObservationFreshnessMs(host)).toBe(60_000);
  });

  it('falls back to default when the canon atom value is not a finite positive number', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-malformed', 'not-a-number'));
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
  });

  it('falls back to default when the canon atom value is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-zero', 0));
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
    await host.atoms.put(policyAtom('pol-neg', -1));
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-tainted', 60_000);
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
  });

  it('returns POSITIVE_INFINITY when the policy value is the explicit "Infinity" sentinel', async () => {
    // A deployment that observes via webhook and never wants polling
    // sets the policy to 'Infinity' (string, since JSON cannot encode
    // the literal). The reader returns Number.POSITIVE_INFINITY so
    // every observation passes the (now - observed_at < freshness)
    // check and the tick effectively becomes a no-op.
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-disabled', 'Infinity'));
    expect(await readPrObservationFreshnessMs(host)).toBe(Number.POSITIVE_INFINITY);
  });
});

const T_OLD = '2026-05-01T00:00:00.000Z' as Time;
const T_NOW_MS = new Date('2026-05-01T01:00:00.000Z').getTime(); // 1 hour after T_OLD
const T_NOW = '2026-05-01T01:00:00.000Z' as Time;

function planAtom(id: string, plan_state: PlanState): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: T_OLD,
    last_reinforced_at: T_OLD,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    plan_state,
    metadata: {},
  };
}

interface ObsOpts {
  readonly plan_id?: string | null;
  readonly pr_state?: string;
  readonly observed_at?: string;
  readonly pr?: Record<string, unknown>;
  readonly superseded?: boolean;
  readonly tainted?: boolean;
  readonly kind?: string;
}

function obsAtom(id: string, opts: ObsOpts = {}): Atom {
  const meta: Record<string, unknown> = {
    kind: opts.kind ?? 'pr-observation',
    pr: opts.pr ?? { owner: 'foo', repo: 'bar', number: 1 },
    pr_state: opts.pr_state ?? 'OPEN',
    observed_at: opts.observed_at ?? T_OLD,
  };
  // Default plan_id is 'p1' so most tests can omit it. Pass plan_id: null
  // explicitly to test the no-plan-id path.
  if (opts.plan_id === undefined) meta.plan_id = 'p1';
  else if (opts.plan_id !== null) meta.plan_id = opts.plan_id;
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'pr-observation',
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'pr-landing-agent' },
      derived_from: [],
    },
    confidence: 1,
    created_at: T_OLD,
    last_reinforced_at: T_OLD,
    expires_at: null,
    supersedes: [],
    superseded_by: opts.superseded ? ['x' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'pr-landing-agent' as PrincipalId,
    taint: opts.tainted ? 'tainted' : 'clean',
    metadata: meta,
  };
}

interface RefresherStub {
  readonly calls: Array<{ readonly pr: unknown; readonly plan_id: string }>;
  refresh(args: { readonly pr: unknown; readonly plan_id: string }): Promise<void>;
}

function makeRefresher(): RefresherStub {
  const calls: Array<{ readonly pr: unknown; readonly plan_id: string }> = [];
  return {
    calls,
    async refresh(args) {
      calls.push(args);
    },
  };
}

describe('runPlanObservationRefreshTick', () => {
  const nowFn = () => T_NOW;

  it('returns zero counts on empty store', async () => {
    const host = createMemoryHost();
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r).toEqual({ scanned: 0, refreshed: 0, skipped: {} });
  });

  it('refreshes a stale OPEN observation linked to executing plan', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1'));
    const refresher = makeRefresher();
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn });
    expect(r.refreshed).toBe(1);
    expect(refresher.calls).toEqual([
      { pr: { owner: 'foo', repo: 'bar', number: 1 }, plan_id: 'p1' },
    ]);
  });

  it('skips terminal pr_state', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { pr_state: 'MERGED' }));
    const refresher = makeRefresher();
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn });
    expect(r.refreshed).toBe(0);
    expect(r.skipped['already-terminal']).toBe(1);
    expect(refresher.calls).toEqual([]);
  });

  it('skips fresh observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { observed_at: T_NOW }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['fresh']).toBe(1);
  });

  it('skips when linked plan is not in executing', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'succeeded'));
    await host.atoms.put(obsAtom('o1'));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['plan-not-executing']).toBe(1);
  });

  it('skips when no plan_id on observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(obsAtom('o1', { plan_id: null }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['no-plan-id']).toBe(1);
  });

  it('skips when plan referenced does not exist', async () => {
    const host = createMemoryHost();
    await host.atoms.put(obsAtom('o1', { plan_id: 'missing' }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['plan-missing']).toBe(1);
  });

  it('skips when pr metadata is malformed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { pr: { owner: 'foo' } }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['pr-malformed']).toBe(1);
  });

  it('skips when pr.number is fractional (CR finding: integer-only)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(
      obsAtom('o1', { pr: { owner: 'foo', repo: 'bar', number: 1.5 } }),
    );
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['pr-malformed']).toBe(1);
    expect(r.refreshed).toBe(0);
  });

  it('counts refresh failures and continues to next observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(planAtom('p2', 'executing'));
    await host.atoms.put(obsAtom('o1', { plan_id: 'p1' }));
    await host.atoms.put(
      obsAtom('o2', { plan_id: 'p2', pr: { owner: 'b', repo: 'c', number: 2 } }),
    );
    let calls = 0;
    const refresher = {
      async refresh() {
        calls += 1;
        if (calls === 1) throw new Error('boom');
      },
    };
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn });
    expect(r.skipped['refresh-failed']).toBe(1);
    expect(r.refreshed).toBe(1);
  });

  it('respects maxRefreshes', async () => {
    const host = createMemoryHost();
    for (let i = 1; i <= 3; i++) {
      await host.atoms.put(planAtom(`p${i}`, 'executing'));
      await host.atoms.put(
        obsAtom(`o${i}`, { plan_id: `p${i}`, pr: { owner: 'a', repo: 'b', number: i } }),
      );
    }
    const refresher = makeRefresher();
    const r = await runPlanObservationRefreshTick(host, refresher, {
      now: nowFn,
      maxRefreshes: 2,
    });
    expect(r.refreshed).toBe(2);
    expect(r.skipped['rate-limited']).toBe(1);
  });

  it('ignores observations with kind != pr-observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { kind: 'something-else' }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.refreshed).toBe(0);
  });

  it('ignores tainted or superseded observations', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { tainted: true }));
    await host.atoms.put(obsAtom('o2', { plan_id: 'p1', superseded: true }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.refreshed).toBe(0);
  });

  it('respects freshnessMsOverride', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    // Observation is 1 hour old (T_OLD = NOW - 1h). With freshness = 2h, it's still fresh.
    await host.atoms.put(obsAtom('o1'));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), {
      now: nowFn,
      freshnessMsOverride: 2 * 60 * 60 * 1000,
    });
    expect(r.skipped['fresh']).toBe(1);
    expect(r.refreshed).toBe(0);
  });
});
// Pin reference for the time math check (used in jsdoc / IDE).
void T_NOW_MS;
