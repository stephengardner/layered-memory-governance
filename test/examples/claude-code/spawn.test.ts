import { describe, it, expect } from 'vitest';
import { spawnClaudeCli } from '../../../examples/agent-loops/claude-code/spawn.js';

describe('spawnClaudeCli', () => {
  it('uses claude binary by default and sets cwd via execa option', async () => {
    const calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> = [];
    const stub = (async (bin: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ bin, args, opts });
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    }) as never;
    await spawnClaudeCli({
      prompt: 'hello',
      workspaceDir: '/tmp/x',
      budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1.5 },
      disallowedTools: [],
      execImpl: stub,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe('claude');
    expect(calls[0]!.opts['cwd']).toBe('/tmp/x');
  });

  it('argv contains -p prompt + stream-json + verbose + max-budget-usd + mcp-config', async () => {
    const calls: Array<{ args: string[] }> = [];
    const stub = (async (_b: string, args: string[]) => {
      calls.push({ args });
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    }) as never;
    await spawnClaudeCli({
      prompt: 'hello',
      workspaceDir: '/tmp/x',
      budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 0.5 },
      disallowedTools: [],
      execImpl: stub,
    });
    const args = calls[0]!.args;
    expect(args).toContain('-p');
    expect(args).toContain('hello');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('0.5');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('{"mcpServers":{}}');
  });

  it('argv includes --disallowedTools with space-joined list when non-empty', async () => {
    let captured: string[] = [];
    const stub = (async (_b: string, args: string[]) => {
      captured = args;
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    }) as never;
    await spawnClaudeCli({
      prompt: 'h',
      workspaceDir: '/tmp/x',
      budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
      disallowedTools: ['Bash', 'Read'],
      execImpl: stub,
    });
    const idx = captured.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(captured[idx + 1]).toBe('Bash Read');
  });

  it('argv omits --disallowedTools when list is empty', async () => {
    let captured: string[] = [];
    const stub = (async (_b: string, args: string[]) => {
      captured = args;
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    }) as never;
    await spawnClaudeCli({
      prompt: 'h',
      workspaceDir: '/tmp/x',
      budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
      disallowedTools: [],
      execImpl: stub,
    });
    expect(captured).not.toContain('--disallowedTools');
  });

  it('passes max_usd=0 (no-spend cap) through correctly', async () => {
    let captured: string[] = [];
    const stub = (async (_b: string, args: string[]) => {
      captured = args;
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    }) as never;
    await spawnClaudeCli({
      prompt: 'h',
      workspaceDir: '/tmp/x',
      budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 0 },
      disallowedTools: [],
      execImpl: stub,
    });
    const idx = captured.indexOf('--max-budget-usd');
    expect(idx).toBeGreaterThan(-1);
    expect(captured[idx + 1]).toBe('0');
  });

  it('uses opts.claudePath when provided', async () => {
    const calls: Array<{ bin: string }> = [];
    const stub = (async (bin: string) => {
      calls.push({ bin });
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    }) as never;
    await spawnClaudeCli({
      prompt: 'h',
      workspaceDir: '/tmp/x',
      budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
      disallowedTools: [],
      execImpl: stub,
      claudePath: '/opt/claude',
    });
    expect(calls[0]!.bin).toBe('/opt/claude');
  });
});
