/**
 * End-to-end tests for invokeClaudeStreaming with a stub executor.
 *
 * Proves that feeding a realistic sequence of stream-json lines
 * through the full pipeline (parser + event fan-out + result
 * accumulation) produces the right CliRendererEvents in order and
 * the right final accumulator snapshot.
 */

import { describe, expect, it } from 'vitest';
import {
  invokeClaudeStreaming,
  makeStubStreamingExecutor,
} from '../../../src/daemon/cli-renderer/claude-streaming.js';
import type { CliRendererEvent } from '../../../src/daemon/cli-renderer/types.js';

const LINES = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc123' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Let me check that file.' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } }],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', content: '// some code', is_error: false }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Got it. Here is the fix.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    cost_usd: 0.0123,
    duration_ms: 2000,
    num_turns: 1,
  }),
];

describe('invokeClaudeStreaming', () => {
  it('fans out events in order and returns accumulated text + meta', async () => {
    const events: CliRendererEvent[] = [];
    const result = await invokeClaudeStreaming({
      userMessage: 'test',
      executor: makeStubStreamingExecutor(LINES),
      onEvent: (ev) => { events.push(ev); },
    });

    // Event order: text-delta, tool-call, tool-result, text-delta, complete
    expect(events.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-call',
      'tool-result',
      'text-delta',
      'complete',
    ]);
    expect(result.text).toBe('Let me check that file.Got it. Here is the fix.');
    expect(result.meta.cost).toBe('$0.0123');
    expect(result.meta.elapsed).toBe('2s');
    expect(result.exitCode).toBe(0);
  });

  it('onEvent throws do not abort the stream', async () => {
    let callCount = 0;
    const result = await invokeClaudeStreaming({
      userMessage: 'test',
      executor: makeStubStreamingExecutor(LINES),
      onEvent: () => {
        callCount++;
        throw new Error('renderer went down');
      },
    });
    // All events were attempted even though each threw.
    expect(callCount).toBeGreaterThanOrEqual(5);
    expect(result.text).toBe('Let me check that file.Got it. Here is the fix.');
  });

  it('passes --output-format stream-json --verbose to the executor', async () => {
    let capturedArgs: ReadonlyArray<string> = [];
    const exec = async (args: ReadonlyArray<string>) => {
      capturedArgs = args;
      return { exitCode: 0, stderr: '' };
    };
    await invokeClaudeStreaming({
      userMessage: 'hi',
      executor: exec,
    });
    expect(capturedArgs).toContain('--output-format');
    expect(capturedArgs[capturedArgs.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(capturedArgs).toContain('--verbose');
    expect(capturedArgs).toContain('-p');
    expect(capturedArgs[capturedArgs.indexOf('-p') + 1]).toBe('hi');
  });

  it('forwards resumeSessionId as --resume', async () => {
    let capturedArgs: ReadonlyArray<string> = [];
    const exec = async (args: ReadonlyArray<string>) => {
      capturedArgs = args;
      return { exitCode: 0, stderr: '' };
    };
    await invokeClaudeStreaming({
      userMessage: 'x',
      resumeSessionId: 'session-xyz',
      executor: exec,
    });
    expect(capturedArgs).toContain('--resume');
    expect(capturedArgs[capturedArgs.indexOf('--resume') + 1]).toBe('session-xyz');
  });

  it('error result event surfaces as error in the event stream', async () => {
    const events: CliRendererEvent[] = [];
    await invokeClaudeStreaming({
      userMessage: 'oops',
      executor: makeStubStreamingExecutor([
        JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
      ]),
      onEvent: (ev) => { events.push(ev); },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
  });
});
