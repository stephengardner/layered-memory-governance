/**
 * Tests for the pr-orphan-reconcile cadence canon reader.
 *
 * Covers:
 *   - Default fallback when no canon atom exists
 *   - Configured value returned when atom is well-formed
 *   - Malformed values fall back to default (defensive)
 *   - Tainted / superseded canon atoms ignored
 *   - Back-compat: `value` field accepted alongside `interval_ms`
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  DEFAULT_PR_ORPHAN_CADENCE_MS,
  readPrOrphanReconcileCadenceMs,
} from '../../../src/runtime/loop/pr-orphan-cadence.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-06T01:00:00.000Z' as Time;

function policyAtom(
  id: string,
  policy: Readonly<Record<string, unknown>>,
  overrides: { readonly tainted?: boolean; readonly superseded?: boolean } = {},
): Atom {
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
    superseded_by: overrides.superseded ? ['x' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    metadata: { policy },
  };
}

describe('readPrOrphanReconcileCadenceMs', () => {
  it('returns the default when no canon atom is present', async () => {
    const host = createMemoryHost();
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
  });

  it('returns the configured interval_ms when a valid atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pr-orphan-cadence', {
        subject: 'pr-orphan-reconcile-cadence-ms',
        interval_ms: 60_000,
      }),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(60_000);
  });

  it('back-compat accepts `value` as the field name', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pr-orphan-cadence-old', {
        subject: 'pr-orphan-reconcile-cadence-ms',
        value: 90_000,
      }),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(90_000);
  });

  it('falls back to default for malformed values', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-malformed', {
        subject: 'pr-orphan-reconcile-cadence-ms',
        interval_ms: 'not-a-number',
      }),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
  });

  it('falls back to default for non-positive values', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-zero', {
        subject: 'pr-orphan-reconcile-cadence-ms',
        interval_ms: 0,
      }),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
    await host.atoms.put(
      policyAtom('pol-neg', {
        subject: 'pr-orphan-reconcile-cadence-ms',
        interval_ms: -1,
      }),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom(
        'pol-tainted',
        { subject: 'pr-orphan-reconcile-cadence-ms', interval_ms: 60_000 },
        { tainted: true },
      ),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
  });

  it('ignores superseded canon atoms', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom(
        'pol-superseded',
        { subject: 'pr-orphan-reconcile-cadence-ms', interval_ms: 60_000 },
        { superseded: true },
      ),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
  });

  it('ignores atoms with the wrong subject', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-other-subject', {
        subject: 'pr-observation-freshness-threshold-ms',
        interval_ms: 60_000,
      }),
    );
    expect(await readPrOrphanReconcileCadenceMs(host)).toBe(
      DEFAULT_PR_ORPHAN_CADENCE_MS,
    );
  });
});
