import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  resolveAttestingGraceMs,
  resolvePendingGraceMs,
  resolveReaperCadenceMs,
  resolveRecoveryDeadlineExtensionMs,
  resolveRecoveryMaxAttempts,
  resolveSessionPostFinalizeGraceMs,
  resolveVerifierFailureCap,
  resolveVerifierTimeoutMs,
} from '../../../src/substrate/policy/claim-reaper-config.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-05-11T00:00:00.000Z' as Time;

function mkPolAtom(
  id: string,
  kind: string,
  value: number,
  options: { taint?: 'clean' | 'tainted'; superseded?: boolean; type?: string; provenanceKind?: string } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `${kind} = ${value}`,
    // Canonical seed shape: type='directive' + provenance.kind='operator-seeded'.
    // Mirrors the bootstrap policyAtom (scripts/lib/claim-contract-canon-policies.mjs)
    // so tests exercise the same forgery-containment gates the resolver enforces.
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
      policy: { kind, value },
    },
  } as Atom;
}

// The 8 reaper-config policies under test. Tuple shape: [id, kind, default value, reader].
const POLICIES: Array<[string, string, number, (host: ReturnType<typeof createMemoryHost>) => Promise<number>]> = [
  ['pol-claim-reaper-cadence-ms', 'claim-reaper-cadence-ms', 60_000, resolveReaperCadenceMs],
  ['pol-claim-recovery-max-attempts', 'claim-recovery-max-attempts', 3, resolveRecoveryMaxAttempts],
  ['pol-claim-recovery-deadline-extension-ms', 'claim-recovery-deadline-extension-ms', 1_800_000, resolveRecoveryDeadlineExtensionMs],
  ['pol-claim-attesting-grace-ms', 'claim-attesting-grace-ms', 300_000, resolveAttestingGraceMs],
  ['pol-claim-pending-grace-ms', 'claim-pending-grace-ms', 60_000, resolvePendingGraceMs],
  ['pol-claim-verifier-timeout-ms', 'claim-verifier-timeout-ms', 30_000, resolveVerifierTimeoutMs],
  ['pol-claim-verifier-failure-cap', 'claim-verifier-failure-cap', 3, resolveVerifierFailureCap],
  ['pol-claim-session-post-finalize-grace-ms', 'claim-session-post-finalize-grace-ms', 30_000, resolveSessionPostFinalizeGraceMs],
];

describe('claim-reaper-config readers', () => {
  it('reads each of the 8 numeric policies by kind', async () => {
    const host = createMemoryHost();
    for (const [id, kind, value] of POLICIES) {
      await host.atoms.put(mkPolAtom(id, kind, value));
    }
    for (const [, , expected, reader] of POLICIES) {
      expect(await reader(host)).toBe(expected);
    }
  });

  it('throws missing-canon-policy when the policy atom is absent', async () => {
    const host = createMemoryHost();
    for (const [, , , reader] of POLICIES) {
      await expect(reader(host)).rejects.toThrow(/missing-canon-policy/);
    }
  });

  it('throws invalid-canon-policy when value is not a finite positive number', async () => {
    const host = createMemoryHost();
    // Non-number value.
    await host.atoms.put({
      ...mkPolAtom('pol-claim-reaper-cadence-ms', 'claim-reaper-cadence-ms', 60_000),
      metadata: { policy: { kind: 'claim-reaper-cadence-ms', value: 'sixty-thousand' } },
    } as Atom);
    await expect(resolveReaperCadenceMs(host)).rejects.toThrow(/invalid-canon-policy/);
  });

  it('throws invalid-canon-policy when value is NaN', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom('pol-claim-pending-grace-ms', 'claim-pending-grace-ms', NaN));
    await expect(resolvePendingGraceMs(host)).rejects.toThrow(/invalid-canon-policy/);
  });

  it('throws invalid-canon-policy when value is negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom('pol-claim-verifier-timeout-ms', 'claim-verifier-timeout-ms', -1));
    await expect(resolveVerifierTimeoutMs(host)).rejects.toThrow(/invalid-canon-policy/);
  });

  it('throws invalid-canon-policy when value is zero (must be positive)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom('pol-claim-verifier-failure-cap', 'claim-verifier-failure-cap', 0));
    await expect(resolveVerifierFailureCap(host)).rejects.toThrow(/invalid-canon-policy/);
  });

  it('throws invalid-canon-policy when value is Infinity', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom('pol-claim-attesting-grace-ms', 'claim-attesting-grace-ms', Number.POSITIVE_INFINITY));
    await expect(resolveAttestingGraceMs(host)).rejects.toThrow(/invalid-canon-policy/);
  });

  it('skips tainted policy atoms (fails missing when only tainted available)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom('pol-claim-reaper-cadence-ms', 'claim-reaper-cadence-ms', 60_000, { taint: 'tainted' }));
    await expect(resolveReaperCadenceMs(host)).rejects.toThrow(/missing-canon-policy/);
  });

  it('skips superseded policy atoms (fails missing when only superseded available)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom('pol-claim-pending-grace-ms', 'claim-pending-grace-ms', 60_000, { superseded: true }));
    await expect(resolvePendingGraceMs(host)).rejects.toThrow(/missing-canon-policy/);
  });

  it('skips non-directive atoms (preference / decision shapes do not satisfy the seed gate)', async () => {
    const host = createMemoryHost();
    // A preference-typed atom carrying the canonical metadata.policy.kind/value
    // pair MUST NOT be accepted as a reaper-config policy. The resolver gates
    // on type='directive'; non-directive shapes cannot widen reaper graces.
    await host.atoms.put(
      mkPolAtom('pol-pref-shape', 'claim-reaper-cadence-ms', 999, { type: 'preference' }),
    );
    await expect(resolveReaperCadenceMs(host)).rejects.toThrow(/missing-canon-policy/);
  });

  it('skips non-operator-seeded atoms (agent-inferred provenance does not satisfy the seed gate)', async () => {
    const host = createMemoryHost();
    // An agent-inferred atom that carries the canonical metadata.policy
    // shape MUST NOT be accepted; the resolver gates on
    // provenance.kind='operator-seeded' so a sub-agent cannot inject a
    // reaper-config override at runtime.
    await host.atoms.put(
      mkPolAtom('pol-agent-inferred', 'claim-reaper-cadence-ms', 999, { provenanceKind: 'agent-inferred' }),
    );
    await expect(resolveReaperCadenceMs(host)).rejects.toThrow(/missing-canon-policy/);
  });

  it('most-recent-wins when multiple clean unsuperseded atoms share the kind', async () => {
    const host = createMemoryHost();
    // Two clean atoms with the same kind, the second created later.
    await host.atoms.put({
      ...mkPolAtom('pol-claim-reaper-cadence-ms', 'claim-reaper-cadence-ms', 60_000),
      created_at: '2026-05-10T00:00:00.000Z' as Time,
    } as Atom);
    await host.atoms.put({
      ...mkPolAtom('pol-claim-reaper-cadence-ms-override', 'claim-reaper-cadence-ms', 30_000),
      created_at: '2026-05-12T00:00:00.000Z' as Time,
    } as Atom);
    expect(await resolveReaperCadenceMs(host)).toBe(30_000);
  });
});
