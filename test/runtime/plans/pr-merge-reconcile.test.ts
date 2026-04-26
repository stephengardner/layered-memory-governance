/**
 * Plan-state writeback on PR merge tests.
 *
 * Covers the full matrix from the design spec plus CR-driven
 * hardening (deterministic marker id, in-code guards, race-safe
 * claim, state-machine bridging for approved -> succeeded).
 *
 *   - merged pr-observation + plan in executing -> succeeded, marker atom written
 *   - merged pr-observation + plan in approved   -> succeeded (approved -> executing -> succeeded)
 *   - closed pr-observation + plan in executing  -> abandoned
 *   - second tick: claim conflict, no double-transition
 *   - plan already succeeded: no-op (guard)
 *   - pr-observation missing plan_id: skipped
 *   - pr-observation with non-terminal merge_state_status: skipped
 *   - pr-observation tainted: skipped (in-code guard)
 *   - pr-observation superseded: skipped
 *   - plan tainted: skipped
 *   - plan superseded: skipped
 *   - deterministic marker id is stable across invocations
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { runPlanStateReconcileTick } from '../../../src/runtime/plans/pr-merge-reconcile.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-24T00:00:00.000Z' as Time;

function planAtom(
  id: string,
  overrides: {
    readonly plan_state?: PlanState;
    readonly tainted?: boolean;
    readonly superseded?: boolean;
  } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['replacement' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cto-actor' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    plan_state: overrides.plan_state ?? 'executing',
    metadata: { title: 'test plan' },
  };
}

function prObservationAtom(
  id: string,
  overrides: {
    readonly merge_state_status?: string;
    readonly pr_state?: string;
    readonly plan_id?: string | null;
    readonly tainted?: boolean;
    readonly superseded?: boolean;
    readonly pr?: Record<string, unknown>;
  } = {},
): Atom {
  const meta: Record<string, unknown> = {
    kind: 'pr-observation',
    pr: overrides.pr ?? { owner: 'o', repo: 'r', number: 42 },
    merge_state_status: overrides.merge_state_status ?? 'merged',
  };
  if (overrides.pr_state !== undefined) {
    meta['pr_state'] = overrides.pr_state;
  }
  if (overrides.plan_id !== null) {
    meta['plan_id'] = overrides.plan_id ?? 'p1';
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
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['replacement' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'lag-pr-landing' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    metadata: meta,
  };
}

function expectedMarkerId(planId: string, obsId: string): string {
  const digest = createHash('sha256')
    .update(planId)
    .update('|')
    .update(obsId)
    .digest('hex')
    .slice(0, 16);
  return `plan-merge-settled-${digest}`;
}

describe('runPlanStateReconcileTick', () => {
  it('merged pr-observation + plan in executing -> succeeded, marker written', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'executing' }));
    await host.atoms.put(prObservationAtom('obs1'));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(1);
    expect(r.transitioned).toBe(1);
    expect(r.claimConflicts).toBe(0);

    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('succeeded');
    expect(plan?.metadata['plan_state_reason']).toBe('pr-merge-reconcile');

    const marker = await host.atoms.get(expectedMarkerId('p1', 'obs1') as AtomId);
    expect(marker).not.toBeNull();
    expect(marker?.type).toBe('plan-merge-settled');
    expect(marker?.metadata['target_plan_state']).toBe('succeeded');
    expect(marker?.provenance.derived_from).toEqual(expect.arrayContaining(['p1', 'obs1']));
  });

  it('merged pr-observation + plan in approved -> succeeded (bridges through executing)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'approved' }));
    await host.atoms.put(prObservationAtom('obs1'));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.transitioned).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('succeeded');
  });

  it('closed pr-observation + plan in executing -> abandoned', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'executing' }));
    await host.atoms.put(prObservationAtom('obs1', { merge_state_status: 'closed' }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.transitioned).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('abandoned');
  });

  it('second tick: claim conflict, no double-transition', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'executing' }));
    await host.atoms.put(prObservationAtom('obs1'));

    const first = await runPlanStateReconcileTick(host, { now: () => NOW });
    expect(first.transitioned).toBe(1);

    // Plan is now succeeded; observation + marker still present. A
    // second tick must not transition again (plan state guard and
    // claim-marker duplicate both protect).
    const second = await runPlanStateReconcileTick(host, { now: () => NOW });
    expect(second.transitioned).toBe(0);
    expect(second.claimConflicts).toBe(1);
  });

  it('plan already succeeded: no-op (guard)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'succeeded' }));
    await host.atoms.put(prObservationAtom('obs1'));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    // Match + claim still happen (we record the reconciliation
    // event), but the plan doesn't transition because it's already
    // terminal. Guard fires after claim succeeds.
    expect(r.matched).toBe(1);
    expect(r.transitioned).toBe(0);
  });

  it('pr-observation missing plan_id: skipped (no match, no claim)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', { plan_id: null }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(0);
    expect(r.transitioned).toBe(0);
    expect(r.claimConflicts).toBe(0);
  });

  it('pr-observation with non-terminal merge_state_status: skipped', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', { merge_state_status: 'clean' }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(0);
    expect(r.transitioned).toBe(0);
  });

  it('pr-observation with pr_state=MERGED transitions to succeeded (preferred shape)', async () => {
    // The post-fix observation atom carries `pr_state` (PR lifecycle:
    // OPEN/CLOSED/MERGED) alongside `merge_state_status` (merge-
    // readiness, often UNKNOWN once the PR is merged). The reconciler
    // reads `pr_state` first; this test pins that path independently
    // of the legacy fallback.
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', {
      pr_state: 'MERGED',
      // Realistic post-merge GitHub shape: merge_state_status is
      // UNKNOWN because merge-readiness is no longer meaningful.
      merge_state_status: 'UNKNOWN',
    }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(1);
    expect(r.transitioned).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('succeeded');
  });

  it('pr-observation with pr_state=CLOSED transitions to abandoned', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', {
      pr_state: 'CLOSED',
      merge_state_status: 'UNKNOWN',
    }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(1);
    expect(r.transitioned).toBe(1);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('abandoned');
  });

  it('pr-observation with pr_state=OPEN: skipped (not a terminal lifecycle state)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', {
      pr_state: 'OPEN',
      merge_state_status: 'CLEAN',
    }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(0);
    expect(r.transitioned).toBe(0);
  });

  it('pr-observation tainted: skipped by in-code guard', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', { tainted: true }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(0);
  });

  it('pr-observation superseded: skipped by in-code guard', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1'));
    await host.atoms.put(prObservationAtom('obs1', { superseded: true }));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(0);
  });

  it('plan tainted: match + claim happen but transition is skipped', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { tainted: true }));
    await host.atoms.put(prObservationAtom('obs1'));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(1);
    expect(r.transitioned).toBe(0);
    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('executing'); // unchanged
  });

  it('plan superseded: match + claim happen but transition is skipped', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { superseded: true }));
    await host.atoms.put(prObservationAtom('obs1'));

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.matched).toBe(1);
    expect(r.transitioned).toBe(0);
  });

  it('recovery: marker already written, plan stranded in executing -> finishes to succeeded (CR #130)', async () => {
    // Simulates the crash-between-hops case:
    //   - Worker A wrote the marker for (plan, obs).
    //   - Worker A transitioned plan 'approved' -> 'executing' (first hop).
    //   - Worker A crashed before the second hop -> 'succeeded'.
    //   - Plan is now stranded in 'executing'; marker is in place.
    // Worker B (or a later tick) observes the same pr-observation,
    // catches ConflictError on marker put, and MUST finish the
    // transition instead of counting a conflict and moving on. The
    // recovery branch reads the plan, sees plan_state !== target,
    // and completes the transition.
    const host = createMemoryHost();
    // Plan in the stranded state.
    await host.atoms.put(planAtom('p1', { plan_state: 'executing' }));
    await host.atoms.put(prObservationAtom('obs1'));
    // Marker already present (simulating the crashed worker's claim).
    const markerId = expectedMarkerId('p1', 'obs1') as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: markerId,
      content: 'prior worker claim',
      type: 'plan-merge-settled',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'lag-pr-landing', tool: 'pr-merge-reconcile' },
        derived_from: ['p1' as AtomId, 'obs1' as AtomId],
      },
      confidence: 1.0,
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
      principal_id: 'lag-pr-landing' as PrincipalId,
      taint: 'clean',
      metadata: {
        plan_id: 'p1',
        pr_observation_id: 'obs1',
        merge_state_status: 'merged',
        target_plan_state: 'succeeded',
        settled_at: NOW,
        pr: { owner: 'o', repo: 'r', number: 42 },
      },
    });

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    // The tick claims a conflict (marker already exists) BUT then
    // recovers the stranded plan.
    expect(r.claimConflicts).toBe(1);
    expect(r.transitioned).toBe(1);

    const plan = await host.atoms.get('p1' as AtomId);
    expect(plan?.plan_state).toBe('succeeded');
    expect(plan?.metadata['plan_state_reconcile_mode']).toBe('recovery');
  });

  it('recovery: marker already written AND plan already succeeded -> no-op (idempotent)', async () => {
    // Clean idempotency case: a fully-settled (plan, pr-observation)
    // re-scan doesn't double-count transitions.
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'succeeded' }));
    await host.atoms.put(prObservationAtom('obs1'));
    const markerId = expectedMarkerId('p1', 'obs1') as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: markerId,
      content: 'prior worker claim',
      type: 'plan-merge-settled',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'lag-pr-landing', tool: 'pr-merge-reconcile' },
        derived_from: ['p1' as AtomId, 'obs1' as AtomId],
      },
      confidence: 1.0,
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
      principal_id: 'lag-pr-landing' as PrincipalId,
      taint: 'clean',
      metadata: {
        plan_id: 'p1',
        pr_observation_id: 'obs1',
        merge_state_status: 'merged',
        target_plan_state: 'succeeded',
        settled_at: NOW,
        pr: { owner: 'o', repo: 'r', number: 42 },
      },
    });

    const r = await runPlanStateReconcileTick(host, { now: () => NOW });

    expect(r.claimConflicts).toBe(1);
    expect(r.transitioned).toBe(0); // plan already at target; no-op
  });

  it('non-ConflictError on marker put propagates (no silent swallow)', async () => {
    // Injects a host where atoms.put throws a non-Conflict error for
    // plan-merge-settled writes. The pass must propagate the error
    // so callers see real storage failures instead of counting them
    // as idempotency conflicts.
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', { plan_state: 'executing' }));
    await host.atoms.put(prObservationAtom('obs1'));
    const origPut = host.atoms.put.bind(host.atoms);
    (host.atoms as unknown as { put: typeof host.atoms.put }).put = async (atom) => {
      if (atom.type === 'plan-merge-settled') {
        throw new Error('simulated storage outage');
      }
      return origPut(atom);
    };

    await expect(
      runPlanStateReconcileTick(host, { now: () => NOW }),
    ).rejects.toThrow(/simulated storage outage/);
  });

  it('deterministic marker id is stable across invocations and platforms', async () => {
    // Sanity check: the marker id is a pure function of
    // (plan_id, observation_id). This test pins the hex digest so a
    // future refactor that changes the hash input shape breaks loud.
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p-specific', { plan_state: 'executing' }));
    await host.atoms.put(prObservationAtom('obs-specific', { plan_id: 'p-specific' }));

    await runPlanStateReconcileTick(host, { now: () => NOW });

    const markerId = expectedMarkerId('p-specific', 'obs-specific');
    const marker = await host.atoms.get(markerId as AtomId);
    expect(marker).not.toBeNull();
    // Cross-check: digest is exactly 16 hex chars of sha256.
    expect(markerId).toMatch(/^plan-merge-settled-[0-9a-f]{16}$/);
  });
});
