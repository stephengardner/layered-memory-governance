import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { resolveBudgetTier } from '../../../src/substrate/policy/claim-budget-tier.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-05-11T00:00:00.000Z' as Time;

function mkBudgetTierAtom(
  id: string,
  tier: string,
  maxUsd: number,
  options: { taint?: 'clean' | 'tainted'; superseded?: boolean } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `budget-tier ${tier}`,
    type: 'preference',
    layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'operator' }, derived_from: [] },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: options.superseded ? (['superseder' as AtomId]) : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'verified',
      last_validated_at: null,
    },
    principal_id: 'operator' as PrincipalId,
    taint: options.taint ?? 'clean',
    metadata: {
      policy: {
        kind: 'claim-budget-tier',
        tier,
        max_budget_usd: maxUsd,
      },
    },
  } as Atom;
}

describe('resolveBudgetTier', () => {
  it('resolves a known tier to its canon-policy max_budget_usd', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkBudgetTierAtom('pol-claim-budget-tier-default', 'default', 2.0));
    const usd = await resolveBudgetTier('default', host);
    expect(usd).toBe(2.0);
  });

  it('throws unknown-budget-tier when no matching policy exists', async () => {
    const host = createMemoryHost();
    await expect(resolveBudgetTier('nonexistent', host)).rejects.toThrow(/unknown-budget-tier/);
  });

  it('honors a custom org-ceiling tier via canon-policy add', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkBudgetTierAtom('pol-claim-budget-tier-emergency', 'emergency', 100.0));
    const usd = await resolveBudgetTier('emergency', host);
    expect(usd).toBe(100.0);
  });
});
