import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { resolveBudgetTier } from '../../../src/substrate/policy/claim-budget-tier.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-05-11T00:00:00.000Z' as Time;

function mkBudgetTierAtom(
  id: string,
  tier: string,
  maxUsd: number,
  options: { taint?: 'clean' | 'tainted'; superseded?: boolean; type?: string; provenanceKind?: string } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `budget-tier ${tier}`,
    // Canonical seed shape: type='directive' + provenance.kind='operator-seeded'.
    // The resolver enforces both as a forgery-containment gate; tests must
    // mirror the bootstrap's emitted shape so production behavior is exercised.
    type: (options.type ?? 'directive') as Atom['type'],
    layer: 'L3',
    provenance: { kind: (options.provenanceKind ?? 'operator-seeded') as Atom['provenance']['kind'], source: { agent_id: 'operator' }, derived_from: [] },
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

  it('skips non-directive atoms (preference / decision shapes do not satisfy the seed gate)', async () => {
    const host = createMemoryHost();
    // A preference-typed atom carrying the same metadata.policy.kind + tier
    // values MUST NOT be accepted as a budget-tier policy. The resolver
    // gates on type='directive' so a non-directive shape (preference,
    // decision, observation) cannot mint a budget ceiling.
    await host.atoms.put(
      mkBudgetTierAtom('pol-budget-tier-pref-shape', 'default', 999.0, { type: 'preference' }),
    );
    await expect(resolveBudgetTier('default', host)).rejects.toThrow(/unknown-budget-tier/);
  });

  it('skips non-operator-seeded atoms (agent-inferred provenance does not satisfy the seed gate)', async () => {
    const host = createMemoryHost();
    // An agent-inferred atom that happens to carry the canonical
    // metadata.policy.kind + tier shape MUST NOT be accepted; the
    // resolver gates on provenance.kind='operator-seeded' so a sub-agent
    // cannot inject a budget ceiling at runtime.
    await host.atoms.put(
      mkBudgetTierAtom('pol-budget-tier-agent-inferred', 'default', 999.0, { provenanceKind: 'agent-inferred' }),
    );
    await expect(resolveBudgetTier('default', host)).rejects.toThrow(/unknown-budget-tier/);
  });
});
