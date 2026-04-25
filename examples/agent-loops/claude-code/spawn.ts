/**
 * Execa wrapper for `claude -p` in agentic-streaming mode.
 *
 * cwd: workspace.path is set via execa's option (NOT a --cwd flag;
 * the CLI does not recognize --cwd). --verbose is REQUIRED for
 * --output-format stream-json to emit per-turn lines.
 */

import { execa, type ResultPromise, type execa as ExecaType } from 'execa';
import type { BudgetCap } from '../../../src/substrate/agent-budget.js';

export interface SpawnClaudeCliInput {
  readonly prompt: string;
  readonly workspaceDir: string;
  readonly budget: BudgetCap;
  readonly disallowedTools: ReadonlyArray<string>;
  readonly claudePath?: string;
  readonly extraArgs?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
  readonly execImpl?: typeof ExecaType;
}

export function spawnClaudeCli(input: SpawnClaudeCliInput): ResultPromise {
  const exec = input.execImpl ?? execa;
  const args: string[] = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--disable-slash-commands',
    '--mcp-config',
    '{"mcpServers":{}}',
  ];
  if (input.disallowedTools.length > 0) {
    args.push('--disallowedTools', input.disallowedTools.join(' '));
  }
  if (input.budget.max_usd !== undefined) {
    args.push('--max-budget-usd', String(input.budget.max_usd));
  }
  if (input.extraArgs !== undefined && input.extraArgs.length > 0) {
    args.push(...input.extraArgs);
  }
  return exec(input.claudePath ?? 'claude', args, {
    cwd: input.workspaceDir,
    env: process.env,
    stripFinalNewline: false,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }) as ResultPromise;
}
