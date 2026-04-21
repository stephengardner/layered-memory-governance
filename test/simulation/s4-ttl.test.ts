/**
 * Scenario 4: TTL expiration.
 *
 * Failure-mode coverage: an atom with a finite expires_at must stop
 * participating in canon, search, and promotion at or after its expiry,
 * without being deleted. The store retains it for audit; taint='quarantined'
 * is the exclusion signal that arbitration, promotion, decay, and the
 * canon generator all respect.
 *
 * Timeline:
 *   t0 (clock=0)       seed ephemeral atom, expires_at = t0 + 10 minutes
 *   t1 (advance 5min)  tick() -> atom still clean, still present, canon has it
 *   t2 (advance 6min)  tick() -> atom quarantined, confidence at floor, canon empty
 *   t3 (same clock)    second tick() -> no-op (idempotent)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { renderCanonMarkdown } from '../../src/canon-md/generator.js';
import { LoopRunner } from '../../src/loop/runner.js';
import { ttlExpirePatch } from '../../src/loop/ttl.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 's4-ttl-loop' as PrincipalId;

const FIVE_MIN = 5 * 60 * 1000;
const SIX_MIN = 6 * 60 * 1000;

describe('Scenario 4: TTL expiration', () => {
  it('atom stays clean before expires_at, gets quarantined after', async () => {
    const host = createMemoryHost();

    const start = host.clock.now();
    const startMs = Date.parse(start);
    const expiresAt = new Date(startMs + 10 * 60 * 1000).toISOString() as Time;

    const atom = sampleAtom({
      id: 'ttl-ephemeral-1' as AtomId,
      content: 'Throwaway observation that should expire.',
      type: 'ephemeral',
      layer: 'L2',
      confidence: 0.8,
      expires_at: expiresAt,
      created_at: start as Time,
      last_reinforced_at: start as Time,
    });
    await host.atoms.put(atom);

    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false, // keep the pass focused on decay + TTL
      runL3Promotion: false,
      runCanonApplier: false,
    });

    // --- Before expiry: tick is a no-op, atom remains clean.
    host.clock.advance(FIVE_MIN);
    const r1 = await runner.tick();
    expect(r1.atomsExpired).toBe(0);
    expect(r1.errors).toEqual([]);
    const before = await host.atoms.get(atom.id);
    expect(before?.taint).toBe('clean');

    // --- Past expiry: tick flips taint to quarantined and floors confidence.
    host.clock.advance(SIX_MIN);
    const r2 = await runner.tick();
    expect(r2.atomsExpired).toBe(1);
    expect(r2.errors).toEqual([]);
    const after = await host.atoms.get(atom.id);
    expect(after?.taint).toBe('quarantined');
    expect(after?.confidence).toBeCloseTo(0.01, 4);

    // --- Re-tick: idempotent. No further expirations, no confidence change.
    const r3 = await runner.tick();
    expect(r3.atomsExpired).toBe(0);
    const afterAgain = await host.atoms.get(atom.id);
    expect(afterAgain?.taint).toBe('quarantined');
    expect(afterAgain?.confidence).toBeCloseTo(0.01, 4);
  });

  it('audit log records an atom.expired event with expires_at detail', async () => {
    const host = createMemoryHost();
    const startMs = Date.parse(host.clock.now());
    const expiresAt = new Date(startMs + 60_000).toISOString() as Time;

    await host.atoms.put(sampleAtom({
      id: 'ttl-audit-1' as AtomId,
      content: 'briefly valid fact',
      type: 'ephemeral',
      layer: 'L1',
      expires_at: expiresAt,
      created_at: host.clock.now() as Time,
      last_reinforced_at: host.clock.now() as Time,
    }));

    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: false,
    });
    host.clock.advance(2 * 60_000);
    await runner.tick();

    const audits = await host.auditor.query({ kind: ['atom.expired'] }, 10);
    expect(audits.length).toBe(1);
    expect(audits[0]?.details).toMatchObject({
      layer: 'L1',
      type: 'ephemeral',
    });
    expect(audits[0]?.details['expires_at']).toBe(expiresAt);
  });

  it('quarantined atoms do NOT appear in the rendered canon section', async () => {
    const host = createMemoryHost();
    const startMs = Date.parse(host.clock.now());

    // L3 atom that is quarantined directly (simulates post-TTL state).
    const quarantined = sampleAtom({
      id: 'ttl-canon-quarantined' as AtomId,
      content: 'Expired rule, should not render.',
      type: 'decision',
      layer: 'L3',
      confidence: 0.01,
      taint: 'quarantined',
      expires_at: new Date(startMs - 60_000).toISOString() as Time,
    });
    // L3 atom that is clean and should render.
    const live = sampleAtom({
      id: 'ttl-canon-live' as AtomId,
      content: 'Live durable rule.',
      type: 'decision',
      layer: 'L3',
      confidence: 0.95,
      taint: 'clean',
    });
    await host.atoms.put(quarantined);
    await host.atoms.put(live);

    const atoms = [quarantined, live];
    const rendered = renderCanonMarkdown(atoms, { now: host.clock.now() });
    expect(rendered.toLowerCase()).toContain('live durable rule');
    expect(rendered.toLowerCase()).not.toContain('expired rule');
  });

  it('decay pass does not refresh a quarantined atom off the floor', async () => {
    const host = createMemoryHost();
    const startMs = Date.parse(host.clock.now());

    await host.atoms.put(sampleAtom({
      id: 'ttl-decay-1' as AtomId,
      content: 'stale data',
      type: 'ephemeral',
      layer: 'L1',
      confidence: 0.01, // already at floor
      taint: 'quarantined',
      expires_at: new Date(startMs - 60_000).toISOString() as Time,
      created_at: host.clock.now() as Time,
      last_reinforced_at: host.clock.now() as Time,
    }));

    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: false,
    });
    host.clock.advance(30 * 24 * 60 * 60 * 1000); // 30 days later
    const r = await runner.tick();
    expect(r.atomsDecayed).toBe(0); // decay skipped this atom
    const frozen = await host.atoms.get('ttl-decay-1' as AtomId);
    expect(frozen?.confidence).toBeCloseTo(0.01, 4);
    expect(frozen?.taint).toBe('quarantined');
  });

  it('ttlExpirePatch is a pure null-or-patch function', () => {
    const base = sampleAtom({ id: 'pure-1' as AtomId });
    // No expires_at: null.
    expect(ttlExpirePatch(base, Date.now())).toBeNull();
    // expires_at in future: null.
    const future = new Date(Date.now() + 60_000).toISOString() as Time;
    expect(ttlExpirePatch({ ...base, expires_at: future }, Date.now())).toBeNull();
    // expires_at in past, clean: patch.
    const past = new Date(Date.now() - 60_000).toISOString() as Time;
    const p = ttlExpirePatch({ ...base, expires_at: past }, Date.now());
    expect(p).not.toBeNull();
    expect(p?.taint).toBe('quarantined');
    expect(p?.confidence).toBeCloseTo(0.01, 4);
    // Already quarantined: null (idempotent).
    expect(
      ttlExpirePatch({ ...base, expires_at: past, taint: 'quarantined' }, Date.now()),
    ).toBeNull();
  });
});
