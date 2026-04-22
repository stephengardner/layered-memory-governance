/**
 * CLI-based MessagesClient tests.
 *
 * `createCliClient` wraps `claude -p` (subprocess) in the MessagesClient
 * surface the agent-process depends on, so the bootstrap runs without
 * ANTHROPIC_API_KEY. Tests use an injected execImpl so the real `claude`
 * binary is never spawned.
 *
 * Pinned assertions:
 *   - messages.create translates `system` + `messages` into a single
 *     prompt on stdin; no user data ever appears in argv (mirrors the
 *     ClaudeCliLLM Windows argv regression).
 *   - The model argument is forwarded to the CLI via --model.
 *   - The response body returned by the CLI (envelope.result) is
 *     surfaced to the caller as a { type: 'text', text } content block.
 *   - When the CLI is missing / not authenticated / errors, the error
 *     is surfaced with enough detail to diagnose.
 */
import { describe, expect, it } from 'vitest';
import type { ExecaOptions, ExecaReturnValue } from 'execa';
import { createCliClient } from '../../../src/integrations/agent-sdk/cli-client.js';

function makeExecStub(stdout: string, extra: Partial<ExecaReturnValue<string>> = {}) {
  const calls: Array<{
    bin: string;
    args: ReadonlyArray<string>;
    options: ExecaOptions;
    stdinCaptured: string | null;
  }> = [];
  const exec = ((bin: string, args: ReadonlyArray<string>, options: ExecaOptions = {}) => {
    let stdinCaptured: string | null = null;
    const stdinOpt = (options as { input?: unknown }).input;
    if (typeof stdinOpt === 'string') stdinCaptured = stdinOpt;
    calls.push({ bin, args, options, stdinCaptured });
    const result: ExecaReturnValue<string> = {
      command: `${bin} ${args.join(' ')}`,
      escapedCommand: '',
      exitCode: 0,
      stdout,
      stderr: '',
      all: undefined,
      failed: false,
      timedOut: false,
      isCanceled: false,
      killed: false,
      ...extra,
    } as ExecaReturnValue<string>;
    return Object.assign(Promise.resolve(result), result);
  }) as unknown as typeof import('execa').execa;
  return { exec, calls };
}

function envelope(body: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: body,
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 50 },
    is_error: false,
  });
}

const AGENT_POSITION = JSON.stringify({
  answer: 'Bump patch',
  rationale: 'Safe scope.',
  derivedFrom: [],
});

describe('createCliClient', () => {
  it('translates system + messages into a single prompt on stdin', async () => {
    const { exec, calls } = makeExecStub(envelope(AGENT_POSITION));
    const client = createCliClient({ execImpl: exec });

    const result = await client.messages.create({
      model: 'claude-opus-4-7',
      system: '# Principal: CTO (cto)\nYou uphold invariants.',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Question (id=q1): How?' }],
    });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.bin).toBe('claude');
    expect(call.stdinCaptured).not.toBeNull();
    // The composed prompt must carry both system and user message.
    const stdin = call.stdinCaptured!;
    expect(stdin).toContain('# Principal: CTO (cto)');
    expect(stdin).toContain('Question (id=q1): How?');
    // The response must be surfaced as a MessagesClient response.
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    const textBlock = result.content.find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect((textBlock as { text: string }).text).toBe(AGENT_POSITION);
  });

  it('forwards the model argument to the CLI via --model', async () => {
    const { exec, calls } = makeExecStub(envelope(AGENT_POSITION));
    const client = createCliClient({ execImpl: exec });

    await client.messages.create({
      model: 'claude-sonnet-4-7',
      system: 's',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'x' }],
    });

    const call = calls[0]!;
    const modelIdx = call.args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[modelIdx + 1]).toBe('claude-sonnet-4-7');
  });

  it('does NOT put system or user content in argv (it goes via stdin)', async () => {
    // Large prompt guard: same argv ceiling concern as ClaudeCliLLM.
    const bigSystem = `# Principal: CTO (cto)\n${'x'.repeat(40_000)}`;
    const { exec, calls } = makeExecStub(envelope(AGENT_POSITION));
    const client = createCliClient({ execImpl: exec });

    await client.messages.create({
      model: 'claude-opus-4-7',
      system: bigSystem,
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'user question goes here' }],
    });

    const call = calls[0]!;
    const argvContainsSystem = call.args.some((a) => a.includes('x'.repeat(1000)));
    expect(argvContainsSystem).toBe(false);
    const argvContainsUser = call.args.some((a) => a.includes('user question goes here'));
    expect(argvContainsUser).toBe(false);
    const argvBytes = call.args.reduce((n, a) => n + Buffer.byteLength(a, 'utf8'), 0);
    expect(argvBytes).toBeLessThan(8_000);
    // Stdin must have carried both pieces.
    expect(call.stdinCaptured).not.toBeNull();
    expect(call.stdinCaptured).toContain('user question goes here');
  });

  it('passes max_tokens through to --max-budget-usd translation (still runs)', async () => {
    // The CLI has no direct max_tokens knob; the adapter maps it to a
    // max-budget-usd ceiling (conservative) so a runaway thinking pass
    // does not burn the operator's day. This test pins the argv shape.
    const { exec, calls } = makeExecStub(envelope(AGENT_POSITION));
    const client = createCliClient({ execImpl: exec });

    await client.messages.create({
      model: 'claude-opus-4-7',
      system: 's',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'x' }],
    });

    const call = calls[0]!;
    expect(call.args).toContain('--max-budget-usd');
    const idx = call.args.indexOf('--max-budget-usd');
    // Some positive number; adapter picks it. Just assert shape.
    expect(Number.isFinite(Number(call.args[idx + 1]))).toBe(true);
  });

  it('surfaces CLI exit code as a typed error with diagnostic context', async () => {
    const { exec } = makeExecStub('some stdout', { exitCode: 1, stderr: 'boom' });
    const client = createCliClient({ execImpl: exec });

    await expect(
      client.messages.create({
        model: 'claude-opus-4-7',
        system: 's',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/claude cli.*exit/i);
  });

  it('surfaces "Not logged in" as an auth error', async () => {
    const { exec } = makeExecStub('Not logged in', { exitCode: 0 });
    const client = createCliClient({ execImpl: exec });

    await expect(
      client.messages.create({
        model: 'claude-opus-4-7',
        system: 's',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/not authenticated|not logged in/i);
  });

  it('returns empty thinking array (CLI does not emit plaintext thinking)', async () => {
    // Per docs/claude-code-session-persistence.md, thinking from the
    // CLI is signature-only. The adapter returns the text block alone;
    // callers wanting plaintext thinking must use the SDK backend.
    const { exec } = makeExecStub(envelope(AGENT_POSITION));
    const client = createCliClient({ execImpl: exec });

    const result = await client.messages.create({
      model: 'claude-opus-4-7',
      system: 's',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [{ role: 'user', content: 'x' }],
    });

    const thinking = result.content.filter((b) => b.type === 'thinking');
    expect(thinking).toHaveLength(0);
  });

  it('accepts a custom claudePath', async () => {
    const { exec, calls } = makeExecStub(envelope(AGENT_POSITION));
    const client = createCliClient({
      execImpl: exec,
      claudePath: '/custom/path/to/claude',
    });

    await client.messages.create({
      model: 'claude-opus-4-7',
      system: 's',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(calls[0]!.bin).toBe('/custom/path/to/claude');
  });
});
