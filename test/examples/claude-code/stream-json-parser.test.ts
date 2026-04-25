import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine, type StreamJsonEvent } from '../../../examples/agent-loops/claude-code/stream-json-parser.js';

describe('parseStreamJsonLine', () => {
  it('parses a system event', () => {
    const [ev] = parseStreamJsonLine('{"type":"system","subtype":"init","model":"claude-opus-4-7","session_id":"abc"}');
    expect(ev!.kind).toBe('system');
    if (ev!.kind !== 'system') throw new Error('unreachable');
    expect(ev.modelId).toBe('claude-opus-4-7');
    expect(ev.sessionId).toBe('abc');
  });

  it('parses an assistant text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    const [ev] = parseStreamJsonLine(line);
    expect(ev!.kind).toBe('assistant-text');
    if (ev!.kind !== 'assistant-text') throw new Error('unreachable');
    expect(ev.text).toBe('hello world');
  });

  it('parses an assistant tool_use event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
    });
    const [ev] = parseStreamJsonLine(line);
    expect(ev!.kind).toBe('tool-use');
    if (ev!.kind !== 'tool-use') throw new Error('unreachable');
    expect(ev.toolUseId).toBe('tu_1');
    expect(ev.toolName).toBe('Bash');
    expect(ev.input).toEqual({ command: 'ls' });
  });

  it('parses a user tool_result event', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2', is_error: false }] },
    });
    const [ev] = parseStreamJsonLine(line);
    expect(ev!.kind).toBe('tool-result');
    if (ev!.kind !== 'tool-result') throw new Error('unreachable');
    expect(ev.toolUseId).toBe('tu_1');
    expect(ev.content).toBe('file1\nfile2');
    expect(ev.isError).toBe(false);
  });

  it('parses a result envelope', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      cost_usd: 0.0042,
      usage: { input_tokens: 100, output_tokens: 200 },
      is_error: false,
    });
    const [ev] = parseStreamJsonLine(line);
    expect(ev!.kind).toBe('result');
    if (ev!.kind !== 'result') throw new Error('unreachable');
    expect(ev.costUsd).toBe(0.0042);
    expect(ev.isError).toBe(false);
  });

  it('returns parse-error for malformed JSON', () => {
    const [ev] = parseStreamJsonLine('not json {');
    expect(ev!.kind).toBe('parse-error');
    if (ev!.kind !== 'parse-error') throw new Error('unreachable');
    expect(ev.linePreview).toBe('not json {');
  });

  it('returns parse-error for oversize line', () => {
    const big = JSON.stringify({ type: 'system', payload: 'a'.repeat(11_000_000) });
    const [ev] = parseStreamJsonLine(big);
    expect(ev!.kind).toBe('parse-error');
    if (ev!.kind !== 'parse-error') throw new Error('unreachable');
    expect(ev.reason).toBe('oversize-line');
  });

  it('returns parse-error for unknown type', () => {
    const [ev] = parseStreamJsonLine('{"type":"telemetry","unrelated":1}');
    expect(ev!.kind).toBe('parse-error');
    if (ev!.kind !== 'parse-error') throw new Error('unreachable');
    expect(ev.reason).toBe('unknown-type');
  });

  it('returns parse-error for empty line', () => {
    const [ev] = parseStreamJsonLine('');
    expect(ev!.kind).toBe('parse-error');
  });

  it('emits multiple events from assistant message with text + tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'I will run that' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ] },
    });
    const events = parseStreamJsonLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe('assistant-text');
    expect(events[1]!.kind).toBe('tool-use');
  });

  it('emits multiple events from user message with parallel tool_result blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'a', is_error: false },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'b', is_error: false },
      ] },
    });
    const events = parseStreamJsonLine(line);
    expect(events).toHaveLength(2);
    if (events[0]!.kind !== 'tool-result') throw new Error('unreachable');
    expect(events[0]!.toolUseId).toBe('tu_1');
    if (events[1]!.kind !== 'tool-result') throw new Error('unreachable');
    expect(events[1]!.toolUseId).toBe('tu_2');
  });
});
