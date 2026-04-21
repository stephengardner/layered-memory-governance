/**
 * Regression tests for .claude/hooks/enforce-lag-ceo-for-gh.mjs.
 *
 * The hook is the mechanical gate that keeps every GitHub-side write
 * the agent makes in this repo routed through lag-ceo[bot]. Two
 * attack surfaces are covered:
 *
 *   1. Bash tool with a raw `gh` CLI call (the original bypass).
 *   2. `mcp__github__*` tools from the GitHub MCP server (the PR #61
 *      bypass, 2026-04-21).
 *
 * The hook is a stdin/stdout protocol: Claude Code writes a JSON
 * payload on stdin and reads optionally a JSON decision on stdout.
 * An empty stdout means "allow". A `{"decision":"block","reason":...}`
 * stdout means the tool call is rejected and the reason surfaces to
 * the agent.
 *
 * These tests spawn the hook as a subprocess and assert the decision
 * output for each payload, so the contract is pinned end-to-end.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = resolve('.claude/hooks/enforce-lag-ceo-for-gh.mjs');

interface HookResult {
  readonly decision: 'block' | 'allow';
  readonly reason: string | null;
  readonly exitCode: number;
}

async function runHook(payload: unknown): Promise<HookResult> {
  const child = spawn('node', [HOOK_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const exitCode: number = await new Promise((res, rej) => {
    child.on('close', (code) => res(code ?? 0));
    child.on('error', rej);
  });

  // The hook is documented as fail-open (exit 0 on any crash) and
  // every success path also exits 0. A non-zero exit means the hook
  // itself crashed in a way that bypasses both the allow and block
  // contracts, which would silently masquerade as "allow" (empty
  // stdout) and make allow-path tests false-positive. Fail hard so
  // the contract is the test's assertion, not an accident of the
  // script's crash behaviour. Surface stderr in the failure message
  // so the cause is visible in CI output.
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (exitCode !== 0) {
    throw new Error(
      `enforce-lag-ceo-for-gh.mjs exited non-zero (${exitCode}); stderr:\n${stderr}`,
    );
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  if (stdout.length === 0) {
    return { decision: 'allow', reason: null, exitCode };
  }
  const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
  return {
    decision: parsed.decision === 'block' ? 'block' : 'allow',
    reason: parsed.reason ?? null,
    exitCode,
  };
}

describe('enforce-lag-ceo-for-gh hook (Bash path)', () => {
  it('blocks a raw gh pr create invocation', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title t --body b' },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/gh-as\.mjs lag-ceo/);
    expect(result.exitCode).toBe(0);
  });

  it('blocks gh embedded in a compound command chain', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd subdir && gh pr list --json number' },
    });
    expect(result.decision).toBe('block');
  });

  it('allows gh-as.mjs wrapper invocations', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'node scripts/gh-as.mjs lag-ceo pr create --title t --body b',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows gh-token-for.mjs wrapper invocations', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/gh-token-for.mjs lag-cto' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows the allow-raw-gh escape hatch', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh auth status # allow-raw-gh' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows a Bash command that never mentions gh', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('enforce-lag-ceo-for-gh hook (MCP github path)', () => {
  it('blocks mcp__github__create_pull_request (the PR #61 bypass)', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__create_pull_request',
      tool_input: {
        owner: 'stephengardner',
        repo: 'layered-autonomous-governance',
        title: 't',
        body: 'b',
        head: 'feat/x',
        base: 'main',
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/gh-as\.mjs lag-ceo/);
    expect(result.reason).toMatch(/PR #61/);
  });

  it('blocks mcp__github__merge_pull_request', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1 },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__pull_request_review_write', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__pull_request_review_write',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1, method: 'create' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__add_issue_comment', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__add_issue_comment',
      tool_input: { owner: 'o', repo: 'r', issue_number: 1, body: 'b' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__issue_write', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__issue_write',
      tool_input: { method: 'create' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__update_pull_request', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__update_pull_request',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1 },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__push_files', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__push_files',
      tool_input: { owner: 'o', repo: 'r', branch: 'x', files: [] },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__create_branch', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__create_branch',
      tool_input: { owner: 'o', repo: 'r', branch: 'x' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks an unknown mcp__github__ write (default-deny)', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__mystery_new_write_tool',
      tool_input: {},
    });
    expect(result.decision).toBe('block');
  });

  it('allows mcp__github__list_pull_requests', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__list_pull_requests',
      tool_input: { owner: 'o', repo: 'r' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__get_me', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__get_me',
      tool_input: {},
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__pull_request_read', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__pull_request_read',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1, method: 'get' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__issue_read', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__issue_read',
      tool_input: { owner: 'o', repo: 'r', issue_number: 1, method: 'get' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__search_code', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__search_code',
      tool_input: { query: 'q' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__get_file_contents', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__get_file_contents',
      tool_input: { owner: 'o', repo: 'r', path: 'x' },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('enforce-lag-ceo-for-gh hook (unrelated tools)', () => {
  it('allows Edit tool calls without inspection', async () => {
    const result = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows tools outside the github namespace', async () => {
    const result = await runHook({
      tool_name: 'mcp__jira__jira_create_issue',
      tool_input: {},
    });
    expect(result.decision).toBe('allow');
  });

  it('fails open on malformed payload', async () => {
    // Sending a non-JSON payload; the hook must not crash the session.
    const child = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('not-json{{{');
    child.stdin.end();

    const exitCode: number = await new Promise((res, rej) => {
      child.on('close', (code) => res(code ?? 0));
      child.on('error', rej);
    });
    expect(exitCode).toBe(0);
  });
});
