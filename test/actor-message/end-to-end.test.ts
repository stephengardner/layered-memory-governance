/**
 * End-to-end integration test for the inbox V1 sequence.
 *
 * This test exercises the full autonomous-path loop wired together
 * from the six primitives landed in PRs A-F:
 *
 *   operator writes actor-message ('audit project X')
 *     -> ActorMessageRateLimiter.checkWrite allows it (PR A)
 *     -> listUnread surfaces it for the 'cto-actor' inbox (PR B)
 *     -> pickNextMessage picks + acks it (PR B/D)
 *     -> test fixture produces a Plan atom with delegation envelope
 *        pointing at 'auditor-actor' (stands in for the PlanningActor
 *        + judgment step we already ship in other PRs)
 *     -> runAutoApprovePass moves Plan from proposed -> approved (PR F)
 *     -> runDispatchTick invokes the registered auditor (PR E)
 *     -> AuditorActor emits a finding observation + reply actor-message
 *     -> listUnread surfaces the reply for the 'operator' inbox
 *
 * The assertion at the end walks the full chain:
 *   - original message was picked exactly once (ack atom present)
 *   - plan transitioned proposed -> approved -> succeeded
 *   - observation atom exists with the correlation id
 *   - reply message addressed to operator carries correlation_id
 *
 * This is the test that proves the autonomous flow described in the
 * CTO's v2 plan works end-to-end against the memory Host. When a
 * Postgres Host ships, this same test runs against it via the 50-
 * actor load-test harness; the shape of the assertion doesn't change.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  ActorMessageRateLimiter,
  type ActorMessageV1,
  type AuditorPayload,
  type InvokeResult,
  pickNextMessage,
  runAuditor,
  runAutoApprovePass,
  runDispatchTick,
  SubActorRegistry,
} from '../../src/actor-message/index.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';

const NOW = '2026-04-20T12:00:00.000Z' as Time;
const OPERATOR = 'operator' as PrincipalId;
const CTO = 'cto-actor' as PrincipalId;
const AUDITOR = 'auditor-actor' as PrincipalId;

function policyAtom(id: string, payload: Record<string, unknown>, principalId = 'operator'): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `policy: ${payload.subject}`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test-bootstrap', agent_id: 'test' },
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
    principal_id: principalId as PrincipalId,
    taint: 'clean',
    metadata: { policy: payload },
  };
}

async function seedInboxCanon(host: ReturnType<typeof createMemoryHost>) {
  // Matches what scripts/bootstrap-inbox-canon.mjs seeds at runtime.
  // We seed only the atoms the test path actually reads.
  await host.atoms.put(policyAtom('pol-actor-message-rate', {
    subject: 'actor-message-rate',
    principal: '*',
    tokens_per_minute: 60,  // permissive for the test's synthetic writes
    burst_capacity: 100,
  }));
  await host.atoms.put(policyAtom('pol-actor-message-circuit-breaker', {
    subject: 'actor-message-circuit-breaker',
    denial_count_trip_threshold: 3,
    window_ms: 300_000,
    automatic_reset_after_ms: null,
  }));
  await host.atoms.put(policyAtom('pol-plan-auto-approve-low-stakes', {
    subject: 'plan-auto-approve-low-stakes',
    allowed_sub_actors: ['auditor-actor'],
    min_confidence: 0.5,
  }));
}

function operatorMessageAtom(id: string, body: string): Atom {
  const envelope: ActorMessageV1 = {
    to: CTO,
    from: OPERATOR,
    topic: 'audit-request',
    urgency_tier: 'normal',
    body,
    correlation_id: `corr-${id}`,
  };
  return {
    schema_version: 1,
    id: id as AtomId,
    content: body,
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: 'operator', tool: 'test-harness' },
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
    principal_id: OPERATOR,
    taint: 'clean',
    metadata: { actor_message: envelope },
  };
}

/**
 * Tiny stand-in for the PlanningActor step: given a picked inbox
 * message, writes a plan atom with a delegation envelope targeting
 * the auditor. In production this is runActor(PlanningActor, ...)
 * with an LLM-backed judgment; the integration test focuses on the
 * downstream inbox/dispatch loop shape, not on the CTO planner's
 * behavior (which has its own test suite).
 */
async function producePlanFromMessage(
  host: ReturnType<typeof createMemoryHost>,
  messageAtom: Atom,
): Promise<AtomId> {
  const envelope = messageAtom.metadata.actor_message as ActorMessageV1;
  const planId = `plan-${String(messageAtom.id)}` as AtomId;
  const plan: Atom = {
    schema_version: 1,
    id: planId,
    content: `Audit plan derived from ${String(messageAtom.id)}`,
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'cto-actor', tool: 'planning-actor', session_id: envelope.correlation_id },
      derived_from: [messageAtom.id],
    },
    confidence: 0.9,
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
    principal_id: CTO,
    taint: 'clean',
    plan_state: 'proposed',
    metadata: {
      planning_actor_version: '0.1.0',
      title: 'Audit the project',
      delegation: {
        sub_actor_principal_id: 'auditor-actor',
        payload: { reply_to: OPERATOR } satisfies AuditorPayload,
        correlation_id: envelope.correlation_id,
        escalate_to: OPERATOR,
      },
    },
  };
  await host.atoms.put(plan);
  return planId;
}

describe('inbox V1 end-to-end autonomous flow', () => {
  it('operator ping -> CTO pickup -> auto-approve -> dispatch -> auditor reply', async () => {
    const host = createMemoryHost();
    await seedInboxCanon(host);

    // Step 0: operator writes a message. ActorMessageRateLimiter's
    // checkWrite would gate this in production; we verify it runs
    // without denial, then write directly.
    const limiter = new ActorMessageRateLimiter(host, { policyCacheMs: 0 });
    await limiter.checkWrite(OPERATOR);
    const requestAtom = operatorMessageAtom('req-1', 'Please audit the project scope.');
    await host.atoms.put(requestAtom);

    // Step 1: CTO picks the message up.
    const pick = await pickNextMessage(host, CTO);
    expect(pick.kind).toBe('picked');
    if (pick.kind !== 'picked') return;
    expect(String(pick.message.atom.id)).toBe('req-1');

    // Step 2: PlanningActor stand-in produces an approved-shape plan
    // atom with a delegation envelope. (In production the Planning
    // Actor's draft step lands here.)
    const planId = await producePlanFromMessage(host, pick.message.atom);

    // Step 3: auto-approve pass transitions proposed -> approved.
    const autoResult = await runAutoApprovePass(host);
    expect(autoResult.approved).toBe(1);

    // Step 4: wire the auditor into the registry and dispatch.
    const registry = new SubActorRegistry();
    registry.register(AUDITOR, async (payload, correlationId): Promise<InvokeResult> => {
      return await runAuditor(host, payload as AuditorPayload, correlationId);
    });
    const dispatch = await runDispatchTick(host, registry);
    expect(dispatch).toEqual({ scanned: 1, dispatched: 1, failed: 0 });

    // Step 5: verify the full chain.
    const finalPlan = await host.atoms.get(planId);
    expect(finalPlan!.plan_state).toBe('succeeded');

    const obs = await host.atoms.query({ type: ['observation'] }, 100);
    const auditObs = obs.atoms.find(
      (a) => a.metadata?.audit?.correlation_id === `corr-req-1`,
    );
    expect(auditObs).toBeDefined();

    const inboxForOp = await host.atoms.query({ type: ['actor-message'] }, 100);
    const replyToOp = inboxForOp.atoms.find(
      (a) =>
        a.metadata?.actor_message?.to === 'operator'
        && a.metadata?.actor_message?.correlation_id === `corr-req-1`,
    );
    expect(replyToOp).toBeDefined();
    expect(replyToOp!.metadata.actor_message.from).toBe('auditor-actor');
    expect(replyToOp!.metadata.actor_message.topic).toBe('audit-report');

    // Ack atom for the original request exists (pickup's at-most-once).
    const acks = await host.atoms.query({ type: ['actor-message-ack'] }, 100);
    const ack = acks.atoms.find((a) =>
      a.provenance.derived_from.some((id) => String(id) === 'req-1'),
    );
    expect(ack).toBeDefined();
    expect(ack!.principal_id).toBe(CTO);
  });

  it('operator ping against an unregistered sub-actor -> plan fails + escalation landed', async () => {
    // Negative-path: if the registered sub-actor list does not
    // include the delegation target, the dispatcher moves the plan
    // to 'failed' and writes an escalation message back to the
    // operator. This is the "the CTO asked for a thing we don't
    // know how to do" failure mode; the autonomous path must
    // surface it, not swallow it.
    const host = createMemoryHost();
    await seedInboxCanon(host);
    // Bypass auto-approve; we want the plan already approved so
    // dispatch runs against an unregistered target directly.
    const plan: Atom = {
      schema_version: 1,
      id: 'plan-ghost' as AtomId,
      content: 'Delegates to an unknown actor.',
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-inferred',
        source: { agent_id: 'cto-actor', tool: 'planning-actor' },
        derived_from: [],
      },
      confidence: 0.95,
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
      principal_id: CTO,
      taint: 'clean',
      plan_state: 'approved',
      metadata: {
        planning_actor_version: '0.1.0',
        delegation: {
          sub_actor_principal_id: 'ghost-actor',
          payload: {},
          correlation_id: 'corr-ghost',
          escalate_to: OPERATOR,
        },
      },
    };
    await host.atoms.put(plan);

    const registry = new SubActorRegistry();
    // auditor-actor registered, but NOT ghost-actor.
    registry.register(AUDITOR, async () => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: '',
    }));

    const dispatch = await runDispatchTick(host, registry);
    expect(dispatch).toEqual({ scanned: 1, dispatched: 0, failed: 1 });

    const finalPlan = await host.atoms.get('plan-ghost' as AtomId);
    expect(finalPlan!.plan_state).toBe('failed');

    const inbox = await host.atoms.query({ type: ['actor-message'] }, 100);
    const escalation = inbox.atoms.find(
      (a) => a.metadata?.actor_message?.correlation_id === 'corr-ghost',
    );
    expect(escalation).toBeDefined();
    expect(escalation!.metadata.actor_message.to).toBe('operator');
    expect(escalation!.metadata.actor_message.topic).toBe('dispatch-failed');
    expect(escalation!.metadata.actor_message.body).toContain('ghost-actor');
  });
});
