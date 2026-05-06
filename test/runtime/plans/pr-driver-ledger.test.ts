/**
 * Tests for the PR-driver ledger primitives.
 *
 * Covers:
 *   - buildPrDriverClaim atom shape (deterministic id, principal binding,
 *     expiry computation, derived_from chain)
 *   - buildReleasePrDriverClaim atom shape (supersedes chain, status
 *     flip)
 *   - findActiveDriverClaim selection (most-recent claim wins;
 *     superseded / tainted / wrong-pr atoms ignored)
 *   - Idempotence guard (deterministic ids reject duplicate puts)
 *   - Lifetime + edge cases (negative lifetime rejected, malformed
 *     timestamps rejected, override accepted)
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  buildPrDriverClaim,
  buildReleasePrDriverClaim,
  findActiveDriverClaim,
  makeClaimId,
  makeReleaseClaimId,
  CLAIM_ID_BUCKET_MS,
  DEFAULT_DRIVER_CLAIM_LIFETIME_MS,
} from '../../../src/runtime/plans/pr-driver-ledger.js';
import { ConflictError } from '../../../src/substrate/errors.js';
import type { AtomId, Time } from '../../../src/types.js';

const NOW = '2026-05-06T01:00:00.000Z' as Time;
const PR = { owner: 'lag-org', repo: 'memory-governance', number: 323 };

describe('buildPrDriverClaim', () => {
  it('produces an atom with the expected shape and deterministic id', () => {
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    expect(claim.type).toBe('pr-driver-claim');
    expect(claim.layer).toBe('L1');
    expect(claim.taint).toBe('clean');
    expect(claim.metadata['status']).toBe('claimed');
    expect(claim.metadata['principal_id']).toBe('cto-actor');
    const meta = claim.metadata as Record<string, unknown>;
    expect(meta['pr']).toEqual({ owner: 'lag-org', repo: 'memory-governance', number: 323 });
    // Deterministic id matches the helper.
    expect(claim.id).toBe(makeClaimId(PR, NOW));
    // Expiry is now + default lifetime.
    const expectedExpiry = new Date(
      Date.parse(NOW) + DEFAULT_DRIVER_CLAIM_LIFETIME_MS,
    ).toISOString();
    expect(claim.expires_at).toBe(expectedExpiry);
    expect(meta['expires_at']).toBe(expectedExpiry);
  });

  it('honors derived_from for provenance chain', () => {
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
      derived_from: ['intent-abc' as AtomId, 'plan-def' as AtomId],
    });
    expect(claim.provenance.derived_from).toEqual(['intent-abc', 'plan-def']);
  });

  it('honors a custom lifetime_ms override', () => {
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
      lifetime_ms: 60_000,
    });
    const expectedExpiry = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(claim.expires_at).toBe(expectedExpiry);
  });

  it('rejects a malformed claimed_at', () => {
    expect(() =>
      buildPrDriverClaim({
        pr: PR,
        principal_id: 'cto-actor',
        claimed_at: 'not-an-iso-string' as Time,
      }),
    ).toThrow(/claimed_at/);
  });

  it('rejects a non-positive lifetime_ms', () => {
    expect(() =>
      buildPrDriverClaim({
        pr: PR,
        principal_id: 'cto-actor',
        claimed_at: NOW,
        lifetime_ms: 0,
      }),
    ).toThrow(/lifetime_ms/);
    expect(() =>
      buildPrDriverClaim({
        pr: PR,
        principal_id: 'cto-actor',
        claimed_at: NOW,
        lifetime_ms: -1,
      }),
    ).toThrow(/lifetime_ms/);
  });

  it('records a driver_role when supplied', () => {
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
      driver_role: 'fix',
    });
    expect(claim.metadata['driver_role']).toBe('fix');
  });

  it('omits driver_role from metadata when not supplied', () => {
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    expect(Object.keys(claim.metadata)).not.toContain('driver_role');
  });
});

describe('buildReleasePrDriverClaim', () => {
  it('produces an atom that supersedes the prior claim', () => {
    const prior = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    const release = buildReleasePrDriverClaim({
      priorClaim: prior,
      released_at: '2026-05-06T01:30:00.000Z' as Time,
      reason: 'sub-agent reported terminal success',
    });
    expect(release.type).toBe('pr-driver-claim');
    expect(release.metadata['status']).toBe('released');
    expect(release.supersedes).toEqual([prior.id]);
    expect(release.provenance.derived_from).toEqual([prior.id]);
    expect(release.id).toBe(makeReleaseClaimId(prior.id));
    expect(release.metadata['reason']).toBe('sub-agent reported terminal success');
    expect(release.metadata['prior_claim_id']).toBe(String(prior.id));
  });

  it('rejects a prior atom of the wrong type', () => {
    const prior = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    // Casting to a sibling type to simulate an external caller passing
    // the wrong atom; the runtime guard must catch it.
    const wrong = { ...prior, type: 'observation' as const };
    expect(() =>
      buildReleasePrDriverClaim({
        priorClaim: wrong,
        released_at: NOW,
      }),
    ).toThrow(/pr-driver-claim/);
  });

  it('release id is deterministic on the prior claim id', () => {
    const prior = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    const a = buildReleasePrDriverClaim({ priorClaim: prior, released_at: NOW });
    const b = buildReleasePrDriverClaim({
      priorClaim: prior,
      released_at: '2026-05-06T02:00:00.000Z' as Time,
    });
    expect(a.id).toBe(b.id); // same prior id => same release id
  });
});

describe('findActiveDriverClaim', () => {
  it('returns null when no claim exists', async () => {
    const host = createMemoryHost();
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it('returns the active claim when one exists', async () => {
    const host = createMemoryHost();
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await host.atoms.put(claim);
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).not.toBeNull();
    expect(r.claim!.atom.id).toBe(claim.id);
    expect(r.claim!.principal_id).toBe('cto-actor');
  });

  it('skips superseded claims', async () => {
    const host = createMemoryHost();
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await host.atoms.put(claim);
    const release = buildReleasePrDriverClaim({
      priorClaim: claim,
      released_at: '2026-05-06T01:30:00.000Z' as Time,
    });
    await host.atoms.put(release);
    await host.atoms.update(claim.id, { superseded_by: [release.id] });
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).toBeNull();
  });

  it('skips released claims (status guard)', async () => {
    const host = createMemoryHost();
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    // Tampered claim: status flipped to released without a successor
    // atom. The findActive walk treats this as no active claim.
    await host.atoms.put({
      ...claim,
      metadata: { ...claim.metadata, status: 'released' },
    });
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).toBeNull();
  });

  it('skips tainted claims', async () => {
    const host = createMemoryHost();
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await host.atoms.put({ ...claim, taint: 'tainted' });
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).toBeNull();
  });

  it('skips claims for a different PR', async () => {
    const host = createMemoryHost();
    const otherClaim = buildPrDriverClaim({
      pr: { owner: 'lag-org', repo: 'memory-governance', number: 999 },
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await host.atoms.put(otherClaim);
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).toBeNull();
  });

  it('selects the most recent claim when multiple are active', async () => {
    // Two simultaneously claimed claims for the same PR (should not
    // happen in practice given deterministic ids, but the resolution
    // must still be deterministic for forensic / migration scenarios).
    const host = createMemoryHost();
    const earlier = buildPrDriverClaim({
      pr: PR,
      principal_id: 'first-claimer',
      claimed_at: NOW,
    });
    const later = buildPrDriverClaim({
      pr: PR,
      principal_id: 'second-claimer',
      claimed_at: '2026-05-06T01:01:00.000Z' as Time,
    });
    await host.atoms.put(earlier);
    await host.atoms.put(later);
    const r = await findActiveDriverClaim(host, PR);
    expect(r.claim).not.toBeNull();
    expect(r.claim!.principal_id).toBe('second-claimer');
  });
});

describe('Idempotence', () => {
  it('a duplicate claim id is rejected by host.atoms.put', async () => {
    const host = createMemoryHost();
    const claim = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await host.atoms.put(claim);
    // Same (pr, claimed_at) tuple => same deterministic id.
    const dup = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await expect(host.atoms.put(dup)).rejects.toBeInstanceOf(ConflictError);
  });

  it('a fresh claim after release produces a different id (lifecycle)', async () => {
    const host = createMemoryHost();
    const first = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor',
      claimed_at: NOW,
    });
    await host.atoms.put(first);
    const second = buildPrDriverClaim({
      pr: PR,
      principal_id: 'cto-actor-2',
      claimed_at: '2026-05-06T02:00:00.000Z' as Time,
    });
    expect(second.id).not.toBe(first.id);
    await host.atoms.put(second); // succeeds
  });
});

describe('makeClaimId / makeReleaseClaimId', () => {
  it('claim id matches the documented hash format with bucketed claimed_at', () => {
    const id = makeClaimId(PR, NOW);
    // claimed_at is normalized to CLAIM_ID_BUCKET_MS granularity
    // before hashing so two dispatchers racing within the same
    // bucket land on the same id and trip host.atoms.put's
    // duplicate-id guard.
    const claimedMs = Date.parse(NOW);
    const bucketKey = String(
      Math.floor(claimedMs / CLAIM_ID_BUCKET_MS) * CLAIM_ID_BUCKET_MS,
    );
    const expected = createHash('sha256')
      .update('lag-org')
      .update('|')
      .update('memory-governance')
      .update('|')
      .update('323')
      .update('|')
      .update(bucketKey)
      .digest('hex')
      .slice(0, 16);
    expect(id).toBe(`pr-driver-claim-${expected}`);
  });

  it('two claims within the same bucket collide on id; across-bucket claims differ', () => {
    // Two timestamps in the same 1-minute bucket: ms-apart races
    // collapse to one id so the substrate-level dup-guard fires.
    const first = makeClaimId(PR, '2026-05-06T01:00:00.123Z' as Time);
    const second = makeClaimId(PR, '2026-05-06T01:00:00.456Z' as Time);
    expect(second).toBe(first);
    // Bucket boundary crossed: legitimate post-release re-claim
    // produces a fresh id.
    const next = makeClaimId(PR, '2026-05-06T01:01:00.000Z' as Time);
    expect(next).not.toBe(first);
  });

  it('release id matches the documented hash format', () => {
    const priorId = 'pr-driver-claim-deadbeef' as AtomId;
    const id = makeReleaseClaimId(priorId);
    const expected = createHash('sha256')
      .update('release|')
      .update(String(priorId))
      .digest('hex')
      .slice(0, 16);
    expect(id).toBe(`pr-driver-claim-released-${expected}`);
  });
});
