import { describe, it, expect } from 'vitest';
import {
  clampLimit,
  clampWindowHours,
  listRecentResets,
  listRecentResumed,
  summarizeResumeStats,
} from './resume-audit';
import type { ResumeAuditSourceAtom } from './resume-audit-types';
import {
  RESUME_AUDIT_DEFAULT_LIMIT,
  RESUME_AUDIT_DEFAULT_WINDOW_HOURS,
  RESUME_AUDIT_MAX_LIST_ITEMS,
  RESUME_AUDIT_MAX_WINDOW_HOURS,
  RESUME_AUDIT_MIN_WINDOW_HOURS,
} from './resume-audit-types';

/*
 * Pure-function tests for the resume-audit projection helpers. The
 * server's HTTP routes are thin wrappers around these; if these pass
 * and the route handlers delegate correctly, we have full coverage of
 * the read + group logic without a TCP socket.
 *
 * Determinism: all tests pin `now` explicitly so no system clock
 * dependence creeps in.
 */

const NOW = Date.parse('2026-05-05T12:00:00.000Z');

function sessionAtom(opts: {
  id: string;
  principal: string;
  createdAt: string;
  resumeAttempt?: string;
  resumeStrategy?: string;
  resumedFrom?: string;
  modelId?: string;
  adapterId?: string;
  workspaceId?: string;
  taint?: string;
  superseded?: boolean;
  noExtra?: boolean;
}): ResumeAuditSourceAtom {
  const extra: Record<string, unknown> = {};
  if (opts.resumeAttempt) extra['resume_attempt'] = opts.resumeAttempt;
  if (opts.resumeStrategy) extra['resume_strategy_used'] = opts.resumeStrategy;
  if (opts.resumedFrom) extra['resumed_from_atom_id'] = opts.resumedFrom;
  return {
    id: opts.id,
    type: 'agent-session',
    layer: 'L0',
    content: `session ${opts.id}`,
    principal_id: opts.principal,
    created_at: opts.createdAt,
    taint: opts.taint ?? 'clean',
    superseded_by: opts.superseded ? ['next-session'] : [],
    metadata: {
      session_id: opts.id,
      started_at: opts.createdAt,
      workspace_id: opts.workspaceId ?? 'C:/work',
      agent_session: {
        model_id: opts.modelId ?? 'claude-opus-4-7',
        adapter_id: opts.adapterId ?? 'claude-code-adapter',
        workspace_id: opts.workspaceId ?? 'C:/work',
        started_at: opts.createdAt,
        terminal_state: 'completed',
        replay_tier: 'session',
        budget_consumed: { turns: 0, wall_clock_ms: 0 },
        ...(opts.noExtra ? {} : { extra }),
      },
    },
  };
}

function resetAtom(opts: {
  id: string;
  createdAt: string;
  principal: string;
  resetPrincipal?: string;
  workItem?: Record<string, unknown>;
  reason?: string;
}): ResumeAuditSourceAtom {
  return {
    id: opts.id,
    type: 'resume-reset',
    layer: 'L0',
    content: `reset ${opts.id}`,
    principal_id: opts.principal,
    created_at: opts.createdAt,
    taint: 'clean',
    metadata: {
      reset: {
        principal_id: opts.resetPrincipal ?? opts.principal,
        work_item_key: opts.workItem ?? { kind: 'intent', intentAtomId: 'intent-abc' },
        reason: opts.reason ?? 'operator wanted fresh start',
      },
    },
  };
}

function consumedAtom(opts: { id: string; resetAtomId: string; createdAt: string }): ResumeAuditSourceAtom {
  return {
    id: opts.id,
    type: 'resume-reset-consumed',
    layer: 'L0',
    content: `consumed ${opts.resetAtomId}`,
    principal_id: 'cto-actor',
    created_at: opts.createdAt,
    taint: 'clean',
    metadata: {
      reset: { consumed_atom_id: opts.resetAtomId },
    },
  };
}

// ---------------------------------------------------------------------------
// clampWindowHours / clampLimit guard tests.
// ---------------------------------------------------------------------------

describe('clampWindowHours', () => {
  it('returns the default when input is null/undefined/NaN', () => {
    expect(clampWindowHours(null)).toBe(RESUME_AUDIT_DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(undefined)).toBe(RESUME_AUDIT_DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(NaN)).toBe(RESUME_AUDIT_DEFAULT_WINDOW_HOURS);
  });

  it('clamps below the minimum', () => {
    expect(clampWindowHours(0)).toBe(RESUME_AUDIT_MIN_WINDOW_HOURS);
    expect(clampWindowHours(-1)).toBe(RESUME_AUDIT_MIN_WINDOW_HOURS);
  });

  it('clamps above the maximum', () => {
    expect(clampWindowHours(10_000)).toBe(RESUME_AUDIT_MAX_WINDOW_HOURS);
  });

  it('returns the value when in range', () => {
    expect(clampWindowHours(48)).toBe(48);
    expect(clampWindowHours(1)).toBe(1);
    expect(clampWindowHours(720)).toBe(720);
  });
});

describe('clampLimit', () => {
  it('returns the default when input is null/undefined', () => {
    expect(clampLimit(null)).toBe(RESUME_AUDIT_DEFAULT_LIMIT);
    expect(clampLimit(undefined)).toBe(RESUME_AUDIT_DEFAULT_LIMIT);
  });

  it('floors below 1 to 1', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-50)).toBe(1);
  });

  it('clamps above the max', () => {
    expect(clampLimit(10_000)).toBe(RESUME_AUDIT_MAX_LIST_ITEMS);
  });

  it('floors fractional inputs', () => {
    expect(clampLimit(7.9)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// summarizeResumeStats: per-principal projection.
// ---------------------------------------------------------------------------

describe('summarizeResumeStats', () => {
  it('returns empty principals on an empty store', () => {
    const r = summarizeResumeStats([], NOW);
    expect(r.principals).toEqual([]);
    expect(r.total_sessions).toBe(0);
    expect(r.total_resume_attempts).toBe(0);
    expect(r.total_resumed).toBe(0);
    expect(r.window_hours).toBe(RESUME_AUDIT_DEFAULT_WINDOW_HOURS);
    expect(r.window_start_at).toBe(new Date(NOW - 24 * 3600 * 1000).toISOString());
    expect(r.generated_at).toBe(new Date(NOW).toISOString());
  });

  it('counts sessions per principal and computes the resume ratio', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's1', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed', resumeStrategy: 'same-machine-cli', resumedFrom: 'agent-session-prev-1' }),
      sessionAtom({ id: 's2', principal: 'cto-actor', createdAt: '2026-05-05T10:00:00.000Z', resumeAttempt: 'resumed', resumedFrom: 'agent-session-prev-2' }),
      sessionAtom({ id: 's3', principal: 'cto-actor', createdAt: '2026-05-05T09:00:00.000Z', resumeAttempt: 'fresh-spawn-no-strategy' }),
      // No `extra.resume_attempt`: counts toward total_sessions but not resume_attempts.
      sessionAtom({ id: 's4', principal: 'code-author', createdAt: '2026-05-05T11:30:00.000Z' }),
      // Different principal with one resumed.
      sessionAtom({ id: 's5', principal: 'code-author', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = summarizeResumeStats(atoms, NOW);
    expect(r.total_sessions).toBe(5);
    expect(r.total_resume_attempts).toBe(4);
    expect(r.total_resumed).toBe(3);

    expect(r.principals).toHaveLength(2);
    const cto = r.principals.find((p) => p.principal_id === 'cto-actor');
    expect(cto).toBeDefined();
    expect(cto!.total_sessions).toBe(3);
    expect(cto!.resume_attempts).toBe(3);
    expect(cto!.resumed_count).toBe(2);
    expect(cto!.fresh_spawn_count).toBe(1);
    expect(cto!.ratio).toBeCloseTo(2 / 3, 5);
    expect(cto!.last_session_at).toBe('2026-05-05T11:00:00.000Z');

    const ca = r.principals.find((p) => p.principal_id === 'code-author');
    expect(ca!.total_sessions).toBe(2);
    expect(ca!.resume_attempts).toBe(1);
    expect(ca!.resumed_count).toBe(1);
    expect(ca!.ratio).toBe(1.0);
  });

  it('returns null ratio for a principal with no resume telemetry', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's1', principal: 'auditor-actor', createdAt: '2026-05-05T11:00:00.000Z' }),
      sessionAtom({ id: 's2', principal: 'auditor-actor', createdAt: '2026-05-05T10:00:00.000Z', noExtra: true }),
    ];
    const r = summarizeResumeStats(atoms, NOW);
    expect(r.principals).toHaveLength(1);
    expect(r.principals[0]!.total_sessions).toBe(2);
    expect(r.principals[0]!.resume_attempts).toBe(0);
    expect(r.principals[0]!.ratio).toBeNull();
  });

  it('honors the time window: sessions older than the cutoff are excluded', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      // 2 hours ago: in the 24h window.
      sessionAtom({ id: 's-recent', principal: 'cto-actor', createdAt: '2026-05-05T10:00:00.000Z', resumeAttempt: 'resumed' }),
      // 30 hours ago: outside the 24h window.
      sessionAtom({ id: 's-old', principal: 'cto-actor', createdAt: '2026-05-04T06:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = summarizeResumeStats(atoms, NOW, 24);
    expect(r.total_sessions).toBe(1);
    expect(r.principals).toHaveLength(1);
    expect(r.principals[0]!.total_sessions).toBe(1);
  });

  it('honors a tighter window override', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's-1h', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
      sessionAtom({ id: 's-3h', principal: 'cto-actor', createdAt: '2026-05-05T09:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = summarizeResumeStats(atoms, NOW, 2);
    expect(r.window_hours).toBe(2);
    expect(r.total_sessions).toBe(1);
  });

  it('skips superseded and tainted atoms', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's-tainted', principal: 'cto-actor', createdAt: '2026-05-05T10:00:00.000Z', resumeAttempt: 'resumed', taint: 'tainted' }),
      sessionAtom({ id: 's-superseded', principal: 'cto-actor', createdAt: '2026-05-05T10:00:00.000Z', resumeAttempt: 'resumed', superseded: true }),
      sessionAtom({ id: 's-clean', principal: 'cto-actor', createdAt: '2026-05-05T10:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = summarizeResumeStats(atoms, NOW);
    expect(r.total_sessions).toBe(1);
  });

  it('treats unknown resume_attempt strings as the unknown sentinel', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's-weird', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'magic-future-mode' }),
    ];
    const r = summarizeResumeStats(atoms, NOW);
    expect(r.total_sessions).toBe(1);
    expect(r.total_resume_attempts).toBe(0);
  });

  it('orders principals by total_sessions DESC then id ASC', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's1', principal: 'zeta', createdAt: '2026-05-05T11:00:00.000Z' }),
      sessionAtom({ id: 's2', principal: 'alpha', createdAt: '2026-05-05T11:00:00.000Z' }),
      sessionAtom({ id: 's3', principal: 'alpha', createdAt: '2026-05-05T10:00:00.000Z' }),
      sessionAtom({ id: 's4', principal: 'mu', createdAt: '2026-05-05T11:00:00.000Z' }),
    ];
    const r = summarizeResumeStats(atoms, NOW);
    expect(r.principals.map((p) => p.principal_id)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('clamps a malformed window_hours via the helper', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = summarizeResumeStats(atoms, NOW, 99_999);
    expect(r.window_hours).toBe(RESUME_AUDIT_MAX_WINDOW_HOURS);
  });
});

// ---------------------------------------------------------------------------
// listRecentResumed: recent resume successes.
// ---------------------------------------------------------------------------

describe('listRecentResumed', () => {
  it('returns sessions with resume_attempt=resumed in DESC order', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's1', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed', resumeStrategy: 'same-machine-cli', resumedFrom: 'agent-session-prev-1' }),
      sessionAtom({ id: 's2', principal: 'code-author', createdAt: '2026-05-05T10:30:00.000Z', resumeAttempt: 'resumed', resumeStrategy: 'blob-shipped', resumedFrom: 'agent-session-prev-2' }),
      sessionAtom({ id: 's3', principal: 'cto-actor', createdAt: '2026-05-05T09:00:00.000Z', resumeAttempt: 'fresh-spawn-no-strategy' }),
    ];
    const r = listRecentResumed(atoms, NOW);
    expect(r.sessions.map((s) => s.session_atom_id)).toEqual(['s1', 's2']);
    expect(r.sessions[0]!.resume_strategy_used).toBe('same-machine-cli');
    expect(r.sessions[0]!.resumed_from_atom_id).toBe('agent-session-prev-1');
    expect(r.sessions[0]!.model_id).toBe('claude-opus-4-7');
    expect(r.generated_at).toBe(new Date(NOW).toISOString());
  });

  it('excludes fresh-spawn sessions', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's-fresh-1', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'fresh-spawn-fallback' }),
      sessionAtom({ id: 's-fresh-2', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'fresh-spawn-policy-disabled' }),
      sessionAtom({ id: 's-fresh-3', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'fresh-spawn-reset' }),
    ];
    const r = listRecentResumed(atoms, NOW);
    expect(r.sessions).toEqual([]);
  });

  it('respects the limit cap', () => {
    const atoms: ResumeAuditSourceAtom[] = [];
    for (let i = 0; i < 60; i++) {
      atoms.push(
        sessionAtom({
          id: `s${i}`,
          principal: 'cto-actor',
          createdAt: `2026-05-05T${String(11 - (i % 11)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00.000Z`,
          resumeAttempt: 'resumed',
        }),
      );
    }
    const r = listRecentResumed(atoms, NOW, 5);
    expect(r.sessions.length).toBe(5);
  });

  it('breaks tied timestamps deterministically by atom id', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's-z', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
      sessionAtom({ id: 's-a', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
      sessionAtom({ id: 's-m', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = listRecentResumed(atoms, NOW);
    expect(r.sessions.map((s) => s.session_atom_id)).toEqual(['s-a', 's-m', 's-z']);
  });

  it('skips superseded and tainted atoms', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      sessionAtom({ id: 's-tainted', principal: 'cto-actor', createdAt: '2026-05-05T10:00:00.000Z', resumeAttempt: 'resumed', taint: 'tainted' }),
      sessionAtom({ id: 's-clean', principal: 'cto-actor', createdAt: '2026-05-05T11:00:00.000Z', resumeAttempt: 'resumed' }),
    ];
    const r = listRecentResumed(atoms, NOW);
    expect(r.sessions.map((s) => s.session_atom_id)).toEqual(['s-clean']);
  });
});

// ---------------------------------------------------------------------------
// listRecentResets: recent operator-reset signals.
// ---------------------------------------------------------------------------

describe('listRecentResets', () => {
  it('returns resume-reset atoms in DESC order with consumed flag false by default', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      resetAtom({ id: 'rr-1', createdAt: '2026-05-05T11:00:00.000Z', principal: 'apex-agent', resetPrincipal: 'cto-actor' }),
      resetAtom({ id: 'rr-2', createdAt: '2026-05-05T10:00:00.000Z', principal: 'apex-agent', resetPrincipal: 'code-author' }),
    ];
    const r = listRecentResets(atoms, NOW);
    expect(r.resets).toHaveLength(2);
    expect(r.resets[0]!.atom_id).toBe('rr-1');
    expect(r.resets[0]!.reset_principal_id).toBe('cto-actor');
    expect(r.resets[0]!.consumed).toBe(false);
    expect(r.resets[0]!.work_item_kind).toBe('intent');
    expect(r.resets[0]!.work_item_summary).toContain('intent');
  });

  it('marks consumed when a resume-reset-consumed atom references the reset', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      resetAtom({ id: 'rr-consumed', createdAt: '2026-05-05T11:00:00.000Z', principal: 'apex-agent' }),
      resetAtom({ id: 'rr-pending', createdAt: '2026-05-05T10:00:00.000Z', principal: 'apex-agent' }),
      consumedAtom({ id: 'consume-1', resetAtomId: 'rr-consumed', createdAt: '2026-05-05T11:30:00.000Z' }),
    ];
    const r = listRecentResets(atoms, NOW);
    const consumed = r.resets.find((x) => x.atom_id === 'rr-consumed');
    const pending = r.resets.find((x) => x.atom_id === 'rr-pending');
    expect(consumed!.consumed).toBe(true);
    expect(pending!.consumed).toBe(false);
  });

  it('describes work items for known kinds', () => {
    const atoms: ResumeAuditSourceAtom[] = [
      resetAtom({ id: 'rr-pr', createdAt: '2026-05-05T11:00:00.000Z', principal: 'apex-agent', workItem: { kind: 'pr', owner: 'foo', repo: 'bar', number: 42 } }),
      resetAtom({ id: 'rr-plan', createdAt: '2026-05-05T10:00:00.000Z', principal: 'apex-agent', workItem: { kind: 'plan', planAtomId: 'plan-abc' } }),
      resetAtom({ id: 'rr-pipe', createdAt: '2026-05-05T09:00:00.000Z', principal: 'apex-agent', workItem: { kind: 'pipeline-stage', pipelineId: 'pipeline-x', stageName: 'spec' } }),
    ];
    const r = listRecentResets(atoms, NOW);
    expect(r.resets[0]!.work_item_summary).toBe('PR foo/bar#42');
    expect(r.resets[1]!.work_item_summary).toBe('plan plan-abc');
    expect(r.resets[2]!.work_item_summary).toBe('pipeline-x / spec');
  });

  it('respects the limit cap', () => {
    const atoms: ResumeAuditSourceAtom[] = [];
    for (let i = 0; i < 75; i++) {
      atoms.push(resetAtom({ id: `rr-${i}`, createdAt: `2026-05-05T${String(11 - (i % 11)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00.000Z`, principal: 'apex-agent' }));
    }
    const r = listRecentResets(atoms, NOW, 10);
    expect(r.resets.length).toBe(10);
  });

  it('returns an empty list when no reset atoms exist', () => {
    const r = listRecentResets([], NOW);
    expect(r.resets).toEqual([]);
    expect(r.generated_at).toBe(new Date(NOW).toISOString());
  });
});
