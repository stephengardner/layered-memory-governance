import { describe, expect, it } from 'vitest';
import { buildPlanAtom } from '../../../../src/runtime/actors/planning/planning-actor.js';

describe('buildPlanAtom (planning-actor)', () => {
  const baseDraft = {
    title: 'Fix',
    body: '...',
    derived_from: ['canon-id-1'],
    principles_applied: [],
    alternatives_rejected: [],
    what_breaks_if_revisit: '...',
    confidence: 0.8,
    delegation: {
      sub_actor_principal_id: 'code-author' as const,
      reason: 'Touches src/',
      implied_blast_radius: 'framework' as const,
    },
  };

  it('writes delegation into plan.metadata.delegation', () => {
    const atom = buildPlanAtom({
      draft: baseDraft,
      principalId: 'cto-actor',
      intentId: null,
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc',
    });
    expect(atom.metadata.delegation).toEqual(baseDraft.delegation);
  });

  it('appends intent id to provenance.derived_from when provided', () => {
    const atom = buildPlanAtom({
      draft: baseDraft,
      principalId: 'cto-actor',
      intentId: 'intent-xyz-2026-04-24T12-00-00-000Z',
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc',
    });
    expect(atom.provenance.derived_from).toContain('intent-xyz-2026-04-24T12-00-00-000Z');
    expect(atom.provenance.derived_from).toContain('canon-id-1');
  });

  it('does not add intent id when intentId is null', () => {
    const atom = buildPlanAtom({
      draft: baseDraft,
      principalId: 'cto-actor',
      intentId: null,
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc',
    });
    expect(atom.provenance.derived_from.every((id: string) => !id.startsWith('intent-'))).toBe(true);
  });
});
