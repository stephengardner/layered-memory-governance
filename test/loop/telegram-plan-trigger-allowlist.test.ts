/**
 * Canon-reader tests for the telegram-plan-trigger principal allowlist.
 *
 * Pins: defaults on absence, canon hit, empty-array opt-out, malformed
 * payload fallback, taint guard, supersede guard.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  DEFAULT_PRINCIPAL_ALLOWLIST,
  readPlanTriggerAllowlist,
} from '../../src/runtime/loop/telegram-plan-trigger-allowlist.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

function policyAtom(id: string, policy: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'telegram-plan-trigger principals policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: '2026-05-05T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-05-05T00:00:00.000Z' as Time,
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
    metadata: { policy },
  };
}

describe('readPlanTriggerAllowlist', () => {
  it('returns DEFAULT_PRINCIPAL_ALLOWLIST when no policy atom exists', async () => {
    const host = createMemoryHost();
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
    expect(allowlist).toContain('cto-actor');
    expect(allowlist).toContain('cpo-actor');
  });

  it('returns canon-supplied allowlist when policy atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor'],
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(['cto-actor']);
  });

  it('returns empty allowlist when canon explicitly empties it (org-ceiling opt-out)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: [],
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual([]);
  });

  it('falls back to defaults on malformed policy (non-array principal_ids)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: 'cto-actor',  // string, not array
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('falls back to defaults on malformed policy (non-string entries)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor', 42, ''],
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('ignores tainted policy atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor'],
    });
    a.taint = 'tainted';
    await host.atoms.put(a);
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('ignores superseded policy atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor'],
    });
    a.superseded_by = ['some-newer-id' as AtomId];
    await host.atoms.put(a);
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('ignores directive atoms with a different subject', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-other', {
      subject: 'reaper-ttls',
      warn_ms: 1000,
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });
});
