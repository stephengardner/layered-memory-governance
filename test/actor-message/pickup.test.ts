/**
 * Pickup handler tests.
 *
 * Covers:
 *   - empty inbox -> 'empty' outcome, no atoms written
 *   - non-empty inbox -> 'picked' outcome with a message + ack atom
 *   - ordering default: deadline-imminent > urgency > arrival
 *   - kill-switch sentinel halts pickup without touching the store
 *   - custom orderingFn override wins over the default
 *   - at-most-once: second pickup returns a different message (the
 *     first was acked)
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { pickNextMessage } from '../../src/actor-message/pickup.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';
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
    topic: overrides.topic ?? 't',
    urgency_tier: urgency,
    body: overrides.body ?? 'b',
    ...(overrides.deadline_ts !== undefined ? { deadline_ts: overrides.deadline_ts } : {}),
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

describe('pickNextMessage', () => {
  it('returns "empty" when the inbox has no messages', async () => {
    const host = createMemoryHost();
    const outcome = await pickNextMessage(host, 'alice' as PrincipalId);
    expect(outcome.kind).toBe('empty');
  });

  it('returns "picked" with an ack atom on non-empty inbox', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));
    const outcome = await pickNextMessage(host, 'alice' as PrincipalId);
    expect(outcome.kind).toBe('picked');
    if (outcome.kind !== 'picked') return;
    expect(String(outcome.message.atom.id)).toBe('m1');

    // Ack was written.
    const ack = await host.atoms.get(outcome.ackAtomId as AtomId);
    expect(ack).not.toBeNull();
    expect(ack!.type).toBe('actor-message-ack');
  });

  it('second pickup returns a different message (at-most-once via ack)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      messageAtom('m1', 'alice', 'bob', { createdAt: '2026-04-20T00:00:00.000Z' as Time }),
    );
    await host.atoms.put(
      messageAtom('m2', 'alice', 'bob', { createdAt: '2026-04-20T00:00:01.000Z' as Time }),
    );

    const first = await pickNextMessage(host, 'alice' as PrincipalId);
    const second = await pickNextMessage(host, 'alice' as PrincipalId);
    expect(first.kind).toBe('picked');
    expect(second.kind).toBe('picked');
    if (first.kind !== 'picked' || second.kind !== 'picked') return;
    expect(String(first.message.atom.id)).not.toBe(String(second.message.atom.id));
  });

  it('default ordering: deadline-imminent beats higher urgency and older arrival', async () => {
    const host = createMemoryHost();
    const nowMs = Date.parse('2026-04-20T12:00:00.000Z');
    // Older high-urgency msg without deadline.
    await host.atoms.put(
      messageAtom('m-old-high', 'alice', 'bob', {
        urgency_tier: 'high',
        createdAt: '2026-04-20T11:00:00.000Z' as Time,
      }),
    );
    // Newer soft msg WITH imminent deadline (30s out).
    const imminent = new Date(nowMs + 30_000).toISOString() as Time;
    await host.atoms.put(
      messageAtom('m-new-soft-imminent', 'alice', 'bob', {
        urgency_tier: 'soft',
        createdAt: '2026-04-20T12:00:00.000Z' as Time,
        deadline_ts: imminent,
      }),
    );

    const outcome = await pickNextMessage(host, 'alice' as PrincipalId, {
      now: () => nowMs,
    });
    expect(outcome.kind).toBe('picked');
    if (outcome.kind !== 'picked') return;
    expect(String(outcome.message.atom.id)).toBe('m-new-soft-imminent');
  });

  it('within the same urgency tier, oldest arrival wins (FIFO)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      messageAtom('m-newer', 'alice', 'bob', {
        urgency_tier: 'normal',
        createdAt: '2026-04-20T12:00:01.000Z' as Time,
      }),
    );
    await host.atoms.put(
      messageAtom('m-older', 'alice', 'bob', {
        urgency_tier: 'normal',
        createdAt: '2026-04-20T12:00:00.000Z' as Time,
      }),
    );
    const outcome = await pickNextMessage(host, 'alice' as PrincipalId, {
      now: () => Date.parse('2026-04-20T13:00:00.000Z'),
    });
    expect(outcome.kind).toBe('picked');
    if (outcome.kind !== 'picked') return;
    expect(String(outcome.message.atom.id)).toBe('m-older');
  });

  it('kill-switch sentinel halts pickup without writing an ack', async () => {
    const host = createMemoryHost();
    await host.atoms.put(messageAtom('m1', 'alice', 'bob'));

    const tempDir = mkdtempSync(join(tmpdir(), 'lag-pickup-stop-'));
    const stopPath = join(tempDir, 'STOP');
    writeFileSync(stopPath, '');
    try {
      const outcome = await pickNextMessage(host, 'alice' as PrincipalId, {
        stopSentinelPath: stopPath,
      });
      expect(outcome.kind).toBe('kill-switch');

      // No ack should have been written.
      const acks = await host.atoms.query({ type: ['actor-message-ack'] }, 100);
      expect(acks.atoms.length).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('custom orderingFn overrides the default', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      messageAtom('m-older', 'alice', 'bob', {
        createdAt: '2026-04-20T12:00:00.000Z' as Time,
      }),
    );
    await host.atoms.put(
      messageAtom('m-newer', 'alice', 'bob', {
        createdAt: '2026-04-20T12:00:01.000Z' as Time,
      }),
    );
    // Reverse-FIFO ordering: newest first.
    const outcome = await pickNextMessage(host, 'alice' as PrincipalId, {
      orderingFn: (a, b) => b.atom.created_at.localeCompare(a.atom.created_at),
    });
    expect(outcome.kind).toBe('picked');
    if (outcome.kind !== 'picked') return;
    expect(String(outcome.message.atom.id)).toBe('m-newer');
  });
});
