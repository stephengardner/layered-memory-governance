/**
 * Streaming invocation of Claude CLI with event callback.
 *
 * Uses `--output-format stream-json --verbose` to get one-JSON-per-line
 * output, then parses each line into CliRendererEvents (via
 * claude-stream-parser) and fires an async callback per event.
 *
 * Deliberately mirrors the shape of invoke-claude.invokeClaude so a
 * caller can swap between the two. The streaming variant returns
 * the same InvokeClaudeResult shape; accumulated text + meta come
 * from the parser's accumulator at `result` event time.
 *
 * Executor is injectable (StreamingExecutor) so tests feed canned
 * JSONL and production uses the real Claude CLI via execa. Same
 * pattern we use in GhClient.
 */

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { emptyAccumulator, parseClaudeStreamLine } from './claude-stream-parser.js';
import type { CliRendererEvent } from './types.js';

export interface StreamingExecResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Spawns a process that writes newline-delimited JSON to stdout and
 * returns when the process exits. The `onLine` callback is invoked
 * per stdout line. Default implementation uses Node's child_process
 * with 'claude' on PATH; tests inject a stub.
 */
export type StreamingExecutor = (
  args: ReadonlyArray<string>,
  onLine: (line: string) => void | Promise<void>,
  options: { timeoutMs?: number; cwd?: string },
) => Promise<StreamingExecResult>;

export const defaultClaudeStreamingExecutor: StreamingExecutor = async (
  args,
  onLine,
  options,
) => {
  return runSpawnedJsonl('claude', [...args], onLine, options);
};

export interface InvokeClaudeStreamingOptions {
  readonly userMessage: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly maxBudgetUsd?: number;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly resumeSessionId?: string;
  readonly verbose?: boolean;
  /** Injectable executor for tests. */
  readonly executor?: StreamingExecutor;
  /**
   * Called with each CliRendererEvent as the stream is parsed. Receives
   * awaitable callback; errors inside onEvent are logged but do NOT
   * abort the stream (a flaky renderer must not crash the run).
   */
  readonly onEvent?: (event: CliRendererEvent) => void | Promise<void>;
  /** Extra CLI args appended verbatim; escape hatch for advanced callers. */
  readonly extraArgs?: ReadonlyArray<string>;
}

export interface InvokeClaudeStreamingResult {
  readonly text: string;
  readonly thinking: string;
  readonly meta: Readonly<Record<string, string | number>>;
  readonly exitCode: number;
  readonly stderr: string;
}

export async function invokeClaudeStreaming(
  options: InvokeClaudeStreamingOptions,
): Promise<InvokeClaudeStreamingResult> {
  const args: string[] = [
    '-p',
    options.userMessage,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    options.model ?? 'claude-haiku-4-5-20251001',
    '--max-budget-usd',
    String(options.maxBudgetUsd ?? 1.0),
    '--disable-slash-commands',
    '--mcp-config',
    '{"mcpServers":{}}',
  ];
  if (options.systemPrompt !== undefined) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  if (options.resumeSessionId !== undefined) {
    args.push('--resume', options.resumeSessionId);
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  const acc = emptyAccumulator();
  const exec = options.executor ?? defaultClaudeStreamingExecutor;

  const handleLine = async (line: string): Promise<void> => {
    const events = parseClaudeStreamLine(line, acc);
    for (const event of events) {
      if (options.onEvent === undefined) continue;
      try {
        await options.onEvent(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[invokeClaudeStreaming] onEvent threw; continuing:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  const result = await exec(args, handleLine, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  return {
    text: acc.assistantText,
    thinking: acc.thinkingText,
    meta: acc.meta,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

/**
 * Run a command via child_process.spawn, read stdout line-by-line,
 * fire onLine per line, return exit code + accumulated stderr.
 * Shared helper so tests can reuse the shape.
 */
export async function runSpawnedJsonl(
  command: string,
  args: ReadonlyArray<string>,
  onLine: (line: string) => void | Promise<void>,
  options: { timeoutMs?: number; cwd?: string },
): Promise<StreamingExecResult> {
  return await new Promise<StreamingExecResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdoutBuffer = '';
    const lineQueue: string[] = [];
    let processing = false;
    let timedOut = false;

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : null;

    const processQueue = async (): Promise<void> => {
      if (processing) return;
      processing = true;
      while (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        try {
          await onLine(line);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[runSpawnedJsonl] onLine threw; continuing:', err);
        }
      }
      processing = false;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let nl = stdoutBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line.length > 0) lineQueue.push(line);
        nl = stdoutBuffer.indexOf('\n');
      }
      void processQueue();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', async (code) => {
      if (timeout) clearTimeout(timeout);
      // Flush any trailing partial line (if writer didn't end on \n).
      if (stdoutBuffer.length > 0) {
        lineQueue.push(stdoutBuffer);
        stdoutBuffer = '';
      }
      await processQueue();
      resolvePromise({
        exitCode: timedOut ? 124 : code ?? 0,
        stderr,
      });
    });
  });
}

/**
 * Stub executor for tests: takes a static array of JSONL lines and
 * yields them to onLine synchronously.
 */
export function makeStubStreamingExecutor(
  lines: ReadonlyArray<string>,
  exitCode = 0,
  stderr = '',
): StreamingExecutor {
  return async (_args, onLine) => {
    for (const line of lines) {
      await onLine(line);
    }
    return { exitCode, stderr };
  };
}

// Suppress ts-unused for Readable export (may be useful in future).
export type { Readable };
