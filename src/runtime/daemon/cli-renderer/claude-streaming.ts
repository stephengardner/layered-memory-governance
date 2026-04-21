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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { emptyAccumulator, parseClaudeStreamLine } from './claude-stream-parser.js';
import type { CliRendererEvent } from './types.js';

/**
 * Tools the streaming Claude CLI should NOT have access to.
 *
 * Mirrors invoke-claude.ts DEFAULT_DISALLOWED_TOOLS so the streaming
 * and non-streaming paths have the same tool surface. If this drifts,
 * the streaming path silently becomes more permissive than the
 * non-streaming one. Keep them in sync when either changes.
 */
const DEFAULT_DISALLOWED_TOOLS: ReadonlyArray<string> = [
  'Bash',
  'Edit',
  'Read',
  'Write',
  'Glob',
  'Grep',
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'SlashCommand',
];

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
  options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal },
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
  /**
   * Optional abort signal. When aborted, the spawned Claude CLI is
   * terminated (SIGTERM, then SIGKILL after a 500ms grace). The call
   * still resolves with the partial accumulator state; exitCode
   * reflects termination. Callers detect cancellation via
   * signal.aborted in the returned promise's continuation.
   */
  readonly signal?: AbortSignal;
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
  let tmpDir: string | null = null;
  let systemFile: string | null = null;

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
    '--disallowedTools',
    DEFAULT_DISALLOWED_TOOLS.join(' '),
    '--disable-slash-commands',
    '--mcp-config',
    '{"mcpServers":{}}',
  ];
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

  try {
    // Write the system prompt to a tmp file rather than the argv so
    // it does not leak via process listings (mirrors invoke-claude.ts).
    // The mkdtemp/writeFile lives INSIDE try so a writeFile failure
    // still hits the finally cleanup; otherwise a failed write would
    // orphan the created temp directory.
    if (options.systemPrompt !== undefined) {
      tmpDir = await mkdtemp(join(tmpdir(), 'lag-claude-streaming-'));
      systemFile = join(tmpDir, `system-${randomBytes(4).toString('hex')}.txt`);
      await writeFile(systemFile, options.systemPrompt, 'utf8');
      args.push('--append-system-prompt-file', systemFile);
    }

    const result = await exec(args, handleLine, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return {
      text: acc.assistantText,
      thinking: acc.thinkingText,
      meta: acc.meta,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  } finally {
    if (tmpDir !== null) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
  }
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
  options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal },
): Promise<StreamingExecResult> {
  return await new Promise<StreamingExecResult>((resolvePromise, reject) => {
    // Early-exit if the caller handed us an already-aborted signal.
    // Otherwise we would spawn a child just to immediately kill it in
    // the abort listener; wasted fork + SIGTERM, zero useful work.
    if (options.signal?.aborted) {
      resolvePromise({ exitCode: 130, stderr: '' });
      return;
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdoutBuffer = '';
    const lineQueue: string[] = [];
    // Active drain as a Promise, not a boolean flag. The close handler
    // needs to wait for any in-flight onLine to finish; a boolean let
    // the close path resolve while a pending await was still
    // processing, so callers got partial text and could miss the
    // terminal event.
    let processingPromise: Promise<void> | null = null;
    let timedOut = false;
    let aborted = false;
    // Tracks whether the child has actually exited. The 'close' event
    // flips this to true. Used by the SIGKILL escalation so we do NOT
    // look at child.killed, which Node sets to true as soon as the
    // SIGTERM kill(2) call returns successfully (even though the
    // process may still be running and ignoring the signal).
    let childExited = false;

    // SIGTERM first, then escalate to SIGKILL after a short grace so a
    // child that ignores or delays the term signal cannot hold the
    // promise open past the caller's configured timeout. timeoutMs is
    // a hard upper bound.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* already exited */ }
          killTimer = setTimeout(() => {
            if (!childExited) {
              try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }
          }, 500);
          killTimer.unref?.();
        }, options.timeoutMs)
      : null;

    // AbortSignal support: caller can cancel the run externally (Stop
    // button, parent-actor abort, etc.). SIGTERM first, SIGKILL after
    // a short grace if the child does not exit. Same `childExited`
    // guard as the timeout ladder: `child.killed` cannot be trusted
    // because Node flips it on a successful kill(2) return, not on
    // actual exit, so SIGKILL would never fire for a TERM-ignoring
    // child.
    let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
    const abortListener = (): void => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      abortKillTimer = setTimeout(() => {
        if (!childExited) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 500);
      abortKillTimer.unref?.();
    };
    if (options.signal) {
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    const processQueue = (): Promise<void> => {
      if (processingPromise) return processingPromise;
      processingPromise = (async (): Promise<void> => {
        while (lineQueue.length > 0) {
          const line = lineQueue.shift()!;
          try {
            await onLine(line);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[runSpawnedJsonl] onLine threw; continuing:', err);
          }
        }
      })().finally(() => {
        processingPromise = null;
      });
      return processingPromise;
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
      childExited = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      reject(err);
    });
    child.on('close', async (code) => {
      childExited = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      // Flush any trailing partial line (if writer didn't end on \n).
      if (stdoutBuffer.length > 0) {
        lineQueue.push(stdoutBuffer);
        stdoutBuffer = '';
      }
      await processQueue();
      resolvePromise({
        exitCode: aborted ? 130 : timedOut ? 124 : code ?? 0,
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
