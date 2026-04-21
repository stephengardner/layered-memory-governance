/**
 * Scenario 6: principal compromise and taint cascade.
 *
 * Threat model: a principal (e.g., a service token) is discovered
 * compromised at time T. All atoms that principal wrote at/after T are
 * no longer trustworthy. Worse: any downstream atom that derived from a
 * compromised atom (via provenance.derived_from) inherits the taint.
 *
 * Framework response: propagateCompromiseTaint walks the graph, marks
 * atoms tainted, and audits each transition. The canon generator and
 * promotion policy both exclude taint !== 'clean' by construction, so
 * the next canon apply and promotion pass automatically drop the blast
 * radius out of trusted state.
 *
 * This scenario proves:
 *   1. Direct taint: atoms by the compromised principal after T become tainted.
 *   2. Temporal bound: atoms by that principal BEFORE T stay clean.
 *   3. Transitive taint: downstream derivations flip tainted to fixpoint.
 *   4. Clean graph is untouched: unrelated chains keep taint='clean'.
 *   5. Canon regeneration excludes the tainted subgraph.
 *   6. Idempotence: re-running is a no-op.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { renderCanonMarkdown } from '../../src/canon-md/generator.js';
import { propagateCompromiseTaint } from '../../src/taint/propagate.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { samplePrincipal, sampleAtom } from '../fixtures.js';

const responder = 'soc-analyst' as PrincipalId;

async function seedCompromiseScene() {
  const host = createMemoryHost();
  const t0 = host.clock.now();
  const t0Ms = Date.parse(t0);

  // Principals:
  //   alice: honest, writes before and after Bob's compromise time.
  //   bob: gets compromised at T (5 minutes after t0).
  //   carol: writes downstream atoms derived from Bob's output (post-T).
  await host.principals.put(samplePrincipal({ id: 'alice' as PrincipalId }));
  await host.principals.put(samplePrincipal({ id: 'bob' as PrincipalId }));
  await host.principals.put(samplePrincipal({ id: 'carol' as PrincipalId }));

  const T = new Date(t0Ms + 5 * 60 * 1000).toISOString() as Time;

  // Alice: 2 clean observations, one before T, one after T.
  await host.atoms.put(sampleAtom({
    id: 'A0_clean_before_T' as AtomId,
    content: 'Alice fact from before compromise.',
    principal_id: 'alice' as PrincipalId,
    created_at: new Date(t0Ms).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms).toISOString() as Time,
    layer: 'L2',
    type: 'observation',
  }));
  await host.atoms.put(sampleAtom({
    id: 'A1_clean_after_T' as AtomId,
    content: 'Alice fact from after compromise (clean: not Bob).',
    principal_id: 'alice' as PrincipalId,
    created_at: new Date(t0Ms + 10 * 60 * 1000).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms + 10 * 60 * 1000).toISOString() as Time,
    layer: 'L2',
    type: 'observation',
  }));

  // Bob: 1 atom before T (clean), 1 atom after T (becomes tainted).
  await host.atoms.put(sampleAtom({
    id: 'B0_before_T' as AtomId,
    content: 'Bob trusted observation (before compromise).',
    principal_id: 'bob' as PrincipalId,
    created_at: new Date(t0Ms + 1 * 60 * 1000).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms + 1 * 60 * 1000).toISOString() as Time,
    layer: 'L2',
    type: 'observation',
  }));
  await host.atoms.put(sampleAtom({
    id: 'B1_after_T' as AtomId,
    content: 'Bob poisoned observation (after compromise).',
    principal_id: 'bob' as PrincipalId,
    created_at: new Date(t0Ms + 6 * 60 * 1000).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms + 6 * 60 * 1000).toISOString() as Time,
    layer: 'L2',
    type: 'observation',
  }));

  // Carol: two derivations, one from B1 (tainted transitive), one from A1 (clean).
  await host.atoms.put(sampleAtom({
    id: 'C_derived_from_B1' as AtomId,
    content: 'Carol synthesis built on Bob (poisoned) output.',
    principal_id: 'carol' as PrincipalId,
    created_at: new Date(t0Ms + 8 * 60 * 1000).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms + 8 * 60 * 1000).toISOString() as Time,
    layer: 'L2',
    type: 'observation',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'carol' },
      derived_from: ['B1_after_T' as AtomId],
    },
  }));
  await host.atoms.put(sampleAtom({
    id: 'C_derived_from_A1' as AtomId,
    content: 'Carol synthesis built on Alice (clean) output.',
    principal_id: 'carol' as PrincipalId,
    created_at: new Date(t0Ms + 9 * 60 * 1000).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms + 9 * 60 * 1000).toISOString() as Time,
    layer: 'L2',
    type: 'observation',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'carol' },
      derived_from: ['A1_clean_after_T' as AtomId],
    },
  }));

  // Deep chain: atom derived from Carol's tainted synthesis (transitive x2).
  await host.atoms.put(sampleAtom({
    id: 'D_derived_from_C_B1' as AtomId,
    content: 'Downstream synthesis, 2 hops from Bob.',
    principal_id: 'alice' as PrincipalId,
    created_at: new Date(t0Ms + 11 * 60 * 1000).toISOString() as Time,
    last_reinforced_at: new Date(t0Ms + 11 * 60 * 1000).toISOString() as Time,
    layer: 'L2',
    type: 'decision',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'alice' },
      derived_from: ['C_derived_from_B1' as AtomId],
    },
  }));

  return { host, T };
}

describe('Scenario 6: principal compromise taint cascade', () => {
  it('direct taint: atoms by the compromised principal after T are tainted', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');

    const report = await propagateCompromiseTaint(
      host,
      'bob' as PrincipalId,
      responder,
    );

    expect(report.atomsTainted).toBeGreaterThan(0);
    const b1 = await host.atoms.get('B1_after_T' as AtomId);
    expect(b1?.taint).toBe('tainted');
  });

  it('temporal bound: Bob atoms BEFORE T stay clean', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');
    await propagateCompromiseTaint(host, 'bob' as PrincipalId, responder);

    const b0 = await host.atoms.get('B0_before_T' as AtomId);
    expect(b0?.taint).toBe('clean');
  });

  it('transitive taint: Carol derivation from B1 flips tainted; derivation from A1 stays clean', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');
    await propagateCompromiseTaint(host, 'bob' as PrincipalId, responder);

    const tainted = await host.atoms.get('C_derived_from_B1' as AtomId);
    expect(tainted?.taint).toBe('tainted');

    const clean = await host.atoms.get('C_derived_from_A1' as AtomId);
    expect(clean?.taint).toBe('clean');
  });

  it('two-hop propagation: D derived from C (derived from B1) flips tainted', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');
    const report = await propagateCompromiseTaint(
      host,
      'bob' as PrincipalId,
      responder,
    );

    const deep = await host.atoms.get('D_derived_from_C_B1' as AtomId);
    expect(deep?.taint).toBe('tainted');
    // Fixpoint: at least 3 atoms tainted (B1, C_B1, D_C_B1).
    expect(report.atomsTainted).toBeGreaterThanOrEqual(3);
    // Iterations: 1 direct + >=2 transitive passes to reach D, plus 1 final no-op.
    expect(report.iterations).toBeGreaterThanOrEqual(3);
  });

  it('unrelated atoms stay clean', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');
    await propagateCompromiseTaint(host, 'bob' as PrincipalId, responder);

    const a0 = await host.atoms.get('A0_clean_before_T' as AtomId);
    const a1 = await host.atoms.get('A1_clean_after_T' as AtomId);
    expect(a0?.taint).toBe('clean');
    expect(a1?.taint).toBe('clean');
  });

  it('canon re-render excludes the tainted subgraph', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');
    await propagateCompromiseTaint(host, 'bob' as PrincipalId, responder);

    // Treat the current L2 atoms as canon-eligible and render.
    const page = await host.atoms.query({ layer: ['L2'] }, 100);
    const rendered = renderCanonMarkdown(page.atoms, { now: host.clock.now() });

    expect(rendered).not.toContain('Bob poisoned');
    expect(rendered).not.toContain('Carol synthesis built on Bob');
    expect(rendered).not.toContain('2 hops from Bob');
    // Clean paths survive.
    expect(rendered).toContain('Alice fact from before compromise');
    expect(rendered).toContain('Bob trusted observation');
    expect(rendered).toContain('Carol synthesis built on Alice');
  });

  it('audit events recorded per transition with mode and trigger_principal', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');
    const report = await propagateCompromiseTaint(
      host,
      'bob' as PrincipalId,
      responder,
    );

    const audits = await host.auditor.query({ kind: ['atom.tainted'] }, 50);
    expect(audits.length).toBe(report.atomsTainted);

    const modes = audits.map(a => a.details['mode']);
    expect(modes).toContain('direct');
    expect(modes).toContain('transitive');
    for (const a of audits) {
      expect(a.details['trigger_principal']).toBe('bob');
    }
  });

  it('idempotent: re-running propagate produces zero new taint transitions', async () => {
    const { host, T } = await seedCompromiseScene();
    await host.principals.markCompromised('bob' as PrincipalId, T, 'token leaked');

    const first = await propagateCompromiseTaint(
      host,
      'bob' as PrincipalId,
      responder,
    );
    const second = await propagateCompromiseTaint(
      host,
      'bob' as PrincipalId,
      responder,
    );

    expect(first.atomsTainted).toBeGreaterThan(0);
    expect(second.atomsTainted).toBe(0);
  });

  it('non-compromised principal: zero-report no-op', async () => {
    const { host } = await seedCompromiseScene();
    const report = await propagateCompromiseTaint(
      host,
      'alice' as PrincipalId,
      responder,
    );
    expect(report.atomsTainted).toBe(0);
    expect(report.iterations).toBe(0);
  });
});
