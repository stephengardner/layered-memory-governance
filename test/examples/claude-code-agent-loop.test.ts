import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { ClaudeCodeAgentLoopSkeleton } from '../../examples/agent-loops/claude-code/index.js';
import { RegexRedactor } from '../../examples/redactors/regex-default/index.js';
import { FileBlobStore } from '../../examples/blob-stores/file/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../../src/substrate/workspace-provider.js';
import type { AtomId, PrincipalId } from '../../src/substrate/types.js';
import { defaultBudgetCap } from '../../src/substrate/agent-budget.js';
import { runAgentLoopContract } from '../substrate/agent-loop-contract.test.js';

describe('ClaudeCodeAgentLoopSkeleton', () => {
  it('emits one session + one turn atom on a basic run', async () => {
    const host = createMemoryHost();
    const scratch = await mkdtemp(join(tmpdir(), 'lag-loop-test-'));
    try {
      const blobStore = new FileBlobStore(scratch);
      const workspace: Workspace = { id: 'ws-1', path: scratch, baseRef: 'main' };
      const adapter = new ClaudeCodeAgentLoopSkeleton();
      const result = await adapter.run({
        host,
        principal: 'cto-actor' as PrincipalId,
        workspace,
        task: { planAtomId: 'plan-test' as AtomId, questionPrompt: 'tiny readme update' },
        budget: defaultBudgetCap(),
        toolPolicy: { disallowedTools: [] },
        redactor: new RegexRedactor(),
        blobStore,
        replayTier: 'content-addressed',
        blobThreshold: 4096,
        correlationId: 'corr-test',
      });
      expect(result.kind).toBe('completed');
      expect(result.turnAtomIds.length).toBeGreaterThanOrEqual(1);
      const session = await host.atoms.get(result.sessionAtomId);
      expect(session?.type).toBe('agent-session');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('redacts a planted secret from the turn atom payload', async () => {
    const host = createMemoryHost();
    const scratch = await mkdtemp(join(tmpdir(), 'lag-loop-test-'));
    try {
      const blobStore = new FileBlobStore(scratch);
      const workspace: Workspace = { id: 'ws-2', path: scratch, baseRef: 'main' };
      const adapter = new ClaudeCodeAgentLoopSkeleton({
        // For test determinism, make the stub LLM emit a planted secret-shape.
        stubResponse: 'I see token AKIAIOSFODNN7EXAMPLE in the input',
      });
      const result = await adapter.run({
        host,
        principal: 'cto-actor' as PrincipalId,
        workspace,
        task: { planAtomId: 'plan-test' as AtomId, questionPrompt: 'echo' },
        budget: defaultBudgetCap(),
        toolPolicy: { disallowedTools: [] },
        redactor: new RegexRedactor(),
        blobStore,
        replayTier: 'best-effort',
        blobThreshold: 4096,
        correlationId: 'corr-test',
      });
      const turn = await host.atoms.get(result.turnAtomIds[0]!);
      const turnMeta = (turn?.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
      const out = turnMeta['llm_output'] as { inline: string } | { ref: string };
      const inlineOrFetch = 'inline' in out ? out.inline : await blobStore.get(out.ref as never).then((b) => b.toString('utf8'));
      expect(inlineOrFetch).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(inlineOrFetch).toContain('[REDACTED:aws-access-key]');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('updates the session atom terminal state on completion', async () => {
    const host = createMemoryHost();
    const scratch = await mkdtemp(join(tmpdir(), 'lag-loop-test-'));
    try {
      const blobStore = new FileBlobStore(scratch);
      const workspace: Workspace = { id: 'ws-3', path: scratch, baseRef: 'main' };
      const adapter = new ClaudeCodeAgentLoopSkeleton();
      const result = await adapter.run({
        host,
        principal: 'cto-actor' as PrincipalId,
        workspace,
        task: { planAtomId: 'plan-test' as AtomId, questionPrompt: 'p' },
        budget: defaultBudgetCap(),
        toolPolicy: { disallowedTools: [] },
        redactor: new RegexRedactor(),
        blobStore,
        replayTier: 'best-effort',
        blobThreshold: 4096,
        correlationId: 'corr-test',
      });
      const session = await host.atoms.get(result.sessionAtomId);
      const meta = (session?.metadata as Record<string, unknown>)['agent_session'] as Record<string, unknown>;
      expect(meta['terminal_state']).toBe('completed');
      expect(meta['completed_at']).toBeDefined();
      expect((meta['budget_consumed'] as Record<string, unknown>)['turns']).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('honors AbortSignal early-cancellation', async () => {
    const host = createMemoryHost();
    const scratch = await mkdtemp(join(tmpdir(), 'lag-loop-test-'));
    try {
      const blobStore = new FileBlobStore(scratch);
      const workspace: Workspace = { id: 'ws-4', path: scratch, baseRef: 'main' };
      const adapter = new ClaudeCodeAgentLoopSkeleton();
      const ac = new AbortController();
      ac.abort();
      await expect(adapter.run({
        host,
        principal: 'cto-actor' as PrincipalId,
        workspace,
        task: { planAtomId: 'plan-test' as AtomId, questionPrompt: 'p' },
        budget: defaultBudgetCap(),
        toolPolicy: { disallowedTools: [] },
        redactor: new RegexRedactor(),
        blobStore,
        replayTier: 'best-effort',
        blobThreshold: 4096,
        correlationId: 'corr-test',
        signal: ac.signal,
      })).rejects.toThrow(/aborted/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

runAgentLoopContract('ClaudeCodeAgentLoopSkeleton', () => new ClaudeCodeAgentLoopSkeleton());
