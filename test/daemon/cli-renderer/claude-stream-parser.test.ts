/**
 * Parser tests for Claude CLI stream-json output.
 *
 * Inputs are handcrafted JSONL lines matching Claude CLI's observed
 * shape. Each test feeds the line through parseClaudeStreamLine with
 * a fresh accumulator and asserts on the resulting CliRendererEvents
 * plus the accumulator mutations.
 */

import { describe, expect, it } from 'vitest';
import {
  emptyAccumulator,
  parseClaudeStreamLine,
  summarizeToolUse,
} from '../../../src/runtime/daemon/cli-renderer/claude-stream-parser.js';

describe('parseClaudeStreamLine', () => {
  it('blank / non-JSON lines produce no events', () => {
    const acc = emptyAccumulator();
    expect(parseClaudeStreamLine('', acc)).toEqual([]);
    expect(parseClaudeStreamLine('   ', acc)).toEqual([]);
    expect(parseClaudeStreamLine('not json', acc)).toEqual([]);
  });

  it('system/init events are ignored (no renderer events)', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
      acc,
    );
    expect(events).toEqual([]);
  });

  it('assistant text content becomes text-delta AND accumulates', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello ' }] },
      }),
      acc,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text-delta', text: 'Hello ' });
    expect(acc.assistantText).toBe('Hello ');

    parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world.' }] },
      }),
      acc,
    );
    expect(acc.assistantText).toBe('Hello world.');
  });

  it('assistant thinking content becomes thinking event AND accumulates', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'considering' }] },
      }),
      acc,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'thinking', text: 'considering' });
    expect(acc.thinkingText).toBe('considering');
  });

  it('assistant tool_use content becomes tool-call with summary', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } }],
        },
      }),
      acc,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool-call',
      tool: 'Read',
      summary: 'src/foo.ts',
    });
  });

  it('assistant message with multiple content blocks yields one event per block', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading...' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      }),
      acc,
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('text-delta');
    expect(events[1]!.type).toBe('tool-call');
  });

  it('user tool_result becomes tool-result with ok derived from is_error', () => {
    const acc = emptyAccumulator();
    const ok = parseClaudeStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'file contents here', is_error: false }],
        },
      }),
      acc,
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.type).toBe('tool-result');
    const okEvent = ok[0] as { type: 'tool-result'; ok: boolean };
    expect(okEvent.ok).toBe(true);

    const bad = parseClaudeStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'permission denied', is_error: true }],
        },
      }),
      acc,
    );
    const badEvent = bad[0] as { type: 'tool-result'; ok: boolean };
    expect(badEvent.ok).toBe(false);
  });

  it('result success emits complete with harvested meta', () => {
    const acc = emptyAccumulator();
    acc.assistantText = 'Here is the answer.';
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        cost_usd: 0.0321,
        duration_ms: 4500,
        num_turns: 2,
      }),
      acc,
    );
    expect(events).toHaveLength(1);
    const evt = events[0] as { type: 'complete'; finalText: string; meta: Record<string, unknown> };
    expect(evt.type).toBe('complete');
    expect(evt.finalText).toBe('Here is the answer.');
    expect(evt.meta.cost).toBe('$0.0321');
    expect(evt.meta.elapsed).toBe('5s');
    expect(evt.meta.turns).toBe(2);
  });

  it('result with explicit `result` field prefers it over accumulator', () => {
    const acc = emptyAccumulator();
    acc.assistantText = 'partial'; // pretend streaming got truncated
    const events = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'final text' }),
      acc,
    );
    const evt = events[0] as { type: 'complete'; finalText: string };
    expect(evt.finalText).toBe('final text');
  });

  it('result error_max_turns becomes an error event', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
      acc,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
  });

  it('unknown envelope type produces no events (forward compat)', () => {
    const acc = emptyAccumulator();
    const events = parseClaudeStreamLine(
      JSON.stringify({ type: 'future-new-event-kind', whatever: true }),
      acc,
    );
    expect(events).toEqual([]);
  });
});

describe('summarizeToolUse', () => {
  it('Read / Write / Edit use file_path', () => {
    expect(summarizeToolUse('Read', { file_path: 'src/x.ts' })).toBe('src/x.ts');
    expect(summarizeToolUse('Write', { file_path: 'src/x.ts' })).toBe('src/x.ts');
    expect(summarizeToolUse('Edit', { file_path: 'src/x.ts' })).toBe('src/x.ts');
  });
  it('Bash truncates long commands', () => {
    const cmd = 'echo ' + 'x'.repeat(200);
    const s = summarizeToolUse('Bash', { command: cmd });
    expect(s.length).toBeLessThanOrEqual(80);
  });
  it('Grep combines pattern and path', () => {
    expect(summarizeToolUse('Grep', { pattern: 'foo', path: 'src/' })).toBe('foo in src/');
  });
  it('unknown tool falls back to first string field', () => {
    expect(summarizeToolUse('NewTool', { query: 'hello world' })).toContain('query=hello world');
  });
  it('unknown tool with no string fields summarises keys', () => {
    expect(summarizeToolUse('NewTool', { a: 1, b: true })).toBe('(a,b)');
  });
  it('unknown tool with empty input', () => {
    expect(summarizeToolUse('NewTool', {})).toBe('(no args)');
  });
});
