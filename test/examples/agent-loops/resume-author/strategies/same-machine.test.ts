import { describe, it, expect } from 'vitest';
import { SameMachineCliResumeStrategy } from '../../../../../examples/agent-loops/resume-author/strategies/same-machine.js';
import type { CandidateSession, ResumeContext } from '../../../../../examples/agent-loops/resume-author/types.js';
import type { Workspace } from '../../../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../../../src/substrate/interface.js';
import type { AtomId } from '../../../../../src/substrate/types.js';

const stubWs = { id: 'ws-1', path: '/tmp/ws', baseRef: 'main' } as Workspace;
const stubHost = {} as unknown as Host;

function makeCtx(candidates: ReadonlyArray<Partial<CandidateSession>>): ResumeContext {
  return {
    candidateSessions: candidates.map((c, i) => ({
      sessionAtomId: (c.sessionAtomId ?? `s${i}`) as AtomId,
      resumableSessionId: c.resumableSessionId ?? `uuid-${i}`,
      startedAt: c.startedAt ?? new Date().toISOString(),
      extra: c.extra ?? {},
      adapterId: c.adapterId ?? 'claude-code-agent-loop',
    })),
    workspace: stubWs,
    host: stubHost,
  };
}

const oneHourAgo = () => new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
const nineHoursAgo = () => new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();

describe('SameMachineCliResumeStrategy', () => {
  it('returns null when no candidates', async () => {
    const ctx = makeCtx([]);
    const s = new SameMachineCliResumeStrategy();
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('returns the freshest claude-code candidate within maxStaleHours', async () => {
    const ctx = makeCtx([
      { adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo(), resumableSessionId: 'stale-uuid', sessionAtomId: 'a' as AtomId },
      { adapterId: 'claude-code-agent-loop', startedAt: oneHourAgo(), resumableSessionId: 'fresh-uuid', sessionAtomId: 'b' as AtomId },
    ]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    const r = await s.findResumableSession(ctx);
    expect(r?.resumableSessionId).toBe('fresh-uuid');
    expect(r?.strategyName).toBe('same-machine-cli');
    expect(r?.resumedFromSessionAtomId).toBe('b');
    expect(r?.preparation).toBeUndefined();  // same-machine needs no preparation
  });

  it('skips non-claude-code adapters', async () => {
    const ctx = makeCtx([{ adapterId: 'langgraph', startedAt: oneHourAgo() }]);
    const s = new SameMachineCliResumeStrategy();
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('skips all-stale candidates', async () => {
    const ctx = makeCtx([{ adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo() }]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('default maxStaleHours is 8', async () => {
    const ctx = makeCtx([
      { adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo(), resumableSessionId: 'stale' },
    ]);
    const s = new SameMachineCliResumeStrategy();  // no opts
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('respects custom maxStaleHours via constructor opts', async () => {
    const ctx = makeCtx([
      { adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo(), resumableSessionId: 'mine' },
    ]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 24 });
    const r = await s.findResumableSession(ctx);
    expect(r?.resumableSessionId).toBe('mine');
  });
});
