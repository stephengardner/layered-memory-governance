/**
 * Plan-dispatch tests.
 *
 * Covers:
 *   - approved plan with delegation envelope -> invoker called,
 *     plan transitions to 'succeeded', metadata.dispatch_result set
 *   - approved plan targeting an unregistered sub-actor -> plan
 *     moves to 'failed' and an escalation actor-message is written
 *   - invoker returns 'dispatched' (async) -> plan transitions to
 *     'executing'
 *   - plans without delegation envelope -> ignored
 *   - plans that aren't in 'approved' state -> ignored
 *   - superseded or tainted plans -> ignored
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runDispatchTick } from '../../src/actor-message/plan-dispatch.js';
import {
  SubActorRegistry,
  type InvokeResult,
} from '../../src/actor-message/sub-actor-registry.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';

function planAtom(
  id: string,
  overrides: {
    readonly plan_state?: Atom['plan_state'];
    readonly delegation?: unknown;
    readonly superseded?: boolean;
    readonly tainted?: boolean;
  } = {},
): Atom {
  const now = '2026-04-20T00:00:00.000Z' as Time;
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'cto-actor', tool: 'planner' },
      derived_from: [],
    },
    confidence: 0.8,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['ghost' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cto-actor' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    plan_state: overrides.plan_state ?? 'approved',
    metadata: {
      ...(overrides.delegation !== undefined ? { delegation: overrides.delegation } : {}),
    },
  };
}

describe('runDispatchTick', () => {
  it('invokes the sub-actor and marks the plan succeeded', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    let invokerCalls = 0;
    registry.register('auditor-actor' as PrincipalId, async (_payload, corr): Promise<InvokeResult> => {
      invokerCalls += 1;
      return { kind: 'completed', producedAtomIds: [`out-${corr}`], summary: 'ok' };
    });

    await host.atoms.put(planAtom('p1', {
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: { reply_to: 'operator' },
        correlation_id: 'corr-p1',
        escalate_to: 'operator',
      },
    }));

    const result = await runDispatchTick(host, registry);
    expect(result).toEqual({ scanned: 1, dispatched: 1, failed: 0 });
    expect(invokerCalls).toBe(1);

    const updated = await host.atoms.get('p1' as AtomId);
    expect(updated!.plan_state).toBe('succeeded');
    const dispatchResult = updated!.metadata.dispatch_result as { kind: string; summary: string; produced_atom_ids: string[] };
    expect(dispatchResult.kind).toBe('completed');
    expect(dispatchResult.produced_atom_ids).toEqual(['out-corr-p1']);
  });

  it('writes an escalation actor-message and marks plan failed when sub-actor is unregistered', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    await host.atoms.put(planAtom('p2', {
      delegation: {
        sub_actor_principal_id: 'ghost-actor',
        payload: {},
        correlation_id: 'corr-p2',
        escalate_to: 'operator',
      },
    }));

    const result = await runDispatchTick(host, registry);
    expect(result).toEqual({ scanned: 1, dispatched: 0, failed: 1 });

    const updated = await host.atoms.get('p2' as AtomId);
    expect(updated!.plan_state).toBe('failed');

    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const escalation = replies.atoms.find(
      (a) => a.metadata?.actor_message?.correlation_id === 'corr-p2',
    );
    expect(escalation).toBeDefined();
    expect(escalation!.metadata.actor_message.to).toBe('operator');
    expect(escalation!.metadata.actor_message.topic).toBe('dispatch-failed');
    expect(escalation!.metadata.actor_message.body).toContain('ghost-actor');
  });

  it("transitions plan to 'executing' when invoker returns 'dispatched'", async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('slow-actor' as PrincipalId, async (): Promise<InvokeResult> => ({
      kind: 'dispatched',
      summary: 'fire-and-forget',
    }));
    await host.atoms.put(planAtom('p3', {
      delegation: {
        sub_actor_principal_id: 'slow-actor',
        payload: {},
        correlation_id: 'corr-p3',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry);

    const updated = await host.atoms.get('p3' as AtomId);
    expect(updated!.plan_state).toBe('executing');
  });

  it('ignores plans without a delegation envelope', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    await host.atoms.put(planAtom('p4')); // no delegation
    const result = await runDispatchTick(host, registry);
    expect(result.scanned).toBe(0);
  });

  it('ignores plans not in approved state', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: '',
    }));
    await host.atoms.put(planAtom('p5', {
      plan_state: 'proposed',
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-p5',
        escalate_to: 'operator',
      },
    }));
    const result = await runDispatchTick(host, registry);
    expect(result.scanned).toBe(0);
  });

  it('claims the plan (approved -> executing) BEFORE calling the invoker', async () => {
    // Regression guard for the CR-flagged race: two overlapping
    // ticks must not both invoke the same plan. The claim step
    // transitions approved -> executing so a concurrent tick's
    // candidates filter drops the plan.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();

    // Invoker that records whether the plan was already in 'executing'
    // state at the moment it was called. If the claim is correct, YES.
    let planStateWhenInvoked: string | undefined;
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => {
      const p = await host.atoms.get('p-claim' as AtomId);
      planStateWhenInvoked = p?.plan_state;
      return { kind: 'completed', producedAtomIds: [], summary: 'ok' };
    });

    await host.atoms.put(planAtom('p-claim', {
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-claim',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry);

    // Before invoke, the plan must have been moved to 'executing'
    // to prevent a concurrent tick from also invoking.
    expect(planStateWhenInvoked).toBe('executing');

    // Final state reaches 'succeeded' as usual.
    const final = await host.atoms.get('p-claim' as AtomId);
    expect(final!.plan_state).toBe('succeeded');
  });

  it('does not clobber concurrent metadata added between claim and result-write', async () => {
    // Regression guard for the CR note that re-spreading
    // ...plan.metadata can overwrite metadata keys a concurrent
    // writer added. The fix relies on AtomStore.update merging
    // metadata by key; this test proves a writer-added key
    // survives the dispatch.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => {
      // Simulate a concurrent writer adding a metadata key while
      // the invoker is mid-flight.
      await host.atoms.update('p-concurrent' as AtomId, {
        metadata: { concurrent_note: 'added-mid-flight' },
      });
      return { kind: 'completed', producedAtomIds: [], summary: 'ok' };
    });

    await host.atoms.put(planAtom('p-concurrent', {
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-concurrent',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry);

    const final = await host.atoms.get('p-concurrent' as AtomId);
    expect(final!.plan_state).toBe('succeeded');
    // BOTH the concurrent_note and dispatch_result must be present.
    expect(final!.metadata.concurrent_note).toBe('added-mid-flight');
    expect((final!.metadata.dispatch_result as { kind: string }).kind).toBe('completed');
  });

  it('ignores superseded and tainted plans', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: '',
    }));
    await host.atoms.put(planAtom('p6', {
      superseded: true,
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-p6',
        escalate_to: 'operator',
      },
    }));
    await host.atoms.put(planAtom('p7', {
      tainted: true,
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-p7',
        escalate_to: 'operator',
      },
    }));
    const result = await runDispatchTick(host, registry);
    expect(result.scanned).toBe(0);
  });
});
