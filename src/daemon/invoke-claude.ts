/**
 * Conversational `claude -p` invocation for the LAG daemon.
 *
 * Different from ClaudeCliLLM.judge() (which forces JSON schema output
 * for classifier-style calls). Here we want a free-form text response
 * that the daemon can relay to the user's Telegram chat.
 *
 * V1: tools disabled. The daemon is a chat surface, not a remote
 * execution surface. Spawning shells on the user's machine from a
 * message they sent from their phone needs stronger authz than we
 * ship today.
 *
 * Uses `claude -p` with OAuth auth from the user's Claude Code install.
 * No API key, no per-token billing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execa, type ExecaError } from 'execa';
import {
  TimeoutError,
  TransientError,
  UnsupportedError,
  ValidationError,
} from '../errors.js';

export interface InvokeClaudeOptions {
  /** Required. The user's message content. */
  readonly userMessage: string;
  /** Optional system prompt. Defaults to a minimal chat preamble. */
  readonly systemPrompt?: string;
  /** Default 'claude-haiku-4-5-20251001'. Override per invocation. */
  readonly model?: string;
  /** Default 1.00 USD per turn. Guards against runaway prompts. */
  readonly maxBudgetUsd?: number;
  /** Default 180_000 ms. */
  readonly timeoutMs?: number;
  /** Override claude binary path. Defaults to 'claude' on PATH. */
  readonly claudePath?: string;
  /** If true, print the command line to stderr for debugging. */
  readonly verbose?: boolean;
  /**
   * Directory to run `claude -p` from. IMPORTANT for context isolation:
   * Claude CLI uses the cwd to find a workspace CLAUDE.md and project
   * context. If you pass a neutral temp dir, the CLI falls back to the
   * most recent workspace in ~/.claude.json, which leaks unrelated
   * context. Default: the cwd of the node process (typically the LAG
   * repo root when the daemon is running).
   */
  readonly cwd?: string;
  /**
   * Session id to resume via `--resume`. When set, claude-cli loads
   * the full conversation context from
   * ~/.claude/projects/<sanitized>/<id>.jsonl and appends this turn
   * to it. Responses become part of that session so the terminal
   * Claude Code instance (if any) sees them on its next turn. Opt-in
   * for solo-dev continuity; do not enable for autonomous-org setups
   * where each message should be stateless. Cost per call = full
   * prior-context tokens.
   */
  readonly resumeSessionId?: string;
  /**
   * Runtime-revocation signal. When aborted, the claude child
   * process is SIGTERMed via execa's cancelSignal and the call
   * rejects with an AbortError. Callers that thread
   * `ActorContext.abortSignal` here get kill-switch propagation
   * into in-flight LLM streams without the call having to complete
   * or the timeout to elapse.
   */
  readonly signal?: AbortSignal;
}

export interface InvokeClaudeResult {
  /** The free-form text response. */
  readonly text: string;
  /** USD cost as reported by the CLI envelope. */
  readonly costUsd: number;
  /** Token counts. -1 if the envelope omitted them. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Wall-clock latency in ms. */
  readonly latencyMs: number;
}

interface CliEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly is_error?: boolean;
  readonly error?: string;
  readonly stop_reason?: string;
}

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

/**
 * Spawn `claude -p` and return the free-form text response. Throws on
 * timeout, auth failure, budget exceeded, or envelope errors. Normal
 * network transience is surfaced as TransientError so the daemon can
 * retry or route to an error message without crashing the poll loop.
 */
export async function invokeClaude(options: InvokeClaudeOptions): Promise<InvokeClaudeResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'lag-claude-chat-'));
  const systemFile = join(tmpDir, `system-${randomBytes(4).toString('hex')}.txt`);
  try {
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    await writeFile(systemFile, systemPrompt, 'utf8');

    const args: string[] = [
      '-p',
      options.userMessage,
      '--model',
      options.model ?? 'claude-haiku-4-5-20251001',
      '--max-budget-usd',
      String(options.maxBudgetUsd ?? 1.0),
      '--output-format',
      'json',
      '--append-system-prompt-file',
      systemFile,
      '--disallowedTools',
      DEFAULT_DISALLOWED_TOOLS.join(' '),
      '--disable-slash-commands',
      '--mcp-config',
      '{"mcpServers":{}}',
    ];

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    if (options.verbose) {
      // eslint-disable-next-line no-console
      console.error('[invokeClaude]', options.claudePath ?? 'claude', args.map(a => a.length > 80 ? `${a.slice(0, 80)}...` : a).join(' '));
    }

    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 180_000;

    let execResult;
    try {
      execResult = await execa(options.claudePath ?? 'claude', args, {
        timeout: timeoutMs,
        reject: false,
        stripFinalNewline: true,
        stdin: 'ignore',
        // cwd controls which workspace's CLAUDE.md and project state
        // Claude CLI loads. Default to the calling process's cwd so the
        // daemon, when run from the LAG repo, naturally loads LAG canon.
        cwd: options.cwd ?? process.cwd(),
        // cancelSignal SIGTERMs the claude child when the caller's
        // AbortSignal trips. Execa rejects with AbortError; the
        // outer catch lets it propagate, which is the right
        // behaviour: a caller-initiated abort is not a timeout and
        // not an ENOENT, so it should not be re-classified.
        ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
      });
    } catch (err) {
      if (isExecaError(err) && err.timedOut) {
        throw new TimeoutError(`Claude CLI exceeded ${timeoutMs}ms`, { cause: err });
      }
      if (isExecaError(err) && (err.code === 'ENOENT' || (err.message ?? '').includes('not found'))) {
        throw new UnsupportedError(
          `Claude CLI not found. Set InvokeClaudeOptions.claudePath or install claude on PATH.`,
          { cause: err },
        );
      }
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    const stdout = execResult.stdout ?? '';
    const stderr = execResult.stderr ?? '';

    if (stdout.includes('Not logged in') || stderr.includes('Not logged in')) {
      throw new UnsupportedError(
        'Claude CLI not authenticated. Run `claude /login` to authenticate via OAuth.',
      );
    }

    if (/rate.?limit|too many requests|429/i.test(stderr)) {
      throw new TransientError(`Claude CLI rate-limited: ${stderr.slice(0, 200)}`);
    }

    if (execResult.exitCode !== 0 && /Exceeded USD budget/i.test(stderr + stdout)) {
      throw new ValidationError(
        `Claude CLI exceeded max-budget-usd=${options.maxBudgetUsd ?? 1.0}; increase budget or tighten the prompt`,
      );
    }

    if (execResult.exitCode !== 0) {
      throw new ValidationError(
        `Claude CLI exit=${execResult.exitCode}: stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`,
      );
    }

    let envelope: CliEnvelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new ValidationError(
        `Claude CLI did not return JSON envelope. stdout=${stdout.slice(0, 300)}`,
      );
    }

    if (envelope.is_error) {
      throw new ValidationError(
        `Claude CLI envelope reports error: ${envelope.error ?? stdout.slice(0, 300)}`,
      );
    }

    const text = envelope.result ?? '';
    return {
      text,
      costUsd: envelope.total_cost_usd ?? -1,
      inputTokens: envelope.usage?.input_tokens ?? -1,
      outputTokens: envelope.usage?.output_tokens ?? -1,
      latencyMs,
    };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a conversational assistant running inside the LAG daemon, ' +
  'an ambient runtime reachable via Telegram. You respond to the user ' +
  'with plain text in a tone suited to chat. You do not call tools; ' +
  'all execution is delegated to the user\'s terminal. Treat the CANON ' +
  'block (when present in the prompt) as settled rules you must not ' +
  'contradict.';

function isExecaError(err: unknown): err is ExecaError {
  return typeof err === 'object' && err !== null && 'exitCode' in err;
}
