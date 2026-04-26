/**
 * ClaudeCliLLM tests.
 *
 * Injected execImpl so the real `claude` binary is never spawned.
 * The stub records the (binary, args, options) it was called with
 * plus whatever stdin stream it received, then returns a canned
 * stdout envelope. That lets us assert:
 *
 *   - User-data payloads of ANY size are delivered to the CLI
 *     without relying on the kernel argv limit (the root cause of
 *     the Windows silent-exec failure discovered 2026-04-20).
 *   - The schema-validated output from envelope.structured_output
 *     is returned to the caller.
 *   - Auth / rate-limit / envelope-error signals map to typed errors.
 */

import { describe, expect, it } from 'vitest';
import type { ExecaOptions, ExecaReturnValue } from 'execa';
import { Readable } from 'node:stream';
import { ClaudeCliLLM } from '../../../src/adapters/claude-cli/llm.js';

function makeExecStub(stdout: string, extra: Partial<ExecaReturnValue<string>> = {}) {
  const calls: Array<{
    bin: string;
    args: ReadonlyArray<string>;
    options: ExecaOptions;
    stdinCaptured: string | null;
  }> = [];
  const exec = ((bin: string, args: ReadonlyArray<string>, options: ExecaOptions = {}) => {
    // Capture stdin if the caller passed it as a Readable or a string.
    let stdinCaptured: string | null = null;
    const stdinOpt = (options as { input?: unknown; stdin?: unknown }).input
      ?? (options as { input?: unknown; stdin?: unknown }).stdin;
    if (typeof stdinOpt === 'string') {
      stdinCaptured = stdinOpt;
    } else if (stdinOpt instanceof Readable) {
      // In tests we treat a Readable as "it was used, but we didn't
      // materialize it." The presence of the Readable is the point.
      stdinCaptured = '<readable-stream>';
    }
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

const SUCCESS_ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  structured_output: { answer: 'ok' },
  total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 10 },
  is_error: false,
});

const SCHEMA = {
  type: 'object',
  required: ['answer'],
  additionalProperties: false,
  properties: { answer: { type: 'string' } },
} as const;

describe('ClaudeCliLLM', () => {
  describe('large data payload (regression: Windows argv silent-exec bug)', () => {
    it('does NOT put the data payload in argv (it goes to stdin)', async () => {
      // Root cause of the 2026-04-20 discovery: the templated user
      // message was passed as the positional `-p "<...>"` argument.
      // On Windows, CreateProcess caps the command line at ~32767
      // chars; a 50k-char payload caused spawn to fail silently with
      // exitCode=undefined, empty stdout, empty stderr.
      //
      // The invariant this test protects: no matter how big `data`
      // is, none of its content ever appears in argv. Stdin takes it.
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec });

      // 50k chars of data content, well past Windows' argv ceiling
      // and comfortably past normal cases. The specific content is
      // a repeating atom shape so the payload is plausible, not
      // artificial.
      const bigString = 'x'.repeat(50_000);
      await llm.judge(
        SCHEMA,
        'return {"answer":"ok"}',
        { bulk: bigString },
        { model: 'claude-test', max_budget_usd: 1.0, sandboxed: true },
      );

      expect(calls.length).toBe(1);
      const call = calls[0]!;
      // INVARIANT: no single argv element contains the bulk payload.
      // This is the failing-first assertion for the Windows bug.
      const argvContainsBulk = call.args.some((a) => a.includes(bigString));
      expect(argvContainsBulk).toBe(false);
      // And the total argv is well under a conservative 16k threshold
      // so we have margin below even the lowest argv caps.
      const argvBytes = call.args.reduce((n, a) => n + Buffer.byteLength(a, 'utf8'), 0);
      expect(argvBytes).toBeLessThan(16_000);
      // Stdin MUST have carried the data. Either materialized as a
      // string or piped as a stream is acceptable; what is not
      // acceptable is "no stdin passed" which would mean the data
      // went somewhere else.
      expect(call.stdinCaptured).not.toBeNull();
      if (typeof call.stdinCaptured === 'string') {
        expect(call.stdinCaptured).toContain(bigString);
      }
    });

    it('still passes small payloads cleanly', async () => {
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec });

      const result = await llm.judge<{ answer: string }>(
        SCHEMA,
        'classify',
        { ping: 'ping' },
        { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true },
      );

      expect(result.output).toEqual({ answer: 'ok' });
      // Argv still doesn't carry the data even when it's tiny; the
      // rule is uniform, not size-conditional, so we avoid a
      // latent "works at 1k, breaks at 40k" footgun.
      expect(calls[0]!.args.some((a) => a.includes('"ping":"ping"'))).toBe(false);
    });

    it('honors ClaudeCliOptions.defaultTimeoutMs when no per-call timeout is set', async () => {
      // Precedence: per-invocation options.timeout_ms > adapter-level
      // defaultTimeoutMs > hardcoded 3-minute floor. This test pins the
      // middle rung: deployments configure their timeout posture at
      // construction (e.g. a long-running drafter envelope), and the
      // per-call value is unset.
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec, defaultTimeoutMs: 12_345 });

      await llm.judge(
        SCHEMA,
        'classify',
        { x: 1 },
        { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true },
      );

      expect(calls.length).toBe(1);
      expect((calls[0]!.options as { timeout?: number }).timeout).toBe(12_345);
    });

    it('lets per-call options.timeout_ms override defaultTimeoutMs', async () => {
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec, defaultTimeoutMs: 12_345 });

      await llm.judge(
        SCHEMA,
        'classify',
        { x: 1 },
        { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true, timeout_ms: 67_890 },
      );

      expect((calls[0]!.options as { timeout?: number }).timeout).toBe(67_890);
    });

    it('passes --strict-mcp-config so user-level MCP config does not leak in', async () => {
      // Regression guard: without --strict-mcp-config, the CLI MERGES our
      // empty `--mcp-config '{"mcpServers":{}}'` with the user-level
      // ~/.claude.json MCP list, spawning every configured MCP server at
      // startup. If any blocks (auth prompt, slow npm cold-start, missing
      // browser, OAuth handshake) the parent claude CLI never reaches the
      // API call and execa returns exit=undefined with empty stdout/stderr
      // after the parent's timeout fires. The flag forces "ONLY use
      // --mcp-config sources, ignore everything else."
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec });

      await llm.judge(
        SCHEMA,
        'classify',
        { x: 1 },
        { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true },
      );

      expect(calls.length).toBe(1);
      expect(calls[0]!.args).toContain('--strict-mcp-config');
      // And the empty mcp-config remains so the strict mode applies to a
      // known-empty list rather than nothing.
      const mcpConfigIdx = calls[0]!.args.indexOf('--mcp-config');
      expect(mcpConfigIdx).toBeGreaterThanOrEqual(0);
      expect(calls[0]!.args[mcpConfigIdx + 1]).toBe('{"mcpServers":{}}');
    });
  });

  describe('error paths', () => {
    it('surfaces schema-validation failure from the CLI envelope', async () => {
      const env = JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        error: 'schema validation failed',
      });
      const { exec } = makeExecStub(env);
      const llm = new ClaudeCliLLM({ execImpl: exec });

      await expect(
        llm.judge(
          SCHEMA,
          'classify',
          { ping: 'ping' },
          { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true },
        ),
      ).rejects.toThrow(/schema validation failed/);
    });
  });

  describe('AbortSignal forwarding', () => {
    it('passes LlmOptions.signal to execa as cancelSignal', async () => {
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec });
      const ac = new AbortController();
      await llm.judge(
        SCHEMA,
        'classify',
        { ping: 'ping' },
        { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true, signal: ac.signal },
      );
      expect(calls[0]!.options).toMatchObject({ cancelSignal: ac.signal });
    });

    it('omits cancelSignal when no signal is supplied', async () => {
      const { exec, calls } = makeExecStub(SUCCESS_ENVELOPE);
      const llm = new ClaudeCliLLM({ execImpl: exec });
      await llm.judge(
        SCHEMA,
        'classify',
        { ping: 'ping' },
        { model: 'claude-test', max_budget_usd: 0.5, sandboxed: true },
      );
      expect(calls[0]!.options).not.toHaveProperty('cancelSignal');
    });
  });
});
