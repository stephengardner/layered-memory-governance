/**
 * Plan staleness reaper tests.
 *
 * Coverage:
 *   - classifyPlan: ignores non-plans, ignores non-proposed plans,
 *     returns null for invalid timestamps, future-dated plans, and
 *     correctly buckets fresh / warn / abandon by age.
 *   - classifyPlans: aggregates a list into the three buckets and
 *     drops irrelevant atoms.
 *   - applyReap: transitions abandon-bucket plans via the existing
 *     state-machine helper, leaving fresh/warn untouched, and skips
 *     atoms that disappeared or transitioned under us between
 *     classify and apply (TOCTOU safety).
 *   - runReaperSweep: end-to-end on a MemoryHost. A seeded store with
 *     plans at multiple ages produces exactly one abandonment per
 *     stale plan, an audit event per transition, and zero false
 *     transitions on fresh / non-plan atoms.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  DEFAULT_REAPER_TTLS,
  applyReap,
  classifyPlan,
  classifyPlans,
  runReaperSweep,
  type ReaperTtls,
} from '../../../src/runtime/plans/reaper.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../../../src/substrate/types.js';

const TTLS: ReaperTtls = {
  staleWarnMs: 24 * 60 * 60 * 1000,
  staleAbandonMs: 72 * 60 * 60 * 1000,
};

function planAtom(
  id: string,
  createdAt: string,
  overrides: { plan_state?: PlanState | undefined; type?: 'plan' | 'observation' } = {},
): Atom {
  const type = overrides.type ?? 'plan';
  // For non-plan atoms, omit plan_state entirely so the test fixture
  // matches what an observation atom looks like in the wild.
  const planState =
    type === 'plan'
      ? overrides.plan_state === undefined
        ? 'proposed'
        : overrides.plan_state
      : undefined;
  const base: Atom = {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type,
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: createdAt as Time,
    last_reinforced_at: createdAt as Time,
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
    metadata: { title: 'test plan' },
  };
  if (planState !== undefined) {
    return { ...base, plan_state: planState };
  }
  return base;
}

const NOW_MS = Date.parse('2026-04-26T20:00:00.000Z');

describe('classifyPlan', () => {
  it('returns null for non-plan atoms', () => {
    const obs = planAtom('obs', '2026-04-25T20:00:00.000Z', {
      type: 'observation',
      plan_state: 'proposed',
    });
    expect(classifyPlan(obs, NOW_MS, TTLS)).toBeNull();
  });

  it('returns null for plans not in proposed state', () => {
    for (const state of ['approved', 'executing', 'succeeded', 'failed', 'abandoned'] as const) {
      const a = planAtom(`p-${state}`, '2026-04-20T20:00:00.000Z', { plan_state: state });
      expect(classifyPlan(a, NOW_MS, TTLS), `state ${state}`).toBeNull();
    }
  });

  it('returns null for invalid created_at strings', () => {
    const a = planAtom('p-bad', 'not-a-date');
    expect(classifyPlan(a, NOW_MS, TTLS)).toBeNull();
  });

  it('returns null for future-dated atoms (clock skew safety)', () => {
    const a = planAtom('p-future', '2026-04-27T20:00:00.000Z');
    expect(classifyPlan(a, NOW_MS, TTLS)).toBeNull();
  });

  it('classifies a 1-hour-old plan as fresh', () => {
    const a = planAtom('p-fresh', '2026-04-26T19:00:00.000Z');
    const c = classifyPlan(a, NOW_MS, TTLS);
    expect(c).not.toBeNull();
    expect(c!.bucket).toBe('fresh');
  });

  it('classifies a 25-hour-old plan as warn', () => {
    const a = planAtom('p-warn', '2026-04-25T19:00:00.000Z');
    const c = classifyPlan(a, NOW_MS, TTLS);
    expect(c!.bucket).toBe('warn');
  });

  it('classifies a 73-hour-old plan as abandon', () => {
    const a = planAtom('p-abandon', '2026-04-23T19:00:00.000Z');
    const c = classifyPlan(a, NOW_MS, TTLS);
    expect(c!.bucket).toBe('abandon');
  });

  it('boundary: exactly 24h old is warn (>= threshold)', () => {
    const a = planAtom('p-edge-warn', '2026-04-25T20:00:00.000Z');
    const c = classifyPlan(a, NOW_MS, TTLS);
    expect(c!.bucket).toBe('warn');
  });

  it('boundary: exactly 72h old is abandon (>= threshold)', () => {
    const a = planAtom('p-edge-abandon', '2026-04-23T20:00:00.000Z');
    const c = classifyPlan(a, NOW_MS, TTLS);
    expect(c!.bucket).toBe('abandon');
  });
});

describe('classifyPlans', () => {
  it('aggregates a mixed list into the three buckets', () => {
    const atoms = [
      planAtom('a-fresh', '2026-04-26T19:00:00.000Z'),
      planAtom('a-warn', '2026-04-25T19:00:00.000Z'),
      planAtom('a-abandon-1', '2026-04-23T19:00:00.000Z'),
      planAtom('a-abandon-2', '2026-04-20T19:00:00.000Z'),
      // Non-proposed: filtered out.
      planAtom('a-approved', '2026-04-20T19:00:00.000Z', { plan_state: 'approved' }),
      // Non-plan: filtered out.
      planAtom('a-obs', '2026-04-20T19:00:00.000Z', { type: 'observation' }),
    ];
    const r = classifyPlans(atoms, NOW_MS, TTLS);
    expect(r.fresh.map((c) => c.atomId)).toEqual(['a-fresh']);
    expect(r.warn.map((c) => c.atomId)).toEqual(['a-warn']);
    expect(r.abandon.map((c) => c.atomId).sort()).toEqual(['a-abandon-1', 'a-abandon-2']);
  });

  it('empty input produces three empty buckets', () => {
    const r = classifyPlans([], NOW_MS, TTLS);
    expect(r.fresh).toHaveLength(0);
    expect(r.warn).toHaveLength(0);
    expect(r.abandon).toHaveLength(0);
  });
});

describe('applyReap', () => {
  it('transitions abandon-bucket plans to abandoned via the state machine', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;

    const stale = planAtom('p-stale', '2026-04-23T19:00:00.000Z');
    const warn = planAtom('p-warn', '2026-04-25T19:00:00.000Z');
    await host.atoms.put(stale);
    await host.atoms.put(warn);

    const classifications = classifyPlans([stale, warn], NOW_MS, TTLS);
    const result = await applyReap(host, reaper, classifications);

    expect(result.abandoned.map((a) => a.atomId)).toEqual(['p-stale']);
    expect(result.skipped).toHaveLength(0);

    const after = await host.atoms.get('p-stale' as AtomId);
    expect(after?.plan_state).toBe('abandoned');

    const stillProposed = await host.atoms.get('p-warn' as AtomId);
    expect(stillProposed?.plan_state).toBe('proposed');
  });

  it('skips atoms that transitioned under us between classify and apply (TOCTOU)', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;

    const stale = planAtom('p-toctou', '2026-04-23T19:00:00.000Z');
    await host.atoms.put(stale);

    const classifications = classifyPlans([stale], NOW_MS, TTLS);

    // External actor approves the plan between classify and apply.
    await host.atoms.update('p-toctou' as AtomId, { plan_state: 'approved' });

    const result = await applyReap(host, reaper, classifications);
    expect(result.abandoned).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.error).toMatch(/state-changed:approved/);

    // And the plan is still approved, untouched by the reaper.
    const after = await host.atoms.get('p-toctou' as AtomId);
    expect(after?.plan_state).toBe('approved');
  });

  it('records ageHours via floor in the abandoned entries (audit-legibility)', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;

    // 72h + 30m old: Math.floor reports 72, never overstates.
    const stale = planAtom('p-72h', '2026-04-23T19:30:00.000Z');
    await host.atoms.put(stale);

    const classifications = classifyPlans([stale], NOW_MS, TTLS);
    const result = await applyReap(host, reaper, classifications);
    expect(result.abandoned).toHaveLength(1);
    expect(result.abandoned[0]?.ageHours).toBe(72);
  });
});

describe('runReaperSweep', () => {
  it('returns truncated=true when pagination claims more remain past the iteration cap', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;
    /*
     * Replace host.atoms.query entirely with a stub that returns one
     * stale plan plus a non-null nextCursor on every call - never
     * exhausting. The MemoryAtomStore validates cursors as base64-
     * encoded integers, so re-using realQuery + a raw string cursor
     * crashes on the next call. The stub bypasses the validator
     * because it never round-trips through MemoryAtomStore again.
     *
     * loadAllProposedPlans hits REAPER_PAGE_LIMIT (200) without
     * exhausting; runReaperSweep should surface truncated=true so the
     * caller can warn the operator that the slate they just saw is
     * partial.
     */
    const stalePlan = planAtom('only-one', '2026-04-23T18:00:00.000Z');
    let queryCalls = 0;
    (host.atoms as { query: typeof host.atoms.query }).query = async () => {
      queryCalls += 1;
      // Return the stale plan only on the first page so we still
      // produce one abandon transition (the abandon path requires
      // host.atoms.get to find the plan; we put it below).
      return {
        atoms: queryCalls === 1 ? [stalePlan] : [],
        nextCursor: 'pretend-more-remain',
      };
    };
    /*
     * Seed the actual store with the same plan id so applyReap's
     * re-fetch (host.atoms.get) succeeds; the stub only affects the
     * paginated query path.
     */
    await host.atoms.put(stalePlan);
    const fakeNowIso = '2026-04-26T20:00:00.000Z';
    (host.clock as { now: () => Time }).now = () => fakeNowIso as Time;
    const out = await runReaperSweep(host, reaper, TTLS);
    expect(out.truncated).toBe(true);
    /*
     * Spot-check: the iteration cap fired, not the cursor exhaustion.
     * REAPER_PAGE_LIMIT is 200 in the helper.
     */
    expect(queryCalls).toBeGreaterThanOrEqual(200);
  });

  it('returns truncated=false for normal sweeps (under page-cap)', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;
    await host.atoms.put(planAtom('only-one', '2026-04-23T18:00:00.000Z'));
    const fakeNowIso = '2026-04-26T20:00:00.000Z';
    (host.clock as { now: () => Time }).now = () => fakeNowIso as Time;
    const out = await runReaperSweep(host, reaper, TTLS);
    expect(out.truncated).toBe(false);
  });

  it('end-to-end: paginated query + classify + apply, no false transitions', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;

    // Seed a representative population: 1 fresh, 1 warn, 2 abandon-eligible,
    // 1 approved (must NOT be touched), 1 unrelated observation atom.
    await host.atoms.put(planAtom('sweep-fresh', '2026-04-26T19:30:00.000Z'));
    await host.atoms.put(planAtom('sweep-warn', '2026-04-25T18:00:00.000Z'));
    await host.atoms.put(planAtom('sweep-stale-1', '2026-04-23T18:00:00.000Z'));
    await host.atoms.put(planAtom('sweep-stale-2', '2026-04-20T10:00:00.000Z'));
    await host.atoms.put(
      planAtom('sweep-approved', '2026-04-22T18:00:00.000Z', { plan_state: 'approved' }),
    );
    await host.atoms.put(
      planAtom('sweep-obs', '2026-04-23T18:00:00.000Z', { type: 'observation' }),
    );

    // Pin the clock so the test is deterministic regardless of wall-clock.
    const fakeNowIso = '2026-04-26T20:00:00.000Z';
    const realNow = host.clock.now;
    (host.clock as { now: () => Time }).now = () => fakeNowIso as Time;
    try {
      const out = await runReaperSweep(host, reaper, TTLS);
      expect(out.classifications.fresh.map((c) => c.atomId).sort()).toEqual(['sweep-fresh']);
      expect(out.classifications.warn.map((c) => c.atomId).sort()).toEqual(['sweep-warn']);
      expect(out.classifications.abandon.map((c) => c.atomId).sort()).toEqual([
        'sweep-stale-1',
        'sweep-stale-2',
      ]);
      expect(out.apply.abandoned.map((a) => a.atomId).sort()).toEqual([
        'sweep-stale-1',
        'sweep-stale-2',
      ]);
      expect(out.apply.skipped).toHaveLength(0);

      // Verify side-effects: stale plans abandoned, others untouched.
      const stale1 = await host.atoms.get('sweep-stale-1' as AtomId);
      const stale2 = await host.atoms.get('sweep-stale-2' as AtomId);
      const fresh = await host.atoms.get('sweep-fresh' as AtomId);
      const warn = await host.atoms.get('sweep-warn' as AtomId);
      const approved = await host.atoms.get('sweep-approved' as AtomId);
      const obs = await host.atoms.get('sweep-obs' as AtomId);

      expect(stale1?.plan_state).toBe('abandoned');
      expect(stale2?.plan_state).toBe('abandoned');
      expect(fresh?.plan_state).toBe('proposed');
      expect(warn?.plan_state).toBe('proposed');
      expect(approved?.plan_state).toBe('approved');
      // observation atom has no plan_state field at all
      expect(obs?.plan_state).toBeUndefined();
    } finally {
      (host.clock as { now: () => Time }).now = realNow;
    }
  });

  it('empty store: zero abandons, zero skipped', async () => {
    const host = createMemoryHost();
    const reaper: PrincipalId = 'plan-reaper' as PrincipalId;
    const out = await runReaperSweep(host, reaper, TTLS);
    expect(out.classifications.abandon).toHaveLength(0);
    expect(out.apply.abandoned).toHaveLength(0);
    expect(out.apply.skipped).toHaveLength(0);
  });
});

describe('DEFAULT_REAPER_TTLS', () => {
  it('warn threshold is shorter than abandon threshold', () => {
    expect(DEFAULT_REAPER_TTLS.staleWarnMs).toBeLessThan(DEFAULT_REAPER_TTLS.staleAbandonMs);
  });

  it('warn threshold is 24h', () => {
    expect(DEFAULT_REAPER_TTLS.staleWarnMs).toBe(24 * 60 * 60 * 1000);
  });

  it('abandon threshold is 72h', () => {
    expect(DEFAULT_REAPER_TTLS.staleAbandonMs).toBe(72 * 60 * 60 * 1000);
  });
});
