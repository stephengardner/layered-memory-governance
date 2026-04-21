/**
 * AuditorActor tests.
 *
 * Covers:
 *   - empty store -> 0-findings report, clean reply message
 *   - tainted atoms -> warn finding with atom ids listed
 *   - open circuit-breaker trip -> warn finding
 *   - orphan provenance (derived_from points at missing id) -> critical finding
 *   - reply message is an actor-message addressed to payload.reply_to
 *     with correlation_id preserved
 *   - result is InvokeResult.completed with both atom ids
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runAuditor } from '../../src/actor-message/auditor-actor.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';

function sampleAtom(id: string, over: Partial<Atom> = {}): Atom {
  const now = '2026-04-20T00:00:00.000Z' as Time;
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'c',
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'bob', tool: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
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
    principal_id: 'bob' as PrincipalId,
    taint: 'clean',
    metadata: {},
    ...over,
  };
}

describe('runAuditor', () => {
  it('empty store -> 0 findings, completed result, reply to operator', async () => {
    const host = createMemoryHost();
    const result = await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
    }, 'corr-empty');

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.producedAtomIds.length).toBe(2);

    // Reply actor-message present and addressed to operator.
    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const reply = replies.atoms.find((a) => a.metadata?.actor_message?.correlation_id === 'corr-empty');
    expect(reply).toBeDefined();
    expect(reply!.metadata.actor_message.to).toBe('operator');
    expect(reply!.metadata.actor_message.body).toContain('Audit clean');
  });

  it('flags tainted atoms as warn', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom('a1'));
    await host.atoms.put(sampleAtom('a2', { taint: 'tainted' }));
    await host.atoms.put(sampleAtom('a3', { taint: 'quarantined' }));

    await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
    }, 'corr-tainted');

    const obs = await host.atoms.query({ type: ['observation'] }, 100);
    const audit = obs.atoms.find((a) => a.metadata?.audit?.correlation_id === 'corr-tainted');
    expect(audit).toBeDefined();
    const findings = audit!.metadata.audit.findings as Array<{ kind: string; atomIds: string[] }>;
    const taintedFinding = findings.find((f) => f.kind === 'tainted-atoms');
    expect(taintedFinding).toBeDefined();
    expect(taintedFinding!.atomIds.sort()).toEqual(['a2', 'a3']);
  });

  it('flags open circuit-breaker trips as warn', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom('t1', {
      type: 'circuit-breaker-trip',
      metadata: { trip: { target_principal: 'bob' } },
    }));

    await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
    }, 'corr-trip');

    const obs = await host.atoms.query({ type: ['observation'] }, 100);
    const audit = obs.atoms.find((a) => a.metadata?.audit?.correlation_id === 'corr-trip');
    const findings = audit!.metadata.audit.findings as Array<{ kind: string }>;
    expect(findings.some((f) => f.kind === 'open-circuit-breaker-trips')).toBe(true);
  });

  it('flags orphan provenance as critical', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom('child', {
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'bob' },
        derived_from: ['non-existent-parent' as AtomId],
      },
    }));

    await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
    }, 'corr-orphan');

    const obs = await host.atoms.query({ type: ['observation'] }, 100);
    const audit = obs.atoms.find((a) => a.metadata?.audit?.correlation_id === 'corr-orphan');
    const findings = audit!.metadata.audit.findings as Array<{ kind: string; severity: string }>;
    const orphan = findings.find((f) => f.kind === 'orphan-provenance');
    expect(orphan).toBeDefined();
    expect(orphan!.severity).toBe('critical');
  });

  it('does NOT flag orphan provenance when the parent exists outside the scan slice', async () => {
    // Regression guard for the CR-flagged false-critical: the prior
    // implementation declared an atom's parent "orphan" if the parent
    // id was missing from the in-slice set, even when the parent was
    // alive and well in the store just outside the scan scope. The
    // fix explicitly verifies via host.atoms.get before flagging.
    const host = createMemoryHost();
    // Parent lives in the store but we will scope the scan to exclude
    // it by filtering to a specific principal_id.
    await host.atoms.put(sampleAtom('parent', { principal_id: 'other-principal' as PrincipalId }));
    // Child references parent; child's principal_id is 'in-scope'.
    await host.atoms.put(sampleAtom('child', {
      principal_id: 'in-scope' as PrincipalId,
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'bob' },
        derived_from: ['parent' as AtomId],
      },
    }));

    await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
      filter: { principal_id: 'in-scope' as PrincipalId },
    }, 'corr-scoped');

    const obs = await host.atoms.query({ type: ['observation'] }, 100);
    const audit = obs.atoms.find((a) => a.metadata?.audit?.correlation_id === 'corr-scoped');
    expect(audit).toBeDefined();
    const findings = audit!.metadata.audit.findings as Array<{ kind: string }>;
    // parent exists in the store (just outside the slice); must NOT
    // surface as orphan provenance.
    expect(findings.find((f) => f.kind === 'orphan-provenance')).toBeUndefined();
  });

  it('honors payload.filter.type, excluding other types from the audit scan', async () => {
    // Regression guard for the CR-flagged filter-drop: the auditor
    // advertised type filtering but only forwarded principal_id.
    // A type-scoped audit should not surface taint/orphan counts
    // from atoms outside the requested type.
    const host = createMemoryHost();
    // One tainted observation; auditor should flag it when scoped
    // to observations.
    await host.atoms.put(sampleAtom('obs-tainted', { taint: 'tainted' }));
    // One tainted directive; auditor scoped to observations should
    // NOT flag it. Before the fix, the auditor scanned the whole
    // store and included this in the tainted count.
    await host.atoms.put(sampleAtom('dir-tainted', {
      type: 'directive',
      taint: 'tainted',
    }));

    await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
      filter: { type: ['observation'] },
    }, 'corr-typefilter');

    const obs = await host.atoms.query({ type: ['observation'] }, 100);
    const audit = obs.atoms.find((a) => a.metadata?.audit?.correlation_id === 'corr-typefilter');
    expect(audit).toBeDefined();
    const findings = audit!.metadata.audit.findings as Array<{ kind: string; atomIds: string[] }>;
    const tainted = findings.find((f) => f.kind === 'tainted-atoms');
    expect(tainted).toBeDefined();
    // Only the observation-typed tainted atom (obs-tainted) should
    // appear; the directive-typed one is outside the scope.
    expect(tainted!.atomIds.sort()).toEqual(['obs-tainted']);
  });

  it('reply message preserves correlation_id and urgency reflects severity', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom('child', {
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'bob' },
        derived_from: ['missing-id' as AtomId], // critical finding
      },
    }));

    await runAuditor(host, {
      reply_to: 'operator' as PrincipalId,
    }, 'corr-urgency');

    const replies = await host.atoms.query({ type: ['actor-message'] }, 100);
    const reply = replies.atoms.find((a) => a.metadata?.actor_message?.correlation_id === 'corr-urgency');
    expect(reply).toBeDefined();
    expect(reply!.metadata.actor_message.urgency_tier).toBe('high');
  });
});
