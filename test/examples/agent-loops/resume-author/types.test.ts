import { describe, it, expect } from 'vitest';
import type {
  SessionResumeStrategy,
  CandidateSession,
  ResolvedSession,
  ResumeContext,
} from '../../../../examples/agent-loops/resume-author/types.js';
import type { Workspace } from '../../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../../src/substrate/interface.js';
import type { AtomId } from '../../../../src/substrate/types.js';

describe('SessionResumeStrategy types', () => {
  it('CandidateSession shape', () => {
    const c: CandidateSession = {
      sessionAtomId: 'a' as AtomId,
      resumableSessionId: 'uuid-001',
      startedAt: '2026-04-25T00:00:00.000Z',
      extra: {},
      adapterId: 'claude-code-agent-loop',
    };
    expect(c.adapterId).toBe('claude-code-agent-loop');
  });
  it('ResolvedSession shape with preparation', () => {
    const r: ResolvedSession = {
      resumableSessionId: 'uuid-001',
      resumedFromSessionAtomId: 'a' as AtomId,
      strategyName: 'same-machine-cli',
      preparation: async () => {},
    };
    expect(typeof r.preparation).toBe('function');
  });
  it('SessionResumeStrategy contract (compile-time only)', () => {
    const s: SessionResumeStrategy = {
      name: 'stub',
      async findResumableSession() { return null; },
    };
    expect(s.name).toBe('stub');
  });
  it('ResumeContext does NOT contain actor-specific fields', () => {
    // Pure type-shape test: the type must NOT have prObservationAtomId or any PR-specific field.
    // Compile-time check via @ts-expect-error.
    // @ts-expect-error -- ResumeContext should not have prObservationAtomId
    const _: ResumeContext = { candidateSessions: [], workspace: {} as Workspace, host: {} as unknown as Host, prObservationAtomId: 'x' };
    void _;
  });
});
