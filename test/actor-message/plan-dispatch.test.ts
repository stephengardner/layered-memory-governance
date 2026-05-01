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

describe('runDispatchTick state-lifecycle metadata + audit emission', () => {
  it('stamps executing_at + executing_invoker on the approved -> executing claim and emits a plan.dispatch-executing audit event', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();

    // Block the invoker on a deferred resolver so we can inspect the
    // plan atom WHILE the sub-actor is mid-flight (i.e. plan_state ===
    // 'executing'). Without this gate the test could only observe the
    // terminal state.
    let resolveInvoker!: (value: InvokeResult) => void;
    const invokerGate = new Promise<InvokeResult>((resolve) => {
      resolveInvoker = resolve;
    });
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => invokerGate);

    await host.atoms.put(planAtom('p-exec-meta', {
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-exec',
        escalate_to: 'operator',
      },
    }));

    const tickPromise = runDispatchTick(host, registry, {
      now: () => Date.parse('2026-04-30T09:00:00.000Z'),
    });

    // Yield enough ticks for runDispatchTick to reach the invoker
    // await. The claim already landed before invoker is awaited.
    await new Promise((r) => setImmediate(r));

    const midFlight = await host.atoms.get('p-exec-meta' as AtomId);
    expect(midFlight!.plan_state).toBe('executing');
    expect(midFlight!.metadata.executing_at).toBe('2026-04-30T09:00:00.000Z');
    expect(midFlight!.metadata.executing_invoker).toBe('auditor-actor');
    // No terminal stamp yet because the invoker has not returned.
    expect(midFlight!.metadata.terminal_at).toBeUndefined();
    expect(midFlight!.metadata.terminal_kind).toBeUndefined();

    // Audit-log line for the executing transition is observable
    // independently of the invoker completing.
    const executingEvents = await host.auditor.query(
      { kind: ['plan.dispatch-executing'] },
      10,
    );
    expect(executingEvents.length).toBe(1);
    expect(executingEvents[0]!.refs.atom_ids).toContain('p-exec-meta');
    expect(executingEvents[0]!.details.sub_actor_principal_id).toBe('auditor-actor');
    expect(executingEvents[0]!.details.correlation_id).toBe('corr-exec');

    // Release the invoker so the test does not hang.
    resolveInvoker({ kind: 'completed', producedAtomIds: [], summary: 'ok' });
    await tickPromise;
  });

  it('stamps terminal_at + terminal_kind on the executing -> succeeded transition and emits a plan.dispatch-succeeded audit event', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('auditor-actor' as PrincipalId, async (_p, corr): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: [`out-${corr}`],
      summary: 'work done',
    }));

    await host.atoms.put(planAtom('p-success-meta', {
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-success',
        escalate_to: 'operator',
      },
    }));

    let nowCallCount = 0;
    // Inject distinct timestamps for the executing claim vs. the terminal
    // transition so the test can pin which stamp lands on which field.
    await runDispatchTick(host, registry, {
      now: () => {
        nowCallCount += 1;
        return nowCallCount === 1
          ? Date.parse('2026-04-30T10:00:00.000Z')
          : Date.parse('2026-04-30T10:00:05.000Z');
      },
    });

    const updated = await host.atoms.get('p-success-meta' as AtomId);
    expect(updated!.plan_state).toBe('succeeded');
    // Both stamps land on the final atom: the executing stamp
    // survives metadata-merge into the terminal write.
    expect(updated!.metadata.executing_at).toBe('2026-04-30T10:00:00.000Z');
    expect(updated!.metadata.executing_invoker).toBe('auditor-actor');
    expect(updated!.metadata.terminal_at).toBe('2026-04-30T10:00:05.000Z');
    expect(updated!.metadata.terminal_kind).toBe('succeeded');
    // dispatch_result preserved verbatim for back-compat consumers.
    const dr = updated!.metadata.dispatch_result as { kind: string; produced_atom_ids: string[] };
    expect(dr.kind).toBe('completed');
    expect(dr.produced_atom_ids).toEqual(['out-corr-success']);

    const successEvents = await host.auditor.query(
      { kind: ['plan.dispatch-succeeded'] },
      10,
    );
    expect(successEvents.length).toBe(1);
    expect(successEvents[0]!.refs.atom_ids).toContain('p-success-meta');
    expect(successEvents[0]!.details.summary).toBe('work done');
    expect(successEvents[0]!.details.produced_atom_ids).toEqual(['out-corr-success']);
  });

  it('stamps terminal_at + terminal_kind=failed + error_message on a failed dispatch and emits a plan.dispatch-failed audit event', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('breaks-actor' as PrincipalId, async (): Promise<InvokeResult> => {
      throw new Error('upstream service unreachable');
    });

    await host.atoms.put(planAtom('p-fail-meta', {
      delegation: {
        sub_actor_principal_id: 'breaks-actor',
        payload: {},
        correlation_id: 'corr-fail',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry, {
      now: () => Date.parse('2026-04-30T11:00:00.000Z'),
    });

    const updated = await host.atoms.get('p-fail-meta' as AtomId);
    expect(updated!.plan_state).toBe('failed');
    expect(updated!.metadata.terminal_at).toBe('2026-04-30T11:00:00.000Z');
    expect(updated!.metadata.terminal_kind).toBe('failed');
    expect(updated!.metadata.error_message).toBe('upstream service unreachable');
    // dispatch_result preserved verbatim for back-compat consumers.
    const dr = updated!.metadata.dispatch_result as { kind: string; message: string };
    expect(dr.kind).toBe('error');
    expect(dr.message).toBe('upstream service unreachable');

    const failedEvents = await host.auditor.query(
      { kind: ['plan.dispatch-failed'] },
      10,
    );
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]!.refs.atom_ids).toContain('p-fail-meta');
    expect(failedEvents[0]!.details.error_message).toBe('upstream service unreachable');
  });

  it('truncates a long error_message to bound the metadata + audit payload', async () => {
    // The error_message field must not propagate unbounded sub-actor
    // output (LLM transcripts, full stack traces) into the atom store
    // or audit log. The truncation marker lets a consumer detect that
    // the message was clipped.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    const longMessage = 'X'.repeat(5000);
    registry.register('breaks-actor' as PrincipalId, async (): Promise<InvokeResult> => {
      throw new Error(longMessage);
    });

    await host.atoms.put(planAtom('p-long-error', {
      delegation: {
        sub_actor_principal_id: 'breaks-actor',
        payload: {},
        correlation_id: 'corr-long',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry);
    const updated = await host.atoms.get('p-long-error' as AtomId);
    const errMsg = updated!.metadata.error_message as string;
    expect(errMsg.length).toBeLessThanOrEqual(1024);
    expect(errMsg.endsWith('...truncated')).toBe(true);
    // Original message preserved verbatim in dispatch_result for the
    // legacy back-compat shape; truncation only applies to the new
    // top-level error_message field that bounds dashboard payloads.
    const dr = updated!.metadata.dispatch_result as { message: string };
    expect(dr.message).toBe(longMessage);

    // The audit-event payload uses the SAME truncated errorMessage as
    // the atom metadata; without this assertion a regression that
    // passes result.message into emitDispatchAudit would slip through
    // (the metadata cap alone would still pass the suite).
    const failedEvents = await host.auditor.query(
      { kind: ['plan.dispatch-failed'] },
      10,
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.details.error_message).toBe(errMsg);

    // The escalation actor-message body must also use the truncated
    // form: the failed-dispatch path historically passed result.message
    // raw, which let an unbounded sub-actor error pollute the inbox.
    // Asserting on the inbox-rendered cousin closes the gap CR flagged
    // on this same PR.
    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const escalation = replies.atoms.find(
      (a) => (a.metadata as { actor_message?: { correlation_id?: string } })?.actor_message?.correlation_id === 'corr-long',
    );
    expect(escalation).toBeDefined();
    const body = (escalation!.metadata as { actor_message: { body: string } }).actor_message.body;
    // The escalation body wraps the error string with surrounding
    // template prose, so the bounded message + 'truncated' marker is
    // present rather than the raw repeated 'X' string.
    expect(body).toContain('...truncated');
    // Conservative upper-bound: the surrounding template adds a small
    // prefix + suffix; the body must not approach the 5000-char raw
    // length and the truncation marker is the load-bearing assertion.
    expect(body.length).toBeLessThan(2048);
  });

  it('emits a plan.dispatch-in-flight audit event when invoker returns dispatched (async)', async () => {
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('async-actor' as PrincipalId, async (): Promise<InvokeResult> => ({
      kind: 'dispatched',
      summary: 'queued for later',
    }));

    await host.atoms.put(planAtom('p-async', {
      delegation: {
        sub_actor_principal_id: 'async-actor',
        payload: {},
        correlation_id: 'corr-async',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry);

    const updated = await host.atoms.get('p-async' as AtomId);
    expect(updated!.plan_state).toBe('executing');
    // No terminal stamp because the plan stays executing.
    expect(updated!.metadata.terminal_at).toBeUndefined();
    expect(updated!.metadata.terminal_kind).toBeUndefined();

    // Two audit events fire on this dispatch path: the executing
    // claim AND the in-flight hand-off. Both are observable so the
    // operator can distinguish "claim landed" from "sub-actor accepted
    // the work asynchronously".
    const executingEvents = await host.auditor.query(
      { kind: ['plan.dispatch-executing'] },
      10,
    );
    expect(executingEvents.length).toBe(1);
    const inFlightEvents = await host.auditor.query(
      { kind: ['plan.dispatch-in-flight'] },
      10,
    );
    expect(inFlightEvents.length).toBe(1);
    expect(inFlightEvents[0]!.refs.atom_ids).toContain('p-async');
    expect(inFlightEvents[0]!.details.summary).toBe('queued for later');
  });

  it('emits exactly one audit event per terminal transition (no duplicate emission on rerun of an already-terminal plan)', async () => {
    // Regression guard against the failure mode where a stuck
    // dispatcher loop emits one audit event per tick instead of one
    // per transition. Once the plan reaches 'succeeded' the candidate
    // filter drops it; a second tick must produce zero new audit
    // events.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: 'ok',
    }));

    await host.atoms.put(planAtom('p-once', {
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-once',
        escalate_to: 'operator',
      },
    }));

    await runDispatchTick(host, registry);
    await runDispatchTick(host, registry); // second tick should no-op

    const successEvents = await host.auditor.query(
      { kind: ['plan.dispatch-succeeded'] },
      50,
    );
    expect(successEvents.length).toBe(1);
    const executingEvents = await host.auditor.query(
      { kind: ['plan.dispatch-executing'] },
      50,
    );
    expect(executingEvents.length).toBe(1);
  });

  it('full lifecycle: proposed -> approved -> executing -> succeeded with metadata stamps + audit chain at each step', async () => {
    // End-to-end regression for the full state-transition chain a
    // dogfeed run produces: an operator-intent + plan land in
    // 'proposed', the runtime auto-approves to 'approved', the
    // dispatcher claims to 'executing', the sub-actor returns and
    // the dispatcher transitions to 'succeeded'. Each transition
    // adds its own metadata stamps WITHOUT clobbering prior ones.
    const host = createMemoryHost();
    const registry = new SubActorRegistry();
    registry.register('auditor-actor' as PrincipalId, async (): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: ['out-1'],
      summary: 'lifecycle ok',
    }));

    // Plan starts in 'proposed' to mirror the dogfeed shape; we then
    // manually transition it to 'approved' with the prior stamps so
    // the dispatch tick can pick it up. The auto-approve transition
    // owns its own audit-log line in src/runtime/actor-message/
    // intent-approve.ts and is covered separately; here we focus on
    // the dispatch-side transitions.
    await host.atoms.put(planAtom('p-lifecycle', {
      plan_state: 'proposed',
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: {},
        correlation_id: 'corr-lifecycle',
        escalate_to: 'operator',
      },
    }));
    await host.atoms.update('p-lifecycle' as AtomId, {
      plan_state: 'approved',
      metadata: {
        approved_at: '2026-04-30T08:00:00.000Z',
        approved_via: 'pol-test',
      },
    });

    await runDispatchTick(host, registry);

    const final = await host.atoms.get('p-lifecycle' as AtomId);
    expect(final!.plan_state).toBe('succeeded');
    // All four lifecycle stamps survive the metadata-merge chain:
    // approved_* from the upstream auto-approve pass, executing_* from
    // the dispatcher's claim, terminal_* from the terminal write.
    expect(final!.metadata.approved_at).toBe('2026-04-30T08:00:00.000Z');
    expect(final!.metadata.approved_via).toBe('pol-test');
    expect(final!.metadata.executing_at).toBeDefined();
    expect(final!.metadata.executing_invoker).toBe('auditor-actor');
    expect(final!.metadata.terminal_at).toBeDefined();
    expect(final!.metadata.terminal_kind).toBe('succeeded');
  });
});
