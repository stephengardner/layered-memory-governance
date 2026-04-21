/**
 * InboxReader tests.
 *
 * Pure-query semantics: listUnread returns actor-message atoms
 * addressed to a principal, filtering out already-acked messages.
 * emitAck is idempotent (re-emission returns the same ack id).
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { emitAck, listUnread } from '../../src/actor-message/inbox-reader.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import type {
  ActorMessageV1,
  UrgencyTier,
} from '../../src/actor-message/types.js';

function messageAtom(
  id: string,
  to: string,
  from: string,
  overrides: Partial<ActorMessageV1> & { createdAt?: Time } = {},
): Atom {
  const createdAt = overrides.createdAt ?? ('2026-04-20T00:00:00.000Z' as Time);
  const urgency: UrgencyTier = overrides.urgency_tier ?? 'normal';
  const envelope: ActorMessageV1 = {
    to: to as PrincipalId,
    from: from as PrincipalId,
    topic: overrides.topic ?? 'test',
    urgency_tier: urgency,
    body: overrides.body ?? 'body text',
    ...(overrides.deadline_ts !== undefined ? { deadline_ts: overrides.deadline_ts } : {}),
    ...(overrides.correlation_id !== undefined ? { correlation_id: overrides.correlation_id } : {}),
  };
  return {
    schema_version: 1,
    id: id as AtomId,
    content: envelope.body,
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: String(from), tool: 'test-harness' },
      derived_from: [],
    },
    confidence: 1,
    created_at: createdAt,
    last_reinforced_at: createdAt,
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
    principal_id: from as PrincipalId,
    taint: 'clean',
    metadata: { actor_message: envelope },
  };
}

describe('listUnread', () => {
  it('returns messages addressed to the given principal', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    await host.atoms.put(messageAtom('m2', 'alice', 'carol'));
    await host.atoms.put(messageAtom('m3', 'dan', 'bob'));

    const forAlice = await listUnread(host, 'alice' as PrincipalId);
    expect(forAlice.map((m) => String(m.atom.id)).sort()).toEqual(['m1', 'm2']);

    const forDan = await listUnread(host, 'dan' as PrincipalId);
    expect(forDan.map((m) => String(m.atom.id))).toEqual(['m3']);
  });

  it('excludes messages that already have an ack (idempotent reads)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    await host.atoms.put(messageAtom('m2', 'alice', 'bob'));

    const firstList = await listUnread(host, 'alice' as PrincipalId);
    expect(firstList.length).toBe(2);

    // Ack m1.
    await emitAck(host, firstList.find((m) => String(m.atom.id) === 'm1')!, 'alice' as PrincipalId);

    const secondList = await listUnread(host, 'alice' as PrincipalId);
    expect(secondList.length).toBe(1);
    expect(String(secondList[0]!.atom.id)).toBe('m2');
  });

  it('excludes superseded and tainted message atoms', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    await host.atoms.put(messageAtom('m2', 'alice', 'bob'));
    await host.atoms.update('m1' as AtomId, { superseded_by: ['revoked' as AtomId] });
    await host.atoms.update('m2' as AtomId, { taint: 'tainted' });

    const list = await listUnread(host, 'alice' as PrincipalId);
    expect(list.length).toBe(0);
  });

  it('skips atoms without a valid envelope shape', async () => {
    const host = createMemoryHost();
    // Valid one.
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    // Invalid: missing `to` field.
    const bad = messageAtom('m2', 'alice', 'bob');
    await host.atoms.put({
      ...bad,
      metadata: { actor_message: { from: 'bob', topic: 't', body: 'b', urgency_tier: 'normal' } },
    });

    const list = await listUnread(host, 'alice' as PrincipalId);
    expect(list.map((m) => String(m.atom.id))).toEqual(['m1']);
  });
});

describe('emitAck', () => {
  it('writes a new ack atom with derived_from pointing at the message', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    const [msg] = await listUnread(host, 'alice' as PrincipalId);
    const ackId = await emitAck(host, msg!, 'alice' as PrincipalId);

    const ack = await host.atoms.get(ackId);
    expect(ack).not.toBeNull();
    expect(ack!.type).toBe('actor-message-ack');
    expect(ack!.provenance.derived_from).toContain('m1');
    expect(ack!.principal_id).toBe('alice');
  });

  it('is idempotent: re-emit returns the same ack id without writing a new atom', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    const [msg] = await listUnread(host, 'alice' as PrincipalId);

    const ack1 = await emitAck(host, msg!, 'alice' as PrincipalId);
    const ack2 = await emitAck(host, msg!, 'alice' as PrincipalId);
    expect(String(ack1)).toBe(String(ack2));

    const allAcks = await host.atoms.query({ type: ['actor-message-ack'] }, 100);
    expect(allAcks.atoms.length).toBe(1);
  });

  it('concurrent emitAck calls converge on a single ack atom (race guard)', async () => {
    // Regression guard for the CR-flagged race on #38: with a timestamp-
    // suffixed ack id two concurrent writers would both pass the initial
    // findExistingAck check and both write distinct ack atoms. The fix is
    // a deterministic ack id keyed on the message id; the second writer
    // hits ConflictError and returns the existing id.
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    const [msg] = await listUnread(host, 'alice' as PrincipalId);

    // Fire N acks concurrently. All should return the same id; the
    // store should have exactly one ack atom.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        emitAck(host, msg!, 'alice' as PrincipalId),
      ),
    );
    const unique = new Set(results.map(String));
    expect(unique.size).toBe(1);

    const allAcks = await host.atoms.query({ type: ['actor-message-ack'] }, 100);
    expect(allAcks.atoms.length).toBe(1);
  });
});
