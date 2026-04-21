/**
 * Negative-test suite. Runs three conformance assertions against the
 * deliberately non-compliant adapter. Each is wrapped in `it.fails(...)`,
 * which inverts the expectation: vitest reports PASS iff the assertion
 * would have FAILED.
 *
 * Purpose: prove the conformance suite actually detects violations.
 * A green suite here means we are catching what we claim to catch.
 */

import { describe, expect, it } from 'vitest';
import { createInvalidHost } from '../../src/adapters/_invalid/index.js';
import type { PrincipalId } from '../../src/substrate/types.js';
import { sampleEvent } from '../fixtures.js';

describe('Negative: invalid adapter fails the conformance checks it should fail', () => {
  it.fails('embed is deterministic across calls [invalid adapter must fail]', async () => {
    const host = createInvalidHost();
    const v1 = await host.atoms.embed('hello');
    const v2 = await host.atoms.embed('hello');
    expect(v1).toEqual(v2);
  });

  it.fails('auditor log grows with writes [invalid adapter must fail]', async () => {
    const host = createInvalidHost();
    const before = host._inner.auditor.size();
    await host.auditor.log({
      kind: 'k',
      principal_id: 'p' as PrincipalId,
      timestamp: '2026-01-01T00:00:00.000Z' as never,
      refs: {},
      details: {},
    });
    const after = host._inner.auditor.size();
    expect(after).toBeGreaterThan(before);
  });

  it.fails('notifier.respond rejects pending disposition [invalid adapter must fail]', async () => {
    const host = createInvalidHost();
    const h = await host.notifier.telegraph(sampleEvent(), null, 'timeout', 60_000);
    await expect(
      host.notifier.respond(h, 'pending', 'user_1' as PrincipalId),
    ).rejects.toThrow();
  });

  // Positive controls: these should PASS normally (without .fails) on the
  // invalid adapter because the adapter didn't break these invariants.
  // Proves we are not over-claiming the adapter is wrong.

  it('put and get still work on invalid adapter (unbroken surface)', async () => {
    const host = createInvalidHost();
    // Just sanity: use the core surface. The invalid adapter only wraps
    // embed / log / respond; put / get are the inner memory adapter.
    await host.principals.put({
      id: 'p1' as PrincipalId,
      name: 'test',
      role: 'agent',
      permitted_scopes: { read: ['project'], write: ['project'] },
      permitted_layers: { read: ['L0', 'L1'], write: ['L0'] },
      goals: [],
      constraints: [],
      active: true,
      compromised_at: null,
      signed_by: null,
      created_at: '2026-01-01T00:00:00.000Z' as never,
    });
    const got = await host.principals.get('p1' as PrincipalId);
    expect(got?.name).toBe('test');
  });
});
