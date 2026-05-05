import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import {
  buildDefaultRegistry,
} from '../../../../examples/agent-loops/resume-author/default-registry.js';
import {
  CTO_ACTOR_PRINCIPAL_ID,
  ctoActorResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/cto-actor-strategy.js';
import {
  CODE_AUTHOR_PRINCIPAL_ID,
  codeAuthorResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/code-author-strategy.js';
import {
  PR_FIX_ACTOR_PRINCIPAL_ID,
  prFixActorResumeStrategyDescriptor,
} from '../../../../examples/agent-loops/resume-author/pr-fix-actor-strategy.js';

describe('buildDefaultRegistry', () => {
  it('registers cto-actor, code-author, and pr-fix-actor descriptors', () => {
    const host = createMemoryHost();
    const registry = buildDefaultRegistry(host);
    expect(registry.get(CTO_ACTOR_PRINCIPAL_ID)).toBe(ctoActorResumeStrategyDescriptor);
    expect(registry.get(CODE_AUTHOR_PRINCIPAL_ID)).toBe(codeAuthorResumeStrategyDescriptor);
    expect(registry.get(PR_FIX_ACTOR_PRINCIPAL_ID)).toBe(prFixActorResumeStrategyDescriptor);
  });

  it('returns a fresh registry on every call (no module-level singleton state)', () => {
    const host = createMemoryHost();
    const a = buildDefaultRegistry(host);
    const b = buildDefaultRegistry(host);
    expect(a).not.toBe(b);
    // Both populated independently.
    expect(a.get(CTO_ACTOR_PRINCIPAL_ID)).toBe(ctoActorResumeStrategyDescriptor);
    expect(b.get(CTO_ACTOR_PRINCIPAL_ID)).toBe(ctoActorResumeStrategyDescriptor);
    expect(a.get(PR_FIX_ACTOR_PRINCIPAL_ID)).toBe(prFixActorResumeStrategyDescriptor);
    expect(b.get(PR_FIX_ACTOR_PRINCIPAL_ID)).toBe(prFixActorResumeStrategyDescriptor);
  });
});
