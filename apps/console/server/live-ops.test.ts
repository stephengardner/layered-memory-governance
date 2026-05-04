import { describe, it, expect } from 'vitest';
import {
  MAX_LIST_ITEMS,
  computeHeartbeat,
  countAtomsSince,
  listActiveSessions,
  listLiveDeliberations,
  listInFlightExecutions,
  listRecentTransitions,
  computeDaemonPosture,
  listPrActivity,
  parseIsoTs,
} from './live-ops';
import type { LiveOpsAtom } from './live-ops-types';

/*
 * Unit tests for the live-ops snapshot helpers. The handler is
 * integration-tested via the Playwright e2e against the running
 * backend; these cover the time-window math (the most error-prone
 * surface) and empty-store correctness so the dashboard renders
 * gracefully on a fresh atom store.
 *
 * Pin `now` to a fixed epoch for every test so window-boundary
 * assertions stay deterministic across machines.
 */

const NOW = Date.parse('2026-04-26T12:00:00.000Z');

function atom(partial: Partial<LiveOpsAtom> & { id: string; type: string; created_at: string }): LiveOpsAtom {
  return {
    layer: 'L1',
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    ...partial,
  };
}

describe('parseIsoTs', () => {
  it('returns NaN for nullish or empty input -- never throws', () => {
    expect(Number.isNaN(parseIsoTs(undefined))).toBe(true);
    expect(Number.isNaN(parseIsoTs(null))).toBe(true);
    expect(Number.isNaN(parseIsoTs(''))).toBe(true);
  });

  it('parses ISO UTC timestamps', () => {
    expect(parseIsoTs('2026-04-26T12:00:00.000Z')).toBe(NOW);
  });

  it('returns NaN for malformed input rather than throwing', () => {
    expect(Number.isNaN(parseIsoTs('not-a-date'))).toBe(true);
  });
});

describe('countAtomsSince', () => {
  it('returns 0 for empty input', () => {
    expect(countAtomsSince([], NOW, 60_000)).toBe(0);
  });

  it('counts atoms whose created_at is inside the [now - windowMs, now] window', () => {
    const atoms: LiveOpsAtom[] = [
      atom({ id: 'a', type: 'observation', created_at: new Date(NOW - 30_000).toISOString() }),
      atom({ id: 'b', type: 'observation', created_at: new Date(NOW - 90_000).toISOString() }),
      atom({ id: 'c', type: 'observation', created_at: new Date(NOW - 30 * 60_000).toISOString() }),
    ];
    expect(countAtomsSince(atoms, NOW, 60_000)).toBe(1); // only a
    expect(countAtomsSince(atoms, NOW, 5 * 60_000)).toBe(2); // a + b
    expect(countAtomsSince(atoms, NOW, 60 * 60_000)).toBe(3); // all three
  });

  it('skips atoms with malformed or missing created_at without throwing', () => {
    const atoms: LiveOpsAtom[] = [
      atom({ id: 'a', type: 'observation', created_at: 'garbage' }),
      atom({ id: 'b', type: 'observation', created_at: '' }),
      atom({ id: 'c', type: 'observation', created_at: new Date(NOW - 30_000).toISOString() }),
    ];
    expect(countAtomsSince(atoms, NOW, 60_000)).toBe(1);
  });

  it('treats a future created_at (clock skew > skew tolerance) as outside the window', () => {
    const atoms: LiveOpsAtom[] = [
      atom({ id: 'a', type: 'observation', created_at: new Date(NOW + 30_000).toISOString() }),
    ];
    expect(countAtomsSince(atoms, NOW, 60_000)).toBe(0);
  });
});

describe('computeHeartbeat', () => {
  it('returns all-zero counts for an empty store and a delta of 0', () => {
    const hb = computeHeartbeat([], NOW);
    expect(hb).toEqual({ last_60s: 0, last_5m: 0, last_1h: 0, delta: 0 });
  });

  it('computes negative delta when the prior 60s outweighs the most recent', () => {
    /*
     * Ensure samples land STRICTLY inside the prior window
     * [now - 120s, now - 60s) -- the boundary at exactly now - 60s
     * is owned by the current window, not the prior. Use 90s and
     * 100s which sit comfortably inside [-120s, -60s).
     */
    const atoms: LiveOpsAtom[] = [
      atom({ id: 'a', type: 'observation', created_at: new Date(NOW - 30_000).toISOString() }),
      atom({ id: 'b', type: 'observation', created_at: new Date(NOW - 45_000).toISOString() }),
      atom({ id: 'c', type: 'observation', created_at: new Date(NOW - 90_000).toISOString() }),
      atom({ id: 'd', type: 'observation', created_at: new Date(NOW - 100_000).toISOString() }),
      atom({ id: 'e', type: 'observation', created_at: new Date(NOW - 110_000).toISOString() }),
    ];
    const hb = computeHeartbeat(atoms, NOW);
    expect(hb.last_60s).toBe(2);
    expect(hb.last_5m).toBe(5);
    // Prior 60s window contains c, d, e -> 3 atoms; delta = 2 - 3 = -1.
    expect(hb.delta).toBe(-1);
  });

  it('computes positive delta when the recent window leads', () => {
    const atoms: LiveOpsAtom[] = [
      atom({ id: 'a', type: 'observation', created_at: new Date(NOW - 5_000).toISOString() }),
      atom({ id: 'b', type: 'observation', created_at: new Date(NOW - 10_000).toISOString() }),
      atom({ id: 'c', type: 'observation', created_at: new Date(NOW - 30_000).toISOString() }),
      atom({ id: 'd', type: 'observation', created_at: new Date(NOW - 110_000).toISOString() }),
    ];
    const hb = computeHeartbeat(atoms, NOW);
    expect(hb.last_60s).toBe(3);
    // Prior window has d only.
    expect(hb.delta).toBe(2);
  });
});

describe('listActiveSessions', () => {
  it('returns an empty array for an empty store', () => {
    expect(listActiveSessions([], NOW)).toEqual([]);
  });

  it('treats a session with no ended_at and no turns as active (just-spawned)', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'agent-session-cto-1',
        type: 'agent-session',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          session_id: 'sess-1',
          started_at: new Date(NOW - 30_000).toISOString(),
        },
      }),
    ];
    const out = listActiveSessions(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.session_id).toBe('sess-1');
    expect(out[0]?.last_turn_at).toBeNull();
  });

  it('treats a session whose latest turn lands inside the active window as active', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'agent-session-x',
        type: 'agent-session',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 5 * 60_000).toISOString(),
        metadata: { session_id: 'sess-x', started_at: new Date(NOW - 5 * 60_000).toISOString() },
      }),
      atom({
        id: 'agent-turn-x-1',
        type: 'agent-turn',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 20_000).toISOString(),
        metadata: { session_id: 'sess-x' },
      }),
    ];
    const out = listActiveSessions(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.last_turn_at).toBe(new Date(NOW - 20_000).toISOString());
  });

  // Regression: a session with NO turns and a started_at older than the
  // active window must NOT count as active. Without the started_at-fallback
  // age-out, a turn-less agent-session atom (e.g. a 13-hour-old cron-pulse
  // stub) would show as active indefinitely because the original turn-less
  // grace branch was unconditional.
  it('drops a turn-less session whose started_at is older than the active window', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'agent-session-op-session-cron-pulse-stale',
        type: 'agent-session',
        principal_id: 'operator-principal',
        created_at: new Date(NOW - 13 * 60 * 60_000).toISOString(),
        metadata: {
          session_id: 'pulse-stale',
          started_at: new Date(NOW - 13 * 60 * 60_000).toISOString(),
        },
      }),
    ];
    expect(listActiveSessions(atoms, NOW)).toEqual([]);
  });

  // Just-spawned grace: a turn-less session whose started_at is within the
  // active window stays active so a session opened 200ms before the
  // snapshot fired still appears on the dashboard.
  it('keeps a turn-less session whose started_at is within the active window', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'agent-session-fresh',
        type: 'agent-session',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          session_id: 'sess-fresh',
          started_at: new Date(NOW - 30_000).toISOString(),
        },
      }),
    ];
    const out = listActiveSessions(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.session_id).toBe('sess-fresh');
    expect(out[0]?.last_turn_at).toBeNull();
  });

  it('drops sessions whose latest turn is older than the active window', () => {
    // Window is ACTIVE_SESSION_TURN_WINDOW_MS (15 minutes). The turn here
    // is 16 minutes old so it falls outside the window regardless of
    // boundary inclusivity.
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'agent-session-stale',
        type: 'agent-session',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 20 * 60_000).toISOString(),
        metadata: { session_id: 'stale', started_at: new Date(NOW - 20 * 60_000).toISOString() },
      }),
      atom({
        id: 'agent-turn-stale-1',
        type: 'agent-turn',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 16 * 60_000).toISOString(),
        metadata: { session_id: 'stale' },
      }),
    ];
    expect(listActiveSessions(atoms, NOW)).toEqual([]);
  });

  it('drops sessions explicitly ended (metadata.ended_at present)', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'agent-session-done',
        type: 'agent-session',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: {
          session_id: 'done',
          started_at: new Date(NOW - 60_000).toISOString(),
          ended_at: new Date(NOW - 30_000).toISOString(),
        },
      }),
    ];
    expect(listActiveSessions(atoms, NOW)).toEqual([]);
  });

  it('caps the response list at MAX_LIST_ITEMS', () => {
    const many: LiveOpsAtom[] = [];
    for (let i = 0; i < MAX_LIST_ITEMS + 5; i += 1) {
      many.push(
        atom({
          id: `agent-session-${i}`,
          type: 'agent-session',
          principal_id: 'cto-actor',
          created_at: new Date(NOW - 1_000).toISOString(),
          metadata: { session_id: `sess-${i}`, started_at: new Date(NOW - 1_000).toISOString() },
        }),
      );
    }
    expect(listActiveSessions(many, NOW)).toHaveLength(MAX_LIST_ITEMS);
  });
});

describe('listLiveDeliberations', () => {
  it('returns an empty array for an empty store (graceful empty render)', () => {
    expect(listLiveDeliberations([], NOW)).toEqual([]);
  });

  it('selects only proposed plans, sorts newest first, computes age_seconds', () => {
    const atoms: LiveOpsAtom[] = [
      {
        id: 'plan-a',
        type: 'plan',
        layer: 'L1',
        content: '# Plan A title\n\nbody',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: { title: 'Plan A title', plan_state: 'proposed' },
      } as LiveOpsAtom,
      {
        id: 'plan-b',
        type: 'plan',
        layer: 'L1',
        content: '# Plan B title',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 10_000).toISOString(),
        metadata: { plan_state: 'proposed' },
      } as LiveOpsAtom,
      {
        id: 'plan-c',
        type: 'plan',
        layer: 'L1',
        content: '# Old completed plan',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 5_000).toISOString(),
        metadata: { plan_state: 'succeeded' },
      } as LiveOpsAtom,
    ];
    /*
     * Top-level plan_state field -- the wider runtime case per
     * arch-plan-state-top-level-field. Mirrors metadata-only tests
     * above so both paths are covered.
     */
    (atoms[0] as unknown as Record<string, unknown>)['plan_state'] = 'proposed';
    (atoms[1] as unknown as Record<string, unknown>)['plan_state'] = 'proposed';
    (atoms[2] as unknown as Record<string, unknown>)['plan_state'] = 'succeeded';
    const out = listLiveDeliberations(atoms, NOW);
    expect(out).toHaveLength(2);
    expect(out[0]?.plan_id).toBe('plan-b'); // newest first
    expect(out[0]?.age_seconds).toBe(10);
    expect(out[1]?.plan_id).toBe('plan-a');
    expect(out[1]?.title).toBe('Plan A title');
  });

  it('falls back to first content line then to atom.id for the title', () => {
    const atoms: LiveOpsAtom[] = [
      {
        id: 'plan-no-title',
        type: 'plan',
        layer: 'L1',
        content: '# From content\nbody',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 10_000).toISOString(),
        metadata: { plan_state: 'proposed' },
      } as LiveOpsAtom,
      {
        id: 'plan-no-content',
        type: 'plan',
        layer: 'L1',
        content: '',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 5_000).toISOString(),
        metadata: { plan_state: 'proposed' },
      } as LiveOpsAtom,
    ];
    const out = listLiveDeliberations(atoms, NOW);
    expect(out[0]?.title).toBe('plan-no-content'); // newer, falls back to id
    expect(out[1]?.title).toBe('From content');
  });

  // Regression: missingJudgmentPlan() in
  // src/runtime/actors/planning/host-llm-judgment.ts (lines 135-168) emits
  // plan_state='proposed' atoms with id-prefix 'plan-clarify-cannot-draft-'
  // when the LLM cannot draft a grounded plan. Those are explicit failure
  // escalations (confidence 0.15), not live deliberations, and must be
  // filtered out of the front-page feed so the dashboard does not read
  // "all failures."
  it('filters out plan-clarify-cannot-draft failure-escalation atoms', () => {
    const atoms: LiveOpsAtom[] = [
      {
        id: 'plan-clarify-cannot-draft-a-grounded-plan-llm-cto-actor-20260420043034',
        type: 'plan',
        layer: 'L1',
        content: '# Clarify: cannot draft a grounded plan (llm)',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 5_000).toISOString(),
        metadata: { plan_state: 'proposed' },
      } as LiveOpsAtom,
      {
        id: 'plan-do-thing',
        type: 'plan',
        layer: 'L1',
        content: '# Real proposed plan',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 10_000).toISOString(),
        metadata: { plan_state: 'proposed' },
      } as LiveOpsAtom,
    ];
    const out = listLiveDeliberations(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.plan_id).toBe('plan-do-thing');
  });

  it('skips superseded plans even if still in proposed state', () => {
    const atoms: LiveOpsAtom[] = [
      {
        id: 'plan-superseded',
        type: 'plan',
        layer: 'L1',
        content: '# title',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 5_000).toISOString(),
        metadata: { plan_state: 'proposed' },
        superseded_by: ['plan-newer'],
      } as LiveOpsAtom,
    ];
    expect(listLiveDeliberations(atoms, NOW)).toEqual([]);
  });
});

describe('listInFlightExecutions', () => {
  it('returns an empty array for an empty store', () => {
    expect(listInFlightExecutions([], NOW)).toEqual([]);
  });

  it('selects only executing plans and resolves dispatch timestamp from dispatch_result.at', () => {
    const dispatchAt = new Date(NOW - 120_000).toISOString();
    const atoms: LiveOpsAtom[] = [
      {
        id: 'plan-exec',
        type: 'plan',
        layer: 'L1',
        content: '# title',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 200_000).toISOString(),
        metadata: {
          plan_state: 'executing',
          approved_by: 'apex-agent',
          dispatch_result: { at: dispatchAt, kind: 'ok' },
        },
      } as LiveOpsAtom,
      {
        id: 'plan-other',
        type: 'plan',
        layer: 'L1',
        content: '# title',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 100_000).toISOString(),
        metadata: { plan_state: 'proposed' },
      } as LiveOpsAtom,
    ];
    const out = listInFlightExecutions(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.plan_id).toBe('plan-exec');
    expect(out[0]?.dispatched_at).toBe(dispatchAt);
    expect(out[0]?.age_seconds).toBe(120);
    expect(out[0]?.dispatched_by).toBe('apex-agent');
  });

  it('falls back to approved_at then atom.created_at when dispatch_result.at is missing', () => {
    const approvedAt = new Date(NOW - 60_000).toISOString();
    const atoms: LiveOpsAtom[] = [
      {
        id: 'plan-exec-fallback',
        type: 'plan',
        layer: 'L1',
        content: '# title',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 90_000).toISOString(),
        metadata: { plan_state: 'executing', approved_at: approvedAt },
      } as LiveOpsAtom,
    ];
    const out = listInFlightExecutions(atoms, NOW);
    expect(out[0]?.dispatched_at).toBe(approvedAt);
    expect(out[0]?.age_seconds).toBe(60);
  });
});

describe('listRecentTransitions', () => {
  it('returns an empty array for an empty store', () => {
    expect(listRecentTransitions([], NOW)).toEqual([]);
  });

  it('selects plan-merge-settled atoms inside the 15min window', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-merge-settled-1',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 5 * 60_000).toISOString(),
        metadata: {
          plan_id: 'plan-x',
          target_plan_state: 'succeeded',
          settled_at: new Date(NOW - 5 * 60_000).toISOString(),
        },
      }),
      atom({
        id: 'plan-merge-settled-old',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 60 * 60_000).toISOString(),
        metadata: {
          plan_id: 'plan-old',
          target_plan_state: 'succeeded',
          settled_at: new Date(NOW - 60 * 60_000).toISOString(),
        },
      }),
    ];
    const out = listRecentTransitions(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.plan_id).toBe('plan-x');
    expect(out[0]?.prev_state).toBe('executing');
    expect(out[0]?.new_state).toBe('succeeded');
  });

  it('drops settled atoms with malformed plan_id or target_plan_state', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'broken',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { plan_id: 'plan-x' /* missing target_plan_state */ },
      }),
    ];
    expect(listRecentTransitions(atoms, NOW)).toEqual([]);
  });
});

describe('computeDaemonPosture', () => {
  it('reports kill_switch_engaged=false when tier is off and no elevations exist', () => {
    const out = computeDaemonPosture([], NOW, 'off', 1);
    expect(out.kill_switch_engaged).toBe(false);
    expect(out.kill_switch_tier).toBe('off');
    expect(out.autonomy_dial).toBe(1);
    expect(out.active_elevations).toEqual([]);
  });

  it('reports kill_switch_engaged=true when soft tier is active', () => {
    const out = computeDaemonPosture([], NOW, 'soft', 0.5);
    expect(out.kill_switch_engaged).toBe(true);
  });

  it('lists L3 directives whose elevation.expires_at is in the future, soonest first', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pol-temp-2',
        type: 'directive',
        layer: 'L3',
        principal_id: 'apex-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: {
          elevation: {
            started_at: new Date(NOW - 60_000).toISOString(),
            expires_at: new Date(NOW + 30 * 60_000).toISOString(),
          },
        },
      }),
      atom({
        id: 'pol-temp-1',
        type: 'directive',
        layer: 'L3',
        principal_id: 'apex-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: {
          elevation: {
            started_at: new Date(NOW - 60_000).toISOString(),
            expires_at: new Date(NOW + 5 * 60_000).toISOString(),
          },
        },
      }),
      atom({
        id: 'pol-expired',
        type: 'directive',
        layer: 'L3',
        principal_id: 'apex-agent',
        created_at: new Date(NOW - 24 * 60 * 60_000).toISOString(),
        metadata: {
          elevation: {
            started_at: new Date(NOW - 24 * 60 * 60_000).toISOString(),
            expires_at: new Date(NOW - 60_000).toISOString(),
          },
        },
      }),
    ];
    const out = computeDaemonPosture(atoms, NOW, 'off', 1);
    expect(out.active_elevations).toHaveLength(2);
    expect(out.active_elevations[0]?.atom_id).toBe('pol-temp-1'); // soonest
    expect(out.active_elevations[0]?.ms_until_expiry).toBe(5 * 60_000);
    expect(out.active_elevations[1]?.atom_id).toBe('pol-temp-2');
  });

  it('drops superseded or tainted L3 elevations', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pol-superseded',
        type: 'directive',
        layer: 'L3',
        principal_id: 'apex-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        superseded_by: ['pol-newer'],
        metadata: {
          elevation: {
            started_at: new Date(NOW - 60_000).toISOString(),
            expires_at: new Date(NOW + 60_000).toISOString(),
          },
        },
      }),
      atom({
        id: 'pol-tainted',
        type: 'directive',
        layer: 'L3',
        principal_id: 'apex-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        taint: 'compromised',
        metadata: {
          elevation: {
            started_at: new Date(NOW - 60_000).toISOString(),
            expires_at: new Date(NOW + 60_000).toISOString(),
          },
        },
      }),
    ];
    expect(computeDaemonPosture(atoms, NOW, 'off', 1).active_elevations).toEqual([]);
  });
});

describe('listPrActivity', () => {
  it('returns an empty array for an empty store', () => {
    expect(listPrActivity([], NOW)).toEqual([]);
  });

  it('aggregates pr-observation atoms by pr_number; latest observation wins', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-old',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 60 * 60_000).toISOString(),
        metadata: { kind: 'pr-observation', pr_number: 200, pr_state: 'OPEN', pr_title: 'old title' },
      }),
      atom({
        id: 'pr-observation-new',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30 * 60_000).toISOString(),
        metadata: { kind: 'pr-observation', pr_number: 200, pr_state: 'OPEN', pr_title: 'new title' },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(200);
    expect(out[0]?.title).toBe('new title');
    expect(out[0]?.state).toBe('open');
  });

  it('respects the 24h window and ignores older atoms', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-ancient',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 48 * 60 * 60_000).toISOString(),
        metadata: { kind: 'pr-observation', pr_number: 100, pr_state: 'MERGED' },
      }),
    ];
    expect(listPrActivity(atoms, NOW)).toEqual([]);
  });

  it('plan-merge-settled atoms force state=merged for their PR', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-201',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { kind: 'pr-observation', pr_number: 201, pr_state: 'OPEN' },
      }),
      atom({
        id: 'plan-merge-settled-201',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: { pr: { number: 201 }, target_plan_state: 'succeeded' },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.state).toBe('merged');
  });

  // Regression: a stale OPEN observation arriving AFTER the settled
  // atom (or a re-open on a revert flow) must NOT rewind the row from
  // merged back to open. The aggregator owns this invariant.
  it('merged is sticky against a later pr-observation OPEN', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-merge-settled-201',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { pr: { number: 201 }, target_plan_state: 'succeeded' },
      }),
      atom({
        id: 'pr-observation-201-late',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: { kind: 'pr-observation', pr_number: 201, pr_state: 'OPEN' },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.state).toBe('merged');
  });

  // Regression: when the settled atom has an OLDER timestamp than the
  // current pick, it still pins the terminal state to merged.
  it('merged is sticky even when the settled atom is older than later observations', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-202-recent',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 10_000).toISOString(),
        metadata: { kind: 'pr-observation', pr_number: 202, pr_state: 'OPEN' },
      }),
      atom({
        id: 'plan-merge-settled-202-old',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 3600_000).toISOString(),
        metadata: { pr: { number: 202 }, target_plan_state: 'succeeded' },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.state).toBe('merged');
  });

  /*
   * Title-resolution ladder regression: pr-observation atoms today do
   * NOT carry pr_title in metadata (the upstream PrReviewStatus shape
   * predates the field), so the Pulse "PR activity" tile rendered
   * "(no title)" for every entry until the live-ops aggregator
   * gained the plan-id / derived_from fallback.
   */
  it('falls back to the plan atom title via metadata.plan_id when pr_title is absent', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-add-readme-pointer',
        type: 'plan',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { title: 'Add README pointer to design/target-architecture.md' },
      }),
      atom({
        id: 'pr-observation-300',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: { number: 300 },
          pr_state: 'OPEN',
          plan_id: 'plan-add-readme-pointer',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(300);
    expect(out[0]?.title).toBe('Add README pointer to design/target-architecture.md');
  });

  it('falls back to the plan atom title via provenance.derived_from when plan_id is absent', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-legacy-no-plan-id',
        type: 'plan',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { title: 'Legacy plan (no metadata.plan_id on observation)' },
      }),
      atom({
        id: 'pr-observation-301',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        provenance: { derived_from: ['plan-legacy-no-plan-id'] },
        metadata: {
          kind: 'pr-observation',
          pr: { number: 301 },
          pr_state: 'OPEN',
          /* no plan_id field; older atoms predated it */
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Legacy plan (no metadata.plan_id on observation)');
  });

  it('prefers metadata.pr_title over the plan-title fallback when both exist', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-fallback-title',
        type: 'plan',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { title: 'fallback plan title' },
      }),
      atom({
        id: 'pr-observation-302',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: { number: 302 },
          pr_state: 'OPEN',
          pr_title: 'live PR title from GitHub',
          plan_id: 'plan-fallback-title',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out[0]?.title).toBe('live PR title from GitHub');
  });

  it('returns null title when no fallback resolves (plan atom missing)', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-303',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: { number: 303 },
          pr_state: 'OPEN',
          plan_id: 'plan-does-not-exist',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out[0]?.title).toBeNull();
  });

  // Regression: an empty-string `pr_title` should NOT block the
  // plan-title fallback (the rest of the ladder treats empty as
  // absent via the same `length > 0` guard).
  it('treats empty-string pr_title as absent and falls back to the plan title', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-empty-pr-title-fallback',
        type: 'plan',
        principal_id: 'cto-actor',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: { title: 'Plan title used because pr_title was empty' },
      }),
      atom({
        id: 'pr-observation-304',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: { number: 304 },
          pr_state: 'OPEN',
          pr_title: '',
          plan_id: 'plan-empty-pr-title-fallback',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out[0]?.title).toBe('Plan title used because pr_title was empty');
  });

  /*
   * pr_url derivation regression set. The projection layer derives
   * the canonical GitHub URL from metadata.pr.{owner, repo, number};
   * the substrate layer (pr-observation producer) is unchanged. The
   * cases below cover the happy path, missing-owner/repo graceful
   * null, the shape-variant plan-merge-settled path with only
   * number, and the encodeURIComponent guard against owner/repo
   * strings that contain path-bearing characters.
   */
  it('emits pr_url for observation atoms with full pr.owner/repo/number', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-400',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: {
            owner: 'stephengardner',
            repo: 'layered-autonomous-governance',
            number: 400,
          },
          pr_state: 'OPEN',
          pr_title: 'feat: a thing',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_url).toBe(
      'https://github.com/stephengardner/layered-autonomous-governance/pull/400',
    );
  });

  it('emits null pr_url when pr.owner is missing (graceful degradation)', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-401',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          // owner absent; repo + number present
          pr: { repo: 'layered-autonomous-governance', number: 401 },
          pr_state: 'OPEN',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_url).toBeNull();
  });

  it('emits null pr_url when atom has only pr.number (e.g. plan-merge-settled with shape-variant)', () => {
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'plan-merge-settled-402',
        type: 'plan-merge-settled',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          // Shape variant: only the number, no owner/repo. Older
          // settled atoms wrote this minimal shape before the
          // owner+repo triple landed in the producer.
          pr: { number: 402 },
          target_plan_state: 'succeeded',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(402);
    expect(out[0]?.pr_url).toBeNull();
    expect(out[0]?.state).toBe('merged');
  });

  it('encodeURIComponent guards owner/repo so a path-bearing string cannot break out of the URL', () => {
    /*
     * GitHub repo names are tightly constrained by upstream rules,
     * but the substrate stays defensive: never trust the metadata
     * payload to be path-safe. A pathological owner like
     * `evil/../redirect` would otherwise build an href that escaped
     * `/pull/<n>`. encodeURIComponent percent-encodes `/` as %2F
     * so the resulting URL stays inside the github.com path
     * structure regardless of the literal owner string.
     */
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-403',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 30_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: { owner: 'evil/../redirect', repo: 'r', number: 403 },
          pr_state: 'OPEN',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out[0]?.pr_url).toBe('https://github.com/evil%2F..%2Fredirect/r/pull/403');
  });

  it('falls back to an older atom\'s pr_url when a newer atom for the same PR lacks owner/repo', () => {
    /*
     * Sticky-pr_url: an older observation that DID carry the
     * pr.owner/pr.repo triple should not be clobbered by a later
     * shape-variant atom missing one of them. The link is a stable
     * derivation, not a freshness signal.
     */
    const atoms: LiveOpsAtom[] = [
      atom({
        id: 'pr-observation-404-old-rich',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 60_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: {
            owner: 'stephengardner',
            repo: 'layered-autonomous-governance',
            number: 404,
          },
          pr_state: 'OPEN',
        },
      }),
      atom({
        id: 'pr-observation-404-new-thin',
        type: 'observation',
        principal_id: 'pr-landing-agent',
        created_at: new Date(NOW - 10_000).toISOString(),
        metadata: {
          kind: 'pr-observation',
          pr: { number: 404 },
          pr_state: 'OPEN',
        },
      }),
    ];
    const out = listPrActivity(atoms, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_url).toBe(
      'https://github.com/stephengardner/layered-autonomous-governance/pull/404',
    );
  });
});
