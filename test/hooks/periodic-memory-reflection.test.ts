/**
 * Regression tests for .claude/hooks/periodic-memory-reflection.mjs.
 *
 * Covered contract:
 *   - Injects a reflection prompt exactly every Nth tool call.
 *   - Silent (no stdout) on the other N-1 calls.
 *   - Counter is session-scoped: new session_id starts at 1.
 *   - Env LAG_MEMORY_REFLECTION_DISABLED=1 fully disables the hook.
 *   - Env LAG_MEMORY_REFLECTION_EVERY overrides N.
 *   - Malformed / unsafe session ids do not trigger a prompt (no
 *     counter file gets written under an arbitrary path).
 *   - The emitted JSON shape matches the Claude Code PostToolUse
 *     additionalContext contract.
 *
 * Each test uses a fresh tmp dir as the repo root so the counter
 * file lands somewhere throwaway.
 */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REAL_HOOK = resolve('.claude/hooks/periodic-memory-reflection.mjs');

interface HookResult {
  readonly additionalContext: string | null;
  readonly exitCode: number;
  readonly stderr: string;
}

async function runHookIn(
  repoRoot: string,
  payload: unknown,
  env: Record<string, string> = {},
): Promise<HookResult> {
  const hookPath = join(repoRoot, '.claude', 'hooks', 'periodic-memory-reflection.mjs');
  const child = spawn('node', [hookPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Start from a clean env for each test; opt-in the specific
      // variables each case needs.
      LAG_MEMORY_REFLECTION_EVERY: '',
      LAG_MEMORY_REFLECTION_DISABLED: '',
      ...env,
    },
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
  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (stdout.length === 0) {
    return { additionalContext: null, exitCode, stderr };
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
  };
  return {
    additionalContext: parsed.hookSpecificOutput?.additionalContext ?? null,
    exitCode,
    stderr,
  };
}

describe('periodic-memory-reflection hook', () => {
  let repoRoot: string;

  beforeEach(() => {
    // Minimal repo skeleton: just the hook file in place so the
    // hook computes STATE_DIR off of its own __dirname/../.. and
    // lands counter files inside the tmp dir.
    repoRoot = mkdtempSync(join(tmpdir(), 'lag-reflect-test-'));
    mkdirSync(join(repoRoot, '.claude', 'hooks'), { recursive: true });
    copyFileSync(
      REAL_HOOK,
      join(repoRoot, '.claude', 'hooks', 'periodic-memory-reflection.mjs'),
    );
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      // tmpdir on Windows may briefly hold a handle.
    }
  });

  it('stays silent on calls below the threshold', async () => {
    const session = 'session-alpha';
    for (let i = 1; i <= 4; i++) {
      const r = await runHookIn(
        repoRoot,
        { session_id: session, tool_name: 'Bash', tool_input: {} },
        { LAG_MEMORY_REFLECTION_EVERY: '5' },
      );
      expect(r.additionalContext).toBe(null);
      expect(r.exitCode).toBe(0);
    }
  });

  it('injects the reflection prompt on the Nth call', async () => {
    const session = 'session-beta';
    let injected: string | null = null;
    for (let i = 1; i <= 5; i++) {
      const r = await runHookIn(
        repoRoot,
        { session_id: session, tool_name: 'Edit', tool_input: {} },
        { LAG_MEMORY_REFLECTION_EVERY: '5' },
      );
      if (i < 5) expect(r.additionalContext).toBe(null);
      else injected = r.additionalContext;
    }
    expect(injected).not.toBe(null);
    expect(injected!).toMatch(/memory-reflection/);
    // Weighted toward "skip" as the default outcome. The reminder
    // must be terser than the save path so Claude does not default
    // to synthesising an atom on every nudge.
    expect(injected!).toMatch(/Default: skip/);
    expect(injected!).toMatch(/Most nudges should no-op/);
    // Operator-stated gate is explicit so Claude does not
    // self-originate a directive and route it through /decide.
    expect(injected!).toMatch(/operator STATED/);
    // /decide is still mentioned but flagged as rare and gated.
    expect(injected!).toMatch(/\/decide/);
    expect(injected!).toMatch(/rare/);
    expect(injected!).toMatch(/auto-memory/);
  });

  it('counter is per-session (two session ids increment independently)', async () => {
    const runs = async (session: string, n: number) => {
      let lastCtx: string | null = null;
      for (let i = 0; i < n; i++) {
        const r = await runHookIn(
          repoRoot,
          { session_id: session, tool_name: 'Bash', tool_input: {} },
          { LAG_MEMORY_REFLECTION_EVERY: '3' },
        );
        lastCtx = r.additionalContext;
      }
      return lastCtx;
    };
    // Session A fires on its 3rd call.
    expect(await runs('session-a', 3)).not.toBe(null);
    // Session B is unaffected by A's count; its 2nd call is
    // still silent.
    expect(await runs('session-b', 2)).toBe(null);
    // Session B's 3rd call fires (its own count hits 3).
    expect(await runs('session-b', 1)).not.toBe(null);
  });

  it('fires again on 2N, 3N, ...', async () => {
    const session = 'session-multi';
    const hits: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const r = await runHookIn(
        repoRoot,
        { session_id: session, tool_name: 'Bash', tool_input: {} },
        { LAG_MEMORY_REFLECTION_EVERY: '3' },
      );
      if (r.additionalContext !== null) hits.push(i);
    }
    expect(hits).toEqual([3, 6, 9]);
  });

  it('LAG_MEMORY_REFLECTION_DISABLED=1 disables the hook entirely', async () => {
    const session = 'session-disabled';
    for (let i = 1; i <= 6; i++) {
      const r = await runHookIn(
        repoRoot,
        { session_id: session, tool_name: 'Bash', tool_input: {} },
        {
          LAG_MEMORY_REFLECTION_EVERY: '3',
          LAG_MEMORY_REFLECTION_DISABLED: '1',
        },
      );
      expect(r.additionalContext).toBe(null);
      expect(r.exitCode).toBe(0);
    }
  });

  it('rejects unsafe session ids silently (no file written outside guard)', async () => {
    const r = await runHookIn(
      repoRoot,
      {
        session_id: '../../../etc/passwd',
        tool_name: 'Bash',
        tool_input: {},
      },
      { LAG_MEMORY_REFLECTION_EVERY: '1' },
    );
    expect(r.additionalContext).toBe(null);
    expect(r.exitCode).toBe(0);
    // Assert the actual filesystem side-effect, not just the
    // absence of the prompt: the guard dir must not exist at all
    // for a rejected session id (safe-session regex is meant to
    // short-circuit BEFORE any mkdir / openSync / lock / counter
    // file touches disk).
    expect(existsSync(join(repoRoot, '.lag', 'session-memory-reflection'))).toBe(false);
  });

  it('missing session_id is a silent no-op', async () => {
    const r = await runHookIn(
      repoRoot,
      { tool_name: 'Bash', tool_input: {} },
      { LAG_MEMORY_REFLECTION_EVERY: '1' },
    );
    expect(r.additionalContext).toBe(null);
    expect(r.exitCode).toBe(0);
  });

  it('fails open on malformed payload', async () => {
    const hookPath = join(repoRoot, '.claude', 'hooks', 'periodic-memory-reflection.mjs');
    const child = spawn('node', [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('{not-json');
    child.stdin.end();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    const exitCode: number = await new Promise((res, rej) => {
      child.on('close', (code) => res(code ?? 0));
      child.on('error', rej);
    });
    expect(exitCode).toBe(0);
    // Fail-open means: exit 0 AND no output. A stderr dump from
    // an unhandled error would mean the hook crashed loudly
    // rather than silently failing open, which still pollutes
    // the session's log surface.
    expect(Buffer.concat(stdoutChunks).toString('utf8')).toBe('');
    expect(Buffer.concat(stderrChunks).toString('utf8')).toBe('');
  });

  // 25 sequential subprocess spawns -> ~10s on Windows. Default
  // vitest timeout is 10_000 which leaves no slack; bump to 30s.
  it('falls back to default N=25 when env is unset', { timeout: 30_000 }, async () => {
    const session = 'session-default';
    // 24 should be silent; 25th should fire.
    for (let i = 1; i <= 24; i++) {
      const r = await runHookIn(repoRoot, {
        session_id: session,
        tool_name: 'Bash',
        tool_input: {},
      });
      expect(r.additionalContext).toBe(null);
    }
    const last = await runHookIn(repoRoot, {
      session_id: session,
      tool_name: 'Bash',
      tool_input: {},
    });
    expect(last.additionalContext).not.toBe(null);
    // The prompt embeds the count as "Tool call #25".
    expect(last.additionalContext!).toMatch(/Tool call #25/);
    expect(last.additionalContext!).toMatch(/nudge every 25/);
  });

  it('counter is serialized under concurrent writes (no lost increments)', async () => {
    const session = 'session-concurrent';
    const parallel = 10;
    // Launch `parallel` hook subprocesses concurrently for the
    // same session. If the read-modify-write is NOT serialized,
    // two or more will read the same base count and produce the
    // same post-increment value, so the final count ends up <
    // parallel. The lock makes the final count exactly parallel.
    const runs = Array.from({ length: parallel }, () =>
      runHookIn(
        repoRoot,
        { session_id: session, tool_name: 'Bash', tool_input: {} },
        { LAG_MEMORY_REFLECTION_EVERY: String(parallel) },
      ),
    );
    const results = await Promise.all(runs);
    // Exactly one of the parallel runs should have landed on the
    // Nth-call (count === parallel) and emitted the nudge.
    const hits = results.filter((r) => r.additionalContext !== null);
    expect(hits.length).toBe(1);
    // The counter file's terminal value must be exactly `parallel`.
    const counterPath = join(
      repoRoot,
      '.lag',
      'session-memory-reflection',
      `${session}.json`,
    );
    const parsed = JSON.parse(readFileSync(counterPath, 'utf8'));
    expect(parsed.count).toBe(parallel);
  });

  it('emitted JSON matches the PostToolUse additionalContext contract', async () => {
    const session = 'session-shape';
    // Burn down to just before the trigger.
    for (let i = 1; i <= 2; i++) {
      await runHookIn(
        repoRoot,
        { session_id: session, tool_name: 'Bash', tool_input: {} },
        { LAG_MEMORY_REFLECTION_EVERY: '3' },
      );
    }
    // Raw-stdout capture so we can assert the envelope shape too.
    // Explicitly clear LAG_MEMORY_REFLECTION_DISABLED in case a
    // dev is running tests with it exported - inherited env would
    // silently short-circuit the hook and break the JSON.parse
    // below.
    const hookPath = join(repoRoot, '.claude', 'hooks', 'periodic-memory-reflection.mjs');
    const child = spawn('node', [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LAG_MEMORY_REFLECTION_EVERY: '3',
        LAG_MEMORY_REFLECTION_DISABLED: '',
      },
    });
    child.stdin.write(JSON.stringify({
      session_id: session,
      tool_name: 'Bash',
      tool_input: {},
    }));
    child.stdin.end();
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    await new Promise((r) => child.on('close', r));
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('hookSpecificOutput');
    expect(parsed.hookSpecificOutput).toHaveProperty('hookEventName', 'PostToolUse');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(50);
  });
});
