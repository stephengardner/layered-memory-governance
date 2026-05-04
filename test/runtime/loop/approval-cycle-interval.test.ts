/**
 * Tests for the approval-cycle tick-interval canon reader.
 *
 * Closes substrate gap #8 self-sustainment: the firing cadence of the
 * approval-cycle daemon (which drives the pr-observation-refresh tick)
 * is canon-tunable. The reader follows the same shape as
 * readPrObservationFreshnessMs so that the policy data lives in atoms,
 * not constants.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  DEFAULT_TICK_INTERVAL_MS,
  readApprovalCycleTickIntervalMs,
} from '../../../src/runtime/loop/approval-cycle-interval.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-01T00:00:00.000Z' as Time;

function policyAtom(id: string, value: unknown): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'policy',
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
      policy: { subject: 'approval-cycle-tick-interval-ms', interval_ms: value },
    },
  };
}

describe('readApprovalCycleTickIntervalMs', () => {
  it('returns DEFAULT_TICK_INTERVAL_MS when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('returns the configured value when a valid canon atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-approval-cycle-tick-interval-ms', 60_000));
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(60_000);
  });

  it('default matches the freshness threshold (5 minutes)', () => {
    // Justification: the tick interval should not be slower than the
    // freshness threshold or stale observations linger past their
    // refresh window. 5 minutes for both keeps the substrate
    // self-consistent without forcing an operator to tune both atoms
    // in lock-step.
    expect(DEFAULT_TICK_INTERVAL_MS).toBe(5 * 60 * 1_000);
  });

  it('falls back to default when value is non-numeric', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-malformed', 'not-a-number'));
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('falls back to default when value is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-zero', 0));
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
    await host.atoms.put(policyAtom('pol-neg', -1));
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('falls back to default when value is non-finite (NaN or Infinity from JSON)', async () => {
    // JSON cannot encode NaN or Infinity; a malformed payload that
    // round-trips them to a non-finite number must not silently coerce
    // the daemon into a busy-spin or never-fire state.
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-nan', Number.NaN));
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-tainted', 60_000);
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('ignores superseded canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-superseded', 60_000);
    await host.atoms.put({ ...a, superseded_by: ['pol-newer' as AtomId] });
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('back-compat reads the legacy `value` field', async () => {
    // Match readPrObservationFreshnessMs's back-compat read so a
    // bootstrap snapshot in the older shape stays usable while the
    // named-field shape is canonical going forward.
    const host = createMemoryHost();
    const legacy: Atom = {
      ...policyAtom('pol-legacy', 0),
      metadata: {
        policy: { subject: 'approval-cycle-tick-interval-ms', value: 60_000 },
      },
    };
    await host.atoms.put(legacy);
    expect(await readApprovalCycleTickIntervalMs(host)).toBe(60_000);
  });
});
