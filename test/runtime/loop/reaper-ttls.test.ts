/**
 * Tests for the reaper-TTLs canon-policy reader.
 *
 * The reader follows the same shape as readPrObservationFreshnessMs and
 * readApprovalCycleTickIntervalMs so a tunable substrate-knob reuses one
 * pattern across the loop directory. These tests lock the contract:
 *
 *   - returns the validated pair when a clean, well-formed policy atom
 *     exists with subject='reaper-ttls'
 *   - returns null on absence (caller falls through to env / defaults)
 *   - returns null + emits a stderr WARN on a malformed payload (the
 *     warning surfaces the operator-data error without crashing the
 *     reaper boot)
 *   - ignores tainted / superseded atoms so a revoked policy does not
 *     leak into resolution
 *
 * Resolution-chain integration (canon > env > defaults) is asserted in
 * test/loop/runner.test.ts where the LoopRunner orchestrates the chain.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { readReaperTtlsFromCanon } from '../../../src/runtime/loop/reaper-ttls.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-04T00:00:00.000Z' as Time;

/**
 * Direct console.error replacement for capture-on-test. The vitest
 * config in this repo runs with `globals: false` and the
 * vi.spyOn(console, 'error') interception has been unreliable in
 * that mode; direct replacement works in both contexts.
 */
function captureStderr(): {
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  restore: () => void;
} {
  const original = console.error;
  const captured: unknown[][] = [];
  // Wrap as `typeof console.error` so we don't reach for an `any` cast
  // (the architectural guard rejects `any` in tracked TS sources).
  const replacement: typeof console.error = (...args: unknown[]): void => {
    captured.push(args);
  };
  console.error = replacement;
  return {
    calls: captured,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * Run readReaperTtlsFromCanon with stderr captured, restoring the
 * original console.error in a finally block so a thrown reader does
 * not leak the patched global into later tests. Returns the reader's
 * result alongside the captured calls so the assertion shape stays
 * identical to the previous inline pattern. Extracted per the
 * substrate's N=2 duplication rule (the inline shape repeated five
 * times across the malformed-payload tests below).
 */
async function readWithCapturedStderr(
  host: ReturnType<typeof createMemoryHost>,
): Promise<{
  readonly ttls: Awaited<ReturnType<typeof readReaperTtlsFromCanon>>;
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
}> {
  const cap = captureStderr();
  try {
    const ttls = await readReaperTtlsFromCanon(host);
    return { ttls, calls: cap.calls };
  } finally {
    cap.restore();
  }
}

function policyAtom(id: string, warn: unknown, abandon: unknown): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'reaper TTLs',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
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
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'reaper-ttls',
        warn_ms: warn,
        abandon_ms: abandon,
      },
    },
  };
}

describe('readReaperTtlsFromCanon', () => {
  it('returns null when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(await readReaperTtlsFromCanon(host)).toBeNull();
  });

  it('returns the configured pair when a valid canon atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-reaper-ttls-default', 60 * 60 * 1000, 2 * 60 * 60 * 1000),
    );
    const ttls = await readReaperTtlsFromCanon(host);
    expect(ttls).toEqual({
      staleWarnMs: 60 * 60 * 1000,
      staleAbandonMs: 2 * 60 * 60 * 1000,
    });
  });

  it('returns null + warns when warn_ms is non-integer', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bad-warn', 1.5, 60_000));
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('malformed payload');
  });

  it('returns null + warns when warn_ms is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-zero', 0, 60_000));
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when abandon_ms <= warn_ms (would merge buckets)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-inverted', 5_000, 5_000));
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('abandon > warn');
  });

  it('returns null + warns when warn_ms is missing', async () => {
    const host = createMemoryHost();
    // policyAtom builder expects two values; pass undefined to omit the
    // numeric value while preserving the subject discriminator.
    await host.atoms.put(policyAtom('pol-missing', undefined, 60_000));
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when abandon_ms is non-numeric', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-string-abandon', 5_000, 'forever'));
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-tainted', 60 * 60 * 1000, 2 * 60 * 60 * 1000);
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(await readReaperTtlsFromCanon(host)).toBeNull();
  });

  it('ignores superseded canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-superseded', 60 * 60 * 1000, 2 * 60 * 60 * 1000);
    await host.atoms.put({ ...a, superseded_by: ['pol-newer' as AtomId] });
    expect(await readReaperTtlsFromCanon(host)).toBeNull();
  });

  it('skips atoms whose policy.subject is not "reaper-ttls"', async () => {
    const host = createMemoryHost();
    // A directive atom with a totally different subject must not be
    // misread as a reaper-TTLs policy. The subject discriminator is
    // load-bearing; mis-routing would let an unrelated atom dictate
    // the reaper cadence.
    const unrelated: Atom = {
      ...policyAtom('pol-other', 60_000, 120_000),
      metadata: {
        policy: {
          subject: 'pr-observation-freshness-threshold-ms',
          freshness_ms: 60_000,
        },
      },
    };
    await host.atoms.put(unrelated);
    expect(await readReaperTtlsFromCanon(host)).toBeNull();
  });
});
