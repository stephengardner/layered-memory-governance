/**
 * Tests for the ordering-policy read path.
 *
 * Covers:
 *   - Missing atom -> DEFAULT_ORDERING_POLICY
 *   - Malformed atom (non-numeric threshold) -> DEFAULT
 *   - Valid custom atom -> parsed config
 *   - Tainted atom ignored (falls back to default)
 *   - Superseded atom ignored (falls back to default)
 *   - pickNextMessage respects canon-configured urgency weights
 *     (reversed priority test: a "high" message loses to a "soft"
 *     message when weights are inverted)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  DEFAULT_ORDERING_POLICY,
  readOrderingPolicy,
} from '../../src/actor-message/ordering-policy.js';
import { pickNextMessage } from '../../src/actor-message/pickup.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import type { ActorMessageV1, UrgencyTier } from '../../src/actor-message/types.js';

function orderingAtom(overrides: {
  threshold?: number | string;
  urgency_weights?: Record<string, number>;
  tainted?: boolean;
  superseded?: boolean;
}): Atom {
  const now = '2026-04-20T00:00:00.000Z' as Time;
  return {
    schema_version: 1,
    id: 'pol-inbox-ordering' as AtomId,
    content: 'inbox ordering config',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test-bootstrap', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
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
    principal_id: 'operator' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    metadata: {
      policy: {
        subject: 'inbox-ordering',
        deadline_imminent_threshold_ms: overrides.threshold ?? 60_000,
        urgency_weights: overrides.urgency_weights ?? { high: 0, normal: 1, soft: 2 },
      },
    },
  };
}

function messageAtom(
  id: string,
  urgency: UrgencyTier,
  createdAt: Time,
): Atom {
  const envelope: ActorMessageV1 = {
    to: 'alice' as PrincipalId,
    from: 'bob' as PrincipalId,
    topic: 't',
    urgency_tier: urgency,
    body: 'b',
  };
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'b',
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'bob', tool: 'test-harness' },
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
    principal_id: 'bob' as PrincipalId,
    taint: 'clean',
    metadata: { actor_message: envelope },
  };
}

describe('readOrderingPolicy', () => {
  it('returns DEFAULT_ORDERING_POLICY when no matching atom exists', async () => {
    const host = createMemoryHost();
    const cfg = await readOrderingPolicy(host);
    expect(cfg).toEqual(DEFAULT_ORDERING_POLICY);
  });

  it('parses a valid atom', async () => {
    const host = createMemoryHost();
    await host.atoms.put(orderingAtom({
      threshold: 120_000,
      urgency_weights: { high: 0, normal: 5, soft: 10 },
    }));
    const cfg = await readOrderingPolicy(host);
    expect(cfg.deadline_imminent_threshold_ms).toBe(120_000);
    expect(cfg.urgency_weights).toEqual({ high: 0, normal: 5, soft: 10 });
  });

  it('falls back to defaults on malformed threshold', async () => {
    const host = createMemoryHost();
    await host.atoms.put(orderingAtom({ threshold: 'not-a-number' }));
    const cfg = await readOrderingPolicy(host);
    expect(cfg.deadline_imminent_threshold_ms).toBe(DEFAULT_ORDERING_POLICY.deadline_imminent_threshold_ms);
  });

  it('ignores tainted atoms', async () => {
    const host = createMemoryHost();
    await host.atoms.put(orderingAtom({
      threshold: 999_999,
      urgency_weights: { high: 99, normal: 0, soft: 0 },
      tainted: true,
    }));
    const cfg = await readOrderingPolicy(host);
    expect(cfg).toEqual(DEFAULT_ORDERING_POLICY);
  });

  it('ignores superseded atoms', async () => {
    const host = createMemoryHost();
    await host.atoms.put(orderingAtom({
      threshold: 999_999,
      superseded: true,
    }));
    const cfg = await readOrderingPolicy(host);
    expect(cfg).toEqual(DEFAULT_ORDERING_POLICY);
  });
});

describe('pickNextMessage with canon-configured ordering', () => {
  it('respects inverted urgency weights from pol-inbox-ordering', async () => {
    // Canon says soft=0 (highest), high=10 (lowest). So a soft
    // message must win over a high one.
    const host = createMemoryHost();
    await host.atoms.put(orderingAtom({
      urgency_weights: { soft: 0, normal: 5, high: 10 },
    }));
    await host.atoms.put(messageAtom(
      'm-high', 'high', '2026-04-20T12:00:00.000Z' as Time,
    ));
    await host.atoms.put(messageAtom(
      'm-soft', 'soft', '2026-04-20T12:00:01.000Z' as Time,
    ));
    const outcome = await pickNextMessage(host, 'alice' as PrincipalId, {
      now: () => Date.parse('2026-04-20T13:00:00.000Z'),
    });
    expect(outcome.kind).toBe('picked');
    if (outcome.kind !== 'picked') return;
    expect(String(outcome.message.atom.id)).toBe('m-soft');
  });
});
