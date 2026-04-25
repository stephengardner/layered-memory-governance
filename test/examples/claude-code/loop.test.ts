import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { ClaudeCodeAgentLoopAdapter } from '../../../examples/agent-loops/claude-code/loop.js';
import type { AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';
import type { BlobStore, BlobRef } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { AtomId, PrincipalId } from '../../../src/substrate/types.js';
import { randomBytes } from 'node:crypto';

const NOOP_REDACTOR: Redactor = { redact: (s) => s };
const PRINCIPAL = 'agentic-code-author' as PrincipalId;
const WS: Workspace = { id: 'ws-1', path: '/tmp/stub-ws', baseRef: 'main' };

function inMemBlob(): BlobStore {
  const m = new Map<string, Buffer>();
  return {
    put: async (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
      m.set(ref, buf);
      return ref;
    },
    get: async (r) => m.get(r as string)!,
    has: async (r) => m.has(r as string),
  };
}

function makeStubExeca(stdoutLines: string[], opts: { exitCode?: number; stderr?: string } = {}) {
  // Real `execa()` returns a `ResultPromise` -- a Promise that ALSO
  // exposes `.stdout` / `.stderr` (Readables) AND a `.kill()` method
  // synchronously, before the promise resolves. The adapter does
  // `proc.stdout!` BEFORE `await proc`, so the stub MUST expose
  // `.stdout` on the synchronously-returned promise.
  //
  // Mirrors execa v9 behavior: calling `.kill()` rejects the
  // result-promise with an Error whose `.isTerminated === true`.
  // Without this, the adapter's catch-block flag-routing (budget /
  // wall-clock / signal) is never exercised by tests, masking the
  // scope bug where flags declared inside the try block were
  // out-of-scope in the catch handler.
  return ((..._args: unknown[]) => {
    const stdoutStream = Readable.from(stdoutLines.map((l) => `${l}\n`));
    const stderrText = opts.stderr ?? '';
    const stderrStream = Readable.from([stderrText]);
    let resolveResult!: (v: unknown) => void;
    let rejectResult!: (e: unknown) => void;
    const resultPromise: Promise<unknown> = new Promise((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    let killed = false;
    const kill = (_signal?: NodeJS.Signals) => {
      if (!killed) {
        killed = true;
        rejectResult(Object.assign(new Error('subprocess killed'), { isTerminated: true }));
      }
      return true;
    };
    // Resolve once stdout drains, unless kill() was called first.
    stdoutStream.on('end', () => {
      if (!killed) {
        resolveResult({
          stdout: stdoutLines.join('\n'),
          stderr: stderrText,
          exitCode: opts.exitCode ?? 0,
        });
      }
    });
    return Object.assign(resultPromise, {
      stdout: stdoutStream,
      stderr: stderrStream,
      kill,
    }) as never;
  }) as never;
}

function mkInput(host: ReturnType<typeof createMemoryHost>, signal?: AbortSignal): AgentLoopInput {
  return {
    host,
    principal: PRINCIPAL,
    workspace: WS,
    task: { planAtomId: 'plan-1' as AtomId, questionPrompt: 'do X' },
    budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
    toolPolicy: { disallowedTools: [] },
    redactor: NOOP_REDACTOR,
    blobStore: inMemBlob(),
    replayTier: 'content-addressed',
    blobThreshold: 4096,
    correlationId: 'corr-1',
    ...(signal !== undefined ? { signal } : {}),
  };
}

describe('ClaudeCodeAgentLoopAdapter -- happy path lifecycle', () => {
  it('writes session atom on entry, updates terminal_state + completed_at on exit', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const result = await adapter.run(mkInput(host));
    expect(result.kind).toBe('completed');
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    const meta = session.metadata as Record<string, unknown>;
    const agentSession = meta['agent_session'] as Record<string, unknown>;
    expect(agentSession['terminal_state']).toBe('completed');
    expect(agentSession['completed_at']).toBeDefined();
    const budget = agentSession['budget_consumed'] as Record<string, unknown>;
    expect(budget['usd']).toBe(0.01);
    expect(budget['turns']).toBe(1);
  });

  it('emits exactly one agent-turn atom for a single-turn run', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turns).toHaveLength(1);
    const turnMeta = (turns[0]!.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    expect(turnMeta['turn_index']).toBe(0);
    const llmOutput = turnMeta['llm_output'] as Record<string, unknown>;
    expect(llmOutput).toHaveProperty('inline');
    expect(llmOutput['inline']).toBe('done');
  });

  it('redactor is applied to llm_input + llm_output before atom write', async () => {
    const host = createMemoryHost();
    let redactCalls = 0;
    const counting: Redactor = { redact: (s) => { redactCalls += 1; return s.replace('secret', '<redacted>'); } };
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'output with secret' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host), redactor: counting };
    await adapter.run(input);
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turnMeta = (turns[0]!.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const llmOutput = turnMeta['llm_output'] as Record<string, unknown>;
    expect(llmOutput['inline']).toContain('<redacted>');
    expect(llmOutput['inline']).not.toContain('secret');
    expect(redactCalls).toBeGreaterThan(0);
  });

  it('returns error result with failure: catastrophic when redactor throws', async () => {
    const host = createMemoryHost();
    const explodingRedactor: Redactor = {
      redact: () => { throw new Error('redactor went boom'); },
    };
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'anything' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host), redactor: explodingRedactor };
    const result = await adapter.run(input);
    expect(result.kind).toBe('error');
    expect(result.failure?.kind).toBe('catastrophic');
  });
});

describe('ClaudeCodeAgentLoopAdapter -- multi-turn + tool_calls', () => {
  it('opens turn N+1 placeholder on tool_result, closes on next assistant-text', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two files' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.02, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turns).toHaveLength(2);
    const idx = (a: typeof turns[number]) =>
      ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] as number;
    expect(turns.map(idx).sort()).toEqual([0, 1]);
  });

  it('records tool_calls with canonical AgentTurnMeta shape (tool, args, result, outcome)', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turn0 = turns.find(
      (a) => ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] === 0
    )!;
    const meta = (turn0.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const toolCalls = meta['tool_calls'] as ReadonlyArray<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0]!;
    expect(tc['tool']).toBe('Bash');
    expect(tc).toHaveProperty('args');
    expect(tc).toHaveProperty('result');
    expect(tc).toHaveProperty('outcome');
    expect(tc).toHaveProperty('latency_ms');
    expect(tc['outcome']).toBe('success');
  });

  it('classifies tool_result with is_error AND "Permission denied" content as policy-refused', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'rm -rf /' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Permission denied: tool not allowed', is_error: true }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turn0 = turns.find(
      (a) => ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] === 0
    )!;
    const meta = (turn0.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const tc = (meta['tool_calls'] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(tc['outcome']).toBe('policy-refused');
  });

  it('classifies tool_result with is_error AND no policy phrase as tool-error', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'cat /nope' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ENOENT', is_error: true }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turn0 = turns.find(
      (a) => ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] === 0
    )!;
    const meta = (turn0.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const tc = (meta['tool_calls'] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(tc['outcome']).toBe('tool-error');
  });
});

describe('ClaudeCodeAgentLoopAdapter -- blob threshold', () => {
  it('routes large llm_output through blobStore.put when over threshold', async () => {
    const host = createMemoryHost();
    let putCount = 0;
    const counting: BlobStore = {
      put: async (c) => {
        putCount += 1;
        const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
        return ref;
      },
      get: async () => Buffer.alloc(0),
      has: async () => true,
    };
    const longText = 'x'.repeat(8192);
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host), blobStore: counting, blobThreshold: 4096 };
    await adapter.run(input);
    expect(putCount).toBeGreaterThanOrEqual(1);
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turnMeta = (turns[0]!.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const llmOutput = turnMeta['llm_output'] as Record<string, unknown>;
    expect(llmOutput).toHaveProperty('ref');
    expect(typeof llmOutput['ref']).toBe('string');
  });

  it('blobStore.put throw on over-threshold payload pins failure to catastrophic with stage blob-store', async () => {
    const host = createMemoryHost();
    const explodingBlob: BlobStore = {
      put: async () => { throw new Error('disk full'); },
      get: async () => Buffer.alloc(0),
      has: async () => false,
    };
    const longText = 'x'.repeat(8192);
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host), blobStore: explodingBlob, blobThreshold: 4096 };
    const result = await adapter.run(input);
    expect(result.kind).toBe('error');
    expect(result.failure?.kind).toBe('catastrophic');
    expect(result.failure?.stage).toBe('blob-store');
  });
});

describe('ClaudeCodeAgentLoopAdapter -- budget guards', () => {
  it('terminates with kind=budget-exhausted when max_turns is reached', async () => {
    const host = createMemoryHost();
    // Stream emits 5 turn-result-turn cycles; max_turns=2 should kill after 2.
    const lines: string[] = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
    ];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: {} }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'ok', is_error: false }] } }));
    }
    lines.push(JSON.stringify({ type: 'result', cost_usd: 0.05, is_error: false }));
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(lines) });
    const input = {
      ...mkInput(host),
      budget: { max_turns: 2, max_wall_clock_ms: 60_000, max_usd: 1 },
    };
    const result = await adapter.run(input);
    expect(result.kind).toBe('budget-exhausted');
    // Pin the turn-count: max_turns=2 means exactly 2 placeholder turns
    // were opened before the trip fired. A future regression that
    // miscounts (e.g. opens N+1 before checking the cap) shows up here.
    expect(result.turnAtomIds.length).toBe(2);
  });
});

describe('ClaudeCodeAgentLoopAdapter -- signal handling', () => {
  it('returns kind=aborted, failure=catastrophic when signal is already aborted at entry', async () => {
    const host = createMemoryHost();
    const ac = new AbortController();
    ac.abort();
    const stdoutLines = [JSON.stringify({ type: 'result', cost_usd: 0, is_error: false })];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const result = await adapter.run(mkInput(host, ac.signal));
    expect(result.kind).toBe('aborted');
    expect(result.failure?.kind).toBe('catastrophic');
  });
});
