/**
 * Circuit-breaker-reset validator tests.
 *
 * Covers:
 *   - happy path: root signer, matching target, existing unsuperseded
 *     trip, non-empty reason -> pass; trip.superseded_by updated
 *   - non-root signer blocked by pol-circuit-breaker-reset-authority
 *     root-only v0 posture
 *   - max_signer_depth >= 1 allows a depth-1 signer
 *   - trip-not-found -> ShapeError
 *   - target mismatch -> ShapeError
 *   - already-superseded trip -> ShapeError (one-shot)
 *   - empty/tiny reset_reason -> ShapeError (governance-without-
 *     enforcement is decorative)
 *   - authorizing_principal != atom.principal_id -> ShapeError
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  ResetAuthorityError,
  ResetShapeError,
  validateResetWrite,
} from '../../src/actor-message/reset-validator.js';
import type { Atom, AtomId, Principal, PrincipalId, Time } from '../../src/substrate/types.js';
import type { CircuitBreakerResetV1 } from '../../src/actor-message/types.js';

const BOOTSTRAP_TIME = '2026-04-20T00:00:00.000Z' as Time;

interface AuthorityPolicyOptions {
  readonly authorized: ReadonlyArray<string>;
  readonly max_signer_depth?: number;
}

function authorityPolicyAtom(opts: AuthorityPolicyOptions): Atom {
  return {
    schema_version: 1,
    id: 'pol-circuit-breaker-reset-authority' as AtomId,
    content: 'reset authority',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test-bootstrap', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
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
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'circuit-breaker-reset-authority',
        authorized_principals: opts.authorized,
        max_signer_depth: opts.max_signer_depth ?? 0,
      },
    },
  };
}

function principal(
  id: string,
  signedBy: string | null = null,
): Principal {
  return {
    id: id as PrincipalId,
    name: id,
    role: 'test',
    permitted_scopes: { read: ['project'], write: ['project'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L0', 'L1'] },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: signedBy === null ? null : (signedBy as PrincipalId),
    created_at: BOOTSTRAP_TIME,
  };
}

function tripAtom(
  id: string,
  targetPrincipal: string,
  options: { superseded?: boolean } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `trip for ${targetPrincipal}`,
    type: 'circuit-breaker-trip',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'actor-message-rate-limiter' },
      derived_from: [],
    },
    confidence: 1,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
    expires_at: null,
    supersedes: [],
    superseded_by: options.superseded ? ['prev-reset' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'rate-limiter' as PrincipalId,
    taint: 'clean',
    metadata: {
      trip: {
        target_principal: targetPrincipal,
        reason: 'test',
        denial_count: 3,
        window_ms: 300000,
        tripped_at: BOOTSTRAP_TIME,
      },
    },
  };
}

function resetAtom(
  id: string,
  signer: string,
  envelope: Partial<CircuitBreakerResetV1>,
): Atom {
  const filled: CircuitBreakerResetV1 = {
    target_principal: (envelope.target_principal ?? 'victim') as PrincipalId,
    trip_atom_id: (envelope.trip_atom_id ?? 'trip-1') as AtomId,
    reset_reason: envelope.reset_reason ?? 'operator acknowledged runaway; redeployed fix',
    authorizing_principal: (envelope.authorizing_principal ?? signer) as PrincipalId,
  };
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `reset ${String(filled.trip_atom_id)} by ${signer}`,
    type: 'circuit-breaker-reset',
    layer: 'L1',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: signer, tool: 'lag-inbox-cli' },
      derived_from: [filled.trip_atom_id],
    },
    confidence: 1,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
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
    principal_id: signer as PrincipalId,
    taint: 'clean',
    metadata: { reset: filled },
  };
}

async function hostWithAuthority(opts: AuthorityPolicyOptions) {
  const host = createMemoryHost();
  await host.atoms.put(authorityPolicyAtom(opts));
  return host;
}

describe('validateResetWrite', () => {
  it('happy path: authorized signer + matching target + non-empty reason -> trip superseded', async () => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'root-operator', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });
    await validateResetWrite(host, reset);

    const trip = await host.atoms.get('trip-1' as AtomId);
    expect(trip!.superseded_by.map(String)).toContain('reset-1');
  });

  it('non-authorized signer throws ResetAuthorityError', async () => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    await host.principals.put(principal('imposter'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'imposter', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });

    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetAuthorityError);

    const trip = await host.atoms.get('trip-1' as AtomId);
    expect(trip!.superseded_by.length).toBe(0); // untouched
  });

  it('depth-1 signer allowed when max_signer_depth=1', async () => {
    const host = await hostWithAuthority({
      authorized: [], // no explicit list
      max_signer_depth: 1,
    });
    await host.principals.put(principal('root-operator'));
    await host.principals.put(principal('deputy', 'root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'deputy', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });
    await validateResetWrite(host, reset);
    const trip = await host.atoms.get('trip-1' as AtomId);
    expect(trip!.superseded_by.map(String)).toContain('reset-1');
  });

  it('trip-not-found -> ShapeError', async () => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    const reset = resetAtom('reset-1', 'root-operator', {
      trip_atom_id: 'trip-does-not-exist' as AtomId,
    });
    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetShapeError);
  });

  it('target mismatch -> ShapeError', async () => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim-A'));
    const reset = resetAtom('reset-1', 'root-operator', {
      target_principal: 'victim-B' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });
    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetShapeError);
  });

  it('already-superseded trip -> ShapeError (one-shot)', async () => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim', { superseded: true }));
    const reset = resetAtom('reset-1', 'root-operator', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });
    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetShapeError);
  });

  it.each([
    ['empty string', ''],
    ['only whitespace', '   '],
    ['tiny string', 'ok'],
    ['only three chars', 'xyz'],
  ])('reset_reason rejection: %s -> ShapeError', async (_label, reason) => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'root-operator', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
      reset_reason: reason,
    });
    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetShapeError);
  });

  it('tainted authority policy is ignored (falls through to default-deny)', async () => {
    // Regression guard: if the policy atom is tainted (operator
    // compromised an authority policy and later marked it tainted),
    // the validator must NOT honor it. Otherwise a compromised atom
    // could silently widen the authorized set or bump max_signer_depth.
    const host = createMemoryHost();
    const tainted = authorityPolicyAtom({ authorized: ['attacker'] });
    await host.atoms.put(tainted);
    await host.atoms.update(tainted.id, { taint: 'tainted' });

    await host.principals.put(principal('attacker'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'attacker', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });

    // With the tainted policy filtered out, the fallback
    // (authorized_principals=[], max_signer_depth=0) applies, so
    // the attacker fails authority.
    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetAuthorityError);
  });

  it('non-existent principal does NOT pass the depth gate even when max_signer_depth >= 0', async () => {
    // Regression guard for the #38 CR round-2 finding: principalDepth
    // used to return 0 for a principal not in the store (the while loop
    // never entered), which meant a signer using a forged/unknown
    // principal id slipped past a depth gate of 0. Fix returns -1 for
    // not-found; isAuthorizedSigner requires `depth >= 0`.
    const host = await hostWithAuthority({
      authorized: [], // only depth gate is active
      max_signer_depth: 5, // generous; real bug was "anyone passes"
    });
    // Seed root but not 'ghost'.
    await host.principals.put(principal('root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'ghost', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
    });

    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetAuthorityError);

    const trip = await host.atoms.get('trip-1' as AtomId);
    expect(trip!.superseded_by.length).toBe(0); // untouched
  });

  it('authorizing_principal mismatch with atom.principal_id -> ShapeError', async () => {
    const host = await hostWithAuthority({ authorized: ['root-operator'] });
    await host.principals.put(principal('root-operator'));
    await host.atoms.put(tripAtom('trip-1', 'victim'));
    const reset = resetAtom('reset-1', 'root-operator', {
      target_principal: 'victim' as PrincipalId,
      trip_atom_id: 'trip-1' as AtomId,
      authorizing_principal: 'someone-else' as PrincipalId,
    });
    await expect(validateResetWrite(host, reset)).rejects.toBeInstanceOf(ResetShapeError);
  });
});
