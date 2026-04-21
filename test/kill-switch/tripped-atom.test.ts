/**
 * Unit tests for mkKillSwitchTrippedAtom + mkKillSwitchTrippedAtomId.
 *
 * Integration-level behaviour (runActor writing the atom on halt)
 * lives in test/actors/run-actor.test.ts so the two concerns stay
 * separable.
 */

import { describe, expect, it } from 'vitest';
import {
  mkKillSwitchTrippedAtom,
  mkKillSwitchTrippedAtomId,
} from '../../src/kill-switch/tripped-atom.js';
import type { PrincipalId, Time } from '../../src/substrate/types.js';

const PRINCIPAL = 'code-author' as PrincipalId;

describe('mkKillSwitchTrippedAtomId', () => {
  it('embeds actor, principal, ISO timestamp, and nonce so every trip is distinct', () => {
    // Supply an explicit nonce to pin the exact id in the assertion.
    const id = mkKillSwitchTrippedAtomId('pr-landing', PRINCIPAL, '2026-04-21T10:00:00.000Z' as Time, 'abc123');
    expect(id).toBe('kill-switch-tripped-pr-landing-code-author-2026-04-21T10:00:00.000Z-abc123');
  });

  it('distinct timestamps produce distinct ids', () => {
    const a = mkKillSwitchTrippedAtomId('x', PRINCIPAL, '2026-04-21T10:00:00.000Z' as Time, 'aaaaaa');
    const b = mkKillSwitchTrippedAtomId('x', PRINCIPAL, '2026-04-21T10:00:00.001Z' as Time, 'aaaaaa');
    expect(a).not.toBe(b);
  });

  it('identical timestamps still produce distinct ids via random nonce', () => {
    // Two calls at the SAME ISO timestamp (simulates a coarse
    // host clock or a fixed test clock colliding). The nonce
    // suffix keeps ids distinct so the second durable write
    // does not hit a duplicate-key on the atom store.
    const when = '2026-04-21T10:00:00.000Z' as Time;
    const a = mkKillSwitchTrippedAtomId('x', PRINCIPAL, when);
    const b = mkKillSwitchTrippedAtomId('x', PRINCIPAL, when);
    expect(a).not.toBe(b);
  });

  it('explicit nonce is reproducible for test assertions', () => {
    const when = '2026-04-21T10:00:00.000Z' as Time;
    const a = mkKillSwitchTrippedAtomId('x', PRINCIPAL, when, 'deadbe');
    const b = mkKillSwitchTrippedAtomId('x', PRINCIPAL, when, 'deadbe');
    expect(a).toBe(b);
  });
});

describe('mkKillSwitchTrippedAtom', () => {
  it('builds a type=observation, layer=L1 atom with kind=kill-switch-tripped', () => {
    const atom = mkKillSwitchTrippedAtom({
      actor: 'pr-landing',
      principalId: PRINCIPAL,
      trigger: 'stop-sentinel',
      trippedAt: '2026-04-21T10:00:00.000Z' as Time,
      iteration: 3,
      phase: 'apply',
      sessionId: 'session-abc',
      inFlightTool: 'gh-post-comment',
    });
    expect(atom.type).toBe('observation');
    expect(atom.layer).toBe('L1');
    expect(atom.metadata).toMatchObject({
      kind: 'kill-switch-tripped',
      actor: 'pr-landing',
      principal_id: 'code-author',
      tripped_by: 'stop-sentinel',
      tripped_at: '2026-04-21T10:00:00.000Z',
      iteration: 3,
      phase: 'apply',
      in_flight_tool: 'gh-post-comment',
    });
    expect(atom.confidence).toBe(1.0);
    expect(atom.principal_id).toBe(PRINCIPAL);
    expect(atom.taint).toBe('clean');
  });

  it('stamps session_id into provenance.source per ADR', () => {
    const atom = mkKillSwitchTrippedAtom({
      actor: 'pr-landing',
      principalId: PRINCIPAL,
      trigger: 'parent-signal',
      trippedAt: '2026-04-21T10:00:00.000Z' as Time,
      iteration: 1,
      phase: 'between-iterations',
      sessionId: 'session-xyz',
    });
    expect(atom.provenance.kind).toBe('agent-observed');
    expect(atom.provenance.source.session_id).toBe('session-xyz');
    expect(atom.provenance.source.tool).toBe('kill-switch-revocation');
    expect(atom.provenance.source.agent_id).toBe('code-author');
    expect(atom.provenance.derived_from).toEqual([]);
  });

  it('omits in_flight_tool from metadata when not supplied', () => {
    const atom = mkKillSwitchTrippedAtom({
      actor: 'pr-landing',
      principalId: PRINCIPAL,
      trigger: 'stop-sentinel',
      trippedAt: '2026-04-21T10:00:00.000Z' as Time,
      iteration: 1,
      phase: 'between-iterations',
      sessionId: 'session-abc',
    });
    expect(atom.metadata).not.toHaveProperty('in_flight_tool');
    expect(atom.metadata).not.toHaveProperty('revocation_notes');
  });

  it('atom id matches the stand-alone helper when the same nonce is supplied', () => {
    const when = '2026-04-21T10:00:00.000Z' as Time;
    const atom = mkKillSwitchTrippedAtom({
      actor: 'pr-landing',
      principalId: PRINCIPAL,
      trigger: 'stop-sentinel',
      trippedAt: when,
      iteration: 1,
      phase: 'between-iterations',
      sessionId: 'session-abc',
      idNonce: 'abc123',
    });
    expect(atom.id).toBe(mkKillSwitchTrippedAtomId('pr-landing', PRINCIPAL, when, 'abc123'));
  });

  it('same inputs across two atom builds still produce distinct ids (random nonce path)', () => {
    const when = '2026-04-21T10:00:00.000Z' as Time;
    const common = {
      actor: 'pr-landing',
      principalId: PRINCIPAL,
      trigger: 'stop-sentinel' as const,
      trippedAt: when,
      iteration: 1,
      phase: 'between-iterations' as const,
      sessionId: 'session-abc',
    };
    const a = mkKillSwitchTrippedAtom(common);
    const b = mkKillSwitchTrippedAtom(common);
    expect(a.id).not.toBe(b.id);
  });

  it('content text is human-readable with trigger + iteration + phase', () => {
    const atom = mkKillSwitchTrippedAtom({
      actor: 'pr-landing',
      principalId: PRINCIPAL,
      trigger: 'parent-signal',
      trippedAt: '2026-04-21T10:00:00.000Z' as Time,
      iteration: 5,
      phase: 'apply',
      sessionId: 'session-abc',
      inFlightTool: 'gh-merge',
      revocationNotes: 'operator STOP during merge sequence',
    });
    expect(atom.content).toContain('kill-switch tripped for pr-landing');
    expect(atom.content).toContain('trigger: parent-signal');
    expect(atom.content).toContain('iteration: 5');
    expect(atom.content).toContain('phase: apply');
    expect(atom.content).toContain('in_flight_tool: gh-merge');
    expect(atom.content).toContain('operator STOP during merge sequence');
  });
});
