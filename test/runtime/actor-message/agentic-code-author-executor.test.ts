/**
 * Unit tests for buildAgenticCodeAuthorExecutor.
 *
 * The agentic executor composes substrate seams (AgentLoopAdapter,
 * WorkspaceProvider, BlobStore, Redactor) plus the per-actor policy
 * resolvers into a CodeAuthorExecutor implementation. These tests pin
 * the factory shape + the failure-mapping contract.
 */

import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { buildAgenticCodeAuthorExecutor } from '../../../src/runtime/actor-message/agentic-code-author-executor.js';
import type { AtomId, PrincipalId } from '../../../src/substrate/types.js';
import type { AgentLoopAdapter } from '../../../src/substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../../src/substrate/workspace-provider.js';
import type { BlobStore } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { GhClient } from '../../../src/external/github/index.js';

describe('buildAgenticCodeAuthorExecutor', () => {
  it('returns an object with an execute() method', () => {
    const host = createMemoryHost();
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: {} as AgentLoopAdapter,
      workspaceProvider: {} as WorkspaceProvider,
      blobStore: {} as BlobStore,
      redactor: {} as Redactor,
      ghClient: {} as GhClient,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'claude-opus-4-7',
    });
    expect(typeof executor.execute).toBe('function');
    // Suppress unused-import warnings on AtomId; the type is referenced
    // by failure-mapping tests in the same file in Task 3.
    void (null as AtomId | null);
  });
});
