/**
 * Drift tests for scripts/bootstrap-claim-contract-canon.mjs.
 *
 * The POLICIES array (built via buildPolicies) seeds the 11 L3 directive
 * atoms that the claim-contract substrate reads at runtime:
 *
 *   - 3 budget-tier atoms (kind='claim-budget-tier', tier=default|raised|max)
 *     consumed by resolveBudgetTier in
 *     src/substrate/policy/claim-budget-tier.ts.
 *   - 8 numeric-config atoms (one per kind) consumed by the named readers
 *     in src/substrate/policy/claim-reaper-config.ts.
 *
 * Keeping seed and runtime fallback in sync is load-bearing: a deployment
 * that never runs the bootstrap gets nothing from the resolver (every
 * reader fails-closed with `missing-canon-policy`). The drift tests below
 * assert the seed shape is exactly what the readers expect.
 *
 * The bootstrap script idempotency is verified via the same drift-check
 * the script itself uses: running buildPolicies + policyAtom twice and
 * comparing the second pass to the first pass returns zero drift. The
 * "second run is a no-op" property is therefore a function-purity property,
 * not a filesystem property, and is testable without spawning Node.
 *
 * Covers:
 *   - buildPolicies returns the expected stable set of 11 ids.
 *   - The 3 budget-tier atoms carry the right tier + max_budget_usd values.
 *   - The 8 numeric atoms carry the right kind + value pairs.
 *   - policyAtom() shape is a well-formed L3 directive with
 *     metadata.policy.kind on every atom (so the readers' kind-based
 *     resolution succeeds).
 *   - Running buildPolicies twice with the same operator id returns
 *     structurally identical specs (idempotency proxy).
 */

import { describe, expect, it } from 'vitest';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/claim-contract-canon-policies.mjs';

const OP = 'test-operator';

interface PolicySpec {
  id: string;
  kind: string;
  fields: Record<string, unknown>;
}

describe('bootstrap-claim-contract-canon POLICIES', () => {
  it('returns the expected stable set of 11 policy ids', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    const ids = policies.map((p) => p.id).sort();
    expect(ids).toEqual([
      'pol-claim-attesting-grace-ms',
      'pol-claim-budget-tier-default',
      'pol-claim-budget-tier-max',
      'pol-claim-budget-tier-raised',
      'pol-claim-pending-grace-ms',
      'pol-claim-reaper-cadence-ms',
      'pol-claim-recovery-deadline-extension-ms',
      'pol-claim-recovery-max-attempts',
      'pol-claim-session-post-finalize-grace-ms',
      'pol-claim-verifier-failure-cap',
      'pol-claim-verifier-timeout-ms',
    ]);
  });

  it('3 budget-tier atoms carry kind=claim-budget-tier + correct tier + max_budget_usd', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    const tierSpecs: Array<[string, string, number]> = [
      ['pol-claim-budget-tier-default', 'default', 2.0],
      ['pol-claim-budget-tier-raised', 'raised', 5.0],
      ['pol-claim-budget-tier-max', 'max', 10.0],
    ];
    for (const [id, tier, maxUsd] of tierSpecs) {
      const spec = policies.find((p) => p.id === id);
      expect(spec, `${id} should be present in buildPolicies output`).toBeDefined();
      expect(spec!.kind).toBe('claim-budget-tier');
      expect(spec!.fields['tier']).toBe(tier);
      expect(spec!.fields['max_budget_usd']).toBe(maxUsd);
    }
  });

  it('8 numeric-config atoms carry kind + value matching the readers', () => {
    // (id, kind, expected value) tuples; mirrors the table in
    // test/substrate/policy/claim-reaper-config.test.ts so a kind-typo
    // would fail both this test and the reader test.
    const numericSpecs: Array<[string, string, number]> = [
      ['pol-claim-reaper-cadence-ms', 'claim-reaper-cadence-ms', 60_000],
      ['pol-claim-recovery-max-attempts', 'claim-recovery-max-attempts', 3],
      ['pol-claim-recovery-deadline-extension-ms', 'claim-recovery-deadline-extension-ms', 1_800_000],
      ['pol-claim-attesting-grace-ms', 'claim-attesting-grace-ms', 300_000],
      ['pol-claim-pending-grace-ms', 'claim-pending-grace-ms', 60_000],
      ['pol-claim-verifier-timeout-ms', 'claim-verifier-timeout-ms', 30_000],
      ['pol-claim-verifier-failure-cap', 'claim-verifier-failure-cap', 3],
      ['pol-claim-session-post-finalize-grace-ms', 'claim-session-post-finalize-grace-ms', 30_000],
    ];
    const policies = buildPolicies(OP) as PolicySpec[];
    for (const [id, kind, value] of numericSpecs) {
      const spec = policies.find((p) => p.id === id);
      expect(spec, `${id} should be present in buildPolicies output`).toBeDefined();
      expect(spec!.kind).toBe(kind);
      expect(spec!.fields['value']).toBe(value);
    }
  });

  it('policyAtom shape is a well-formed L3 directive carrying metadata.policy.kind', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    // Pick the budget-tier-default atom as a representative case.
    const spec = policies.find((p) => p.id === 'pol-claim-budget-tier-default')!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-claim-budget-tier-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.expires_at).toBeNull();
    expect(atom.provenance.kind).toBe('operator-seeded');
    const meta = atom.metadata as {
      policy: { kind: string; tier?: string; max_budget_usd?: number; value?: number };
    };
    // Critical: every claim-contract policy atom MUST carry kind on
    // metadata.policy so the readers (which match by kind, not by id)
    // can resolve them.
    expect(meta.policy.kind).toBe('claim-budget-tier');
    expect(meta.policy.tier).toBe('default');
    expect(meta.policy.max_budget_usd).toBe(2.0);
  });

  it('every numeric-config atom carries metadata.policy.kind + numeric value', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    const numericIds = [
      'pol-claim-reaper-cadence-ms',
      'pol-claim-recovery-max-attempts',
      'pol-claim-recovery-deadline-extension-ms',
      'pol-claim-attesting-grace-ms',
      'pol-claim-pending-grace-ms',
      'pol-claim-verifier-timeout-ms',
      'pol-claim-verifier-failure-cap',
      'pol-claim-session-post-finalize-grace-ms',
    ];
    for (const id of numericIds) {
      const spec = policies.find((p) => p.id === id)!;
      const atom = policyAtom(spec, OP);
      const meta = atom.metadata as { policy: { kind: string; value: number } };
      expect(meta.policy.kind, `${id} must carry metadata.policy.kind`).toBe(spec.kind);
      expect(typeof meta.policy.value).toBe('number');
      expect(meta.policy.value).toBeGreaterThan(0);
      expect(Number.isFinite(meta.policy.value)).toBe(true);
    }
  });

  it('buildPolicies is pure: two calls with the same operator return structurally identical specs (idempotency proxy)', () => {
    // Idempotency at the script level reduces to function purity at
    // the lib level: running the seed twice cannot diverge because
    // buildPolicies is a pure function of (operatorId). A failing
    // version of this assertion would surface a smuggled-in
    // non-determinism (Date.now in field values, shared mutable
    // closure, etc.) that the bootstrap drift-check could not
    // distinguish from a real edit.
    const first = JSON.stringify(buildPolicies(OP));
    const second = JSON.stringify(buildPolicies(OP));
    expect(second).toBe(first);
  });

  it('policyAtom is pure: two calls with the same spec + operator return structurally identical atoms', () => {
    // Same purity guard at the atom-builder layer. The bootstrap
    // script's drift check compares stored vs expected via a
    // deep-equality diff; purity here means the second-run diff is
    // empty by construction.
    const policies = buildPolicies(OP) as PolicySpec[];
    for (const spec of policies) {
      const first = JSON.stringify(policyAtom(spec, OP));
      const second = JSON.stringify(policyAtom(spec, OP));
      expect(second, `policyAtom(${spec.id}) must be deterministic`).toBe(first);
    }
  });
});
