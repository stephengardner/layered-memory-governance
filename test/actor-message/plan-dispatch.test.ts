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
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

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

  it('defaults correlation_id, payload, and escalate_to when only sub_actor_principal_id is declared', async () => {
    // Regression guard for the substrate gap caught while dogfooding
    // the autonomous-intent flow: PLAN_DRAFT only requires
    // sub_actor_principal_id + reason + implied_blast_radius, so a
    // CTO-drafted plan never carries correlation_id / escalate_to /
    // payload. Pre-fix the dispatch tick rejected such plans at the
    // candidate filter and they never invoked, even though policy +
    // approval succeeded.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    let invokerCalls = 0;
    let receivedPayload: unknown;
    let receivedCorrId: string | undefined;
    registry.register('code-author' as PrincipalId, async (payload, corr): Promise<InvokeResult> => {
      invokerCalls += 1;
      receivedPayload = payload;
      receivedCorrId = corr;
      return { kind: 'completed', producedAtomIds: [], summary: 'ok' };
    });

    // Descriptor-only delegation: matches what PLAN_DRAFT emits and
    // nothing more. correlation_id, escalate_to, and payload are all
    // omitted on purpose.
    await host.atoms.put(planAtom('p-defaults', {
      delegation: {
        sub_actor_principal_id: 'code-author',
        reason: 'Touches CI YAML.',
        implied_blast_radius: 'tooling',
      },
    }));

    const result = await runDispatchTick(host, registry);
    expect(result).toEqual({ scanned: 1, dispatched: 1, failed: 0 });
    expect(invokerCalls).toBe(1);
    // Defaults are deterministic per plan id so observation atoms
    // thread back to the same logical dispatch on a retry.
    expect(receivedCorrId).toBe('dispatch-p-defaults');
    expect(receivedPayload).toEqual({ plan_id: 'p-defaults' });

    const updated = await host.atoms.get('p-defaults' as AtomId);
    expect(updated!.plan_state).toBe('succeeded');
  });

  it('null payload on the descriptor falls back to the default { plan_id }', async () => {
    // Regression for the PR-#160 review finding: an explicit `null`
    // on obj.payload would slip past `!== undefined` and propagate
    // null into the invoker contract, which standard invokers (e.g.
    // code-author) crash on with "cannot read properties of null
    // (reading 'plan_id')". Treat null like undefined so the default
    // fallback engages and the invoker always sees a dispatchable
    // shape.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    let receivedPayload: unknown;
    registry.register('code-author' as PrincipalId, async (payload): Promise<InvokeResult> => {
      receivedPayload = payload;
      return { kind: 'completed', producedAtomIds: [], summary: 'ok' };
    });

    await host.atoms.put(planAtom('p-null-payload', {
      delegation: {
        sub_actor_principal_id: 'code-author',
        reason: 'descriptor with explicit null payload',
        implied_blast_radius: 'tooling',
        payload: null,
      },
    }));

    const result = await runDispatchTick(host, registry);
    expect(result.dispatched).toBe(1);
    expect(receivedPayload).toEqual({ plan_id: 'p-null-payload' });
  });

  it('escalate_to defaults to the originating intent principal when the plan derives from one', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('ghost-actor' as PrincipalId, async (): Promise<InvokeResult> => {
      throw new Error('intentional dispatch failure');
    });

    // Seed an operator-intent atom so deriveEscalateTo can find it
    // via plan.provenance.derived_from.
    const intentAtom: Atom = {
      schema_version: 1,
      id: 'intent-alice-2026-04-24' as AtomId,
      content: 'authorize the autonomous run',
      type: 'operator-intent',
      layer: 'L1',
      provenance: {
        kind: 'operator-seeded',
        source: { agent_id: 'alice-operator' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: '2026-04-24T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-24T00:00:00.000Z' as Time,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'alice-operator' as PrincipalId,
      taint: 'clean',
      metadata: {},
    };
    await host.atoms.put(intentAtom);

    const plan = planAtom('p-intent-derived', {
      delegation: {
        sub_actor_principal_id: 'ghost-actor',
        reason: 'will fail; we want to see the escalation',
        implied_blast_radius: 'tooling',
      },
    });
    // Cite the intent on the plan provenance so deriveEscalateTo can
    // walk it.
    const planWithIntent: Atom = {
      ...plan,
      provenance: {
        ...plan.provenance,
        derived_from: ['intent-alice-2026-04-24' as AtomId],
      },
    };
    await host.atoms.put(planWithIntent);

    const result = await runDispatchTick(host, registry);
    expect(result.failed).toBe(1);

    // The escalation actor-message should be addressed to the intent
    // principal, not the plan author (cto-actor).
    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const escalation = replies.atoms.find(
      (a) => (a.metadata as { actor_message?: { correlation_id?: string } })?.actor_message?.correlation_id === 'dispatch-p-intent-derived',
    );
    expect(escalation).toBeDefined();
    const msg = (escalation!.metadata as { actor_message: { to: string } }).actor_message;
    expect(msg.to).toBe('alice-operator');
  });

  it('escalate_to falls back to plan.principal_id when no intent is in provenance', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('ghost-actor' as PrincipalId, async (): Promise<InvokeResult> => {
      throw new Error('intentional dispatch failure');
    });

    // Plan derived from a non-intent atom: deriveEscalateTo skips
    // it and falls back to the plan's principal_id (cto-actor in
    // planAtom).
    const plan = planAtom('p-no-intent', {
      delegation: {
        sub_actor_principal_id: 'ghost-actor',
        reason: 'will fail',
        implied_blast_radius: 'tooling',
      },
    });
    const dirAtom: Atom = {
      schema_version: 1,
      id: 'inv-test' as AtomId,
      content: 'directive',
      type: 'directive',
      layer: 'L3',
      provenance: { kind: 'operator-seeded', source: {}, derived_from: [] },
      confidence: 1.0,
      created_at: '2026-04-24T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-24T00:00:00.000Z' as Time,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'operator' as PrincipalId,
      taint: 'clean',
      metadata: {},
    };
    await host.atoms.put(dirAtom);
    const planWithDir: Atom = {
      ...plan,
      provenance: {
        ...plan.provenance,
        derived_from: ['inv-test' as AtomId],
      },
    };
    await host.atoms.put(planWithDir);

    const result = await runDispatchTick(host, registry);
    expect(result.failed).toBe(1);

    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const escalation = replies.atoms.find(
      (a) => (a.metadata as { actor_message?: { correlation_id?: string } })?.actor_message?.correlation_id === 'dispatch-p-no-intent',
    );
    expect(escalation).toBeDefined();
    const msg = (escalation!.metadata as { actor_message: { to: string } }).actor_message;
    // Fallback: plan author (cto-actor in planAtom helper).
    expect(msg.to).toBe('cto-actor');
  });

  it('explicit envelope fields take precedence over the defaults', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    let receivedCorrId: string | undefined;
    let receivedPayload: unknown;
    registry.register('code-author' as PrincipalId, async (payload, corr): Promise<InvokeResult> => {
      receivedCorrId = corr;
      receivedPayload = payload;
      // Throw so the dispatcher writes an escalation actor-message;
      // that lets us pin escalate_to precedence in the same case
      // without doubling the test surface.
      throw new Error('force escalation so we can observe escalate_to');
    });

    // A descriptor that overrides every default. The dispatcher must
    // honor the explicit values; future consumers that want non-
    // default routing rely on this.
    await host.atoms.put(planAtom('p-explicit', {
      delegation: {
        sub_actor_principal_id: 'code-author',
        reason: 'standard',
        implied_blast_radius: 'tooling',
        correlation_id: 'caller-defined-corr',
        escalate_to: 'sre-rotation',
        payload: { custom: 'shape' },
      },
    }));

    await runDispatchTick(host, registry);
    expect(receivedCorrId).toBe('caller-defined-corr');
    expect(receivedPayload).toEqual({ custom: 'shape' });
    // escalate_to precedence: the explicit 'sre-rotation' must route
    // the dispatch-failed actor-message there, not to the plan
    // principal (cto-actor) the deriveEscalateTo fallback would pick.
    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const escalation = replies.atoms.find(
      (a) => (a.metadata as { actor_message?: { correlation_id?: string } })?.actor_message?.correlation_id === 'caller-defined-corr',
    );
    expect(escalation).toBeDefined();
    const msg = (escalation!.metadata as { actor_message: { to: string } }).actor_message;
    expect(msg.to).toBe('sre-rotation');
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
