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

describe('buildDefaultRegistry', () => {
  it('registers cto-actor and code-author descriptors', () => {
    const host = createMemoryHost();
    const registry = buildDefaultRegistry(host);
    expect(registry.get(CTO_ACTOR_PRINCIPAL_ID)).toBe(ctoActorResumeStrategyDescriptor);
    expect(registry.get(CODE_AUTHOR_PRINCIPAL_ID)).toBe(codeAuthorResumeStrategyDescriptor);
  });

  it('returns a fresh registry on every call (no module-level singleton state)', () => {
    const host = createMemoryHost();
    const a = buildDefaultRegistry(host);
    const b = buildDefaultRegistry(host);
    expect(a).not.toBe(b);
    // Both populated independently.
    expect(a.get(CTO_ACTOR_PRINCIPAL_ID)).toBe(ctoActorResumeStrategyDescriptor);
    expect(b.get(CTO_ACTOR_PRINCIPAL_ID)).toBe(ctoActorResumeStrategyDescriptor);
  });
});
