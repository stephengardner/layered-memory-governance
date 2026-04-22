/**
 * CLI-based MessagesClient adapter.
 *
 * Adapts the Claude Code CLI (`claude -p`) to the MessagesClient surface
 * the agent-process depends on, so the virtual-org bootstrap runs
 * without ANTHROPIC_API_KEY. Authentication comes from the operator's
 * existing Claude Code OAuth install.
 *
 * Shape:
 *   createCliClient({ claudePath?, timeoutMs?, maxBudgetUsd?, execImpl? })
 *     -> MessagesClient
 *
 * A `messages.create` call translates the system prompt + messages into
 * a single user-facing prompt, pipes that to `claude -p` via stdin, and
 * returns the CLI's free-form `result` as a single text content block.
 *
 * Why not layer on top of ClaudeCliLLM:
 *   ClaudeCliLLM is a schema-bound judge surface (`judge<T>(schema,...)`
 *   that sets `--json-schema` and parses `envelope.structured_output`).
 *   The deliberation agent-process returns free-form JSON (parsed
 *   tolerantly via regex in `parseJsonObject`), not schema-bound output.
 *   Forcing a schema through the judge would over-constrain the
 *   response shape and couple this integration to the judge surface's
 *   anti-tool-use preamble. Cleaner: spawn claude -p directly, mirror
 *   the argv-safe + stdin-piped shape ClaudeCliLLM established.
 *
 * Thinking blocks from the CLI are signature-only per
 * docs/claude-code-session-persistence.md; the adapter returns an empty
 * thinking array. Callers wanting plaintext thinking must use the SDK
 * backend (anthropic via @anthropic-ai/sdk + ANTHROPIC_API_KEY).
 *
 * Tool use is disabled via --disallowedTools (a broad deny-list) and
 * --disable-slash-commands. MCP servers are also disabled via an
 * empty --mcp-config so deliberation turns do not silently start up
 * every configured server.
 */

import { execa, type ExecaError } from 'execa';
import type {
  MessagesClient,
} from './agent-process.js';

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface CreateCliClientOptions {
  /** Path to the claude binary. Defaults to "claude" on PATH. */
  readonly claudePath?: string;
  /** Subprocess timeout in ms. Default: 600000 (10 minutes). */
  readonly timeoutMs?: number;
  /**
   * Upper-bound budget passed to the CLI via --max-budget-usd. Default:
   * 2.0. Per-request knob; messages.create does not accept a budget so
   * this is an adapter-level ceiling. A runaway thinking pass still
   * terminates instead of burning the operator's day.
   */
  readonly maxBudgetUsd?: number;
  /** Tools to block. Defaults to a comprehensive deny-list. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** Pass extra args to every invocation (advanced). */
  readonly extraArgs?: ReadonlyArray<string>;
  /** If true, log the command line to stderr for debugging. */
  readonly verbose?: boolean;
  /**
   * Injectable exec implementation for tests. Takes (binary, args,
   * execaOptions) and returns the execa result shape. Defaults to the
   * real execa. Tests pass a stub that records the call and synthesizes
   * a response, so the adapter can be exercised without spawning a real
   * process.
   */
  readonly execImpl?: typeof execa;
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

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUDGET_USD = 2.0;

// ---------------------------------------------------------------------------
// CLI envelope shape
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCliClient(opts: CreateCliClientOptions = {}): MessagesClient {
  const claudePath = opts.claudePath ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBudgetUsd = opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const disallowed = (opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS).join(' ');
  const exec = opts.execImpl ?? execa;
  const extraArgs = opts.extraArgs ?? [];

  return {
    messages: {
      async create(args) {
        const prompt = composePrompt(args.system, args.messages);

        const argv: string[] = [
          '-p',
          '--model',
          args.model,
          '--max-budget-usd',
          String(maxBudgetUsd),
          '--output-format',
          'json',
          '--disallowedTools',
          disallowed,
          '--disable-slash-commands',
          '--mcp-config',
          '{"mcpServers":{}}',
          ...extraArgs,
        ];

        if (opts.verbose) {
          // eslint-disable-next-line no-console
          console.error('[cli-client]', claudePath, argv.join(' '));
        }

        let execResult;
        try {
          execResult = await exec(claudePath, argv, {
            timeout: timeoutMs,
            reject: false,
            stripFinalNewline: true,
            // Prompt goes via stdin to avoid the Windows argv ceiling
            // (see ClaudeCliLLM for the full regression writeup).
            input: prompt,
          });
        } catch (err) {
          if (isExecaError(err) && err.timedOut) {
            throw new Error(
              `[cli-client] claude cli timed out after ${timeoutMs}ms`,
              { cause: err },
            );
          }
          if (
            isExecaError(err)
            && (err.code === 'ENOENT' || (err.message ?? '').includes('not found'))
          ) {
            throw new Error(
              `[cli-client] claude cli not found. Install Claude Code or set claudePath in createCliClient options.`,
              { cause: err },
            );
          }
          throw err;
        }

        const stdout = execResult.stdout ?? '';
        const stderr = execResult.stderr ?? '';

        // Auth missing: surfaces as plain text on stdout or stderr.
        if (stdout.includes('Not logged in') || stderr.includes('Not logged in')) {
          throw new Error(
            '[cli-client] claude cli not authenticated. Run `claude /login` to authenticate via OAuth.',
          );
        }

        if (execResult.exitCode !== 0) {
          throw new Error(
            `[cli-client] claude cli exit=${execResult.exitCode}: `
              + `stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`,
          );
        }

        let envelope: CliEnvelope;
        try {
          envelope = JSON.parse(stdout);
        } catch {
          throw new Error(
            `[cli-client] claude cli did not return JSON envelope. stdout=${stdout.slice(0, 300)}`,
          );
        }

        if (envelope.is_error) {
          throw new Error(
            `[cli-client] envelope reports error: ${envelope.error ?? stdout.slice(0, 300)}`,
          );
        }

        const body = envelope.result ?? '';
        // Return a MessageCreateResult shape. Thinking from the CLI is
        // signature-only so we return no thinking block; the text block
        // carries the response body unchanged. agent-process parses
        // JSON tolerantly from the text block (parseJsonObject accepts
        // markdown fences), so we pass the body through as-is.
        return {
          content: [{ type: 'text', text: body }],
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Translate a MessagesClient system + messages pair into a single
 * prompt the CLI receives on stdin. The system prompt is prepended with
 * a clear separator so the model can distinguish instructions from user
 * content. The CLI's default frame still surrounds this string; the
 * frame plus our preamble is what drives the response.
 */
function composePrompt(
  system: string,
  messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>,
): string {
  const lines: string[] = [];
  if (system.length > 0) {
    lines.push(system);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  for (const m of messages) {
    lines.push(m.content);
  }
  return lines.join('\n');
}

function isExecaError(err: unknown): err is ExecaError {
  return typeof err === 'object' && err !== null && 'exitCode' in err;
}
