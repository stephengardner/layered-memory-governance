// Regression tests for .claude/hooks/enforce-pr-status-composite.mjs.
//
// The hook blocks ad-hoc PR state reads and redirects them to the
// composite observer (scripts/pr-status.mjs). Earlier version only
// caught bare `gh pr view` - `gh-as.mjs lag-ceo pr view <N>` slipped
// through (2026-04-22 incident: I made merge decisions on partial
// CR state multiple times because my wrapper calls weren't caught).
//
// These tests pin the wrapper-agnostic matching so a future refactor
// that strips the wrapper patterns fails loudly.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = resolve('.claude/hooks/enforce-pr-status-composite.mjs');

interface HookResult {
  readonly decision: 'block' | 'allow';
  readonly reason: string | null;
}

async function runHook(command: string): Promise<HookResult> {
  const payload = { tool_name: 'Bash', tool_input: { command } };
  const child = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (exitCode !== 0) {
    throw new Error(`hook exited ${exitCode}. stderr: ${stderr}`);
  }
  const out = Buffer.concat(stdoutChunks).toString('utf8').trim();
  if (out.length === 0) return { decision: 'allow', reason: null };
  const parsed = JSON.parse(out);
  return { decision: parsed.decision ?? 'allow', reason: parsed.reason ?? null };
}

describe('enforce-pr-status-composite hook (bare gh)', () => {
  it('blocks `gh pr view <N>`', async () => {
    const r = await runHook('gh pr view 101');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('MATCHED  : pr view');
  });

  it('blocks `gh pr checks <N>`', async () => {
    const r = await runHook('gh pr checks 101');
    expect(r.decision).toBe('block');
  });

  it('blocks `gh api repos/o/r/pulls/123`', async () => {
    const r = await runHook('gh api repos/stephengardner/lag/pulls/123');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('pulls/<N>');
  });

  it('blocks `gh api repos/o/r/commits/<sha>/status`', async () => {
    const r = await runHook('gh api repos/stephengardner/lag/commits/abc123/status');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('status');
  });

  it('blocks `gh api repos/o/r/commits/<sha>/check-runs`', async () => {
    const r = await runHook('gh api repos/stephengardner/lag/commits/abc123/check-runs');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('check-runs');
  });
});

describe('enforce-pr-status-composite hook (gh-as.mjs wrapper)', () => {
  // These are the cases the OLD regex missed. The agent convention in
  // this repo is `node scripts/gh-as.mjs <role> gh-args...`; EVERY
  // real-world state read went through this wrapper. The hook must
  // catch these or it's decorative.

  it('blocks `node scripts/gh-as.mjs lag-ceo pr view 101`', async () => {
    const r = await runHook('node scripts/gh-as.mjs lag-ceo pr view 101');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('MATCHED  : pr view');
  });

  it('blocks `node scripts/gh-as.mjs lag-cto pr checks 42`', async () => {
    const r = await runHook('node scripts/gh-as.mjs lag-cto pr checks 42');
    expect(r.decision).toBe('block');
  });

  it('blocks gh-as api call for /pulls/<N>', async () => {
    const r = await runHook('node scripts/gh-as.mjs lag-ceo api repos/stephengardner/lag/pulls/101');
    expect(r.decision).toBe('block');
  });

  it('blocks gh-as api call for /commits/<sha>/status', async () => {
    const r = await runHook(
      'node scripts/gh-as.mjs lag-ceo api repos/stephengardner/lag/commits/abc123/status',
    );
    expect(r.decision).toBe('block');
  });

  it('blocks gh-as api call for /commits/<sha>/check-runs', async () => {
    const r = await runHook(
      'node scripts/gh-as.mjs lag-ceo api repos/stephengardner/lag/commits/abc123/check-runs',
    );
    expect(r.decision).toBe('block');
  });

  it('blocks gh-as with --json flag on pr view', async () => {
    const r = await runHook(
      'node scripts/gh-as.mjs lag-ceo pr view 101 --json state,mergeStateStatus',
    );
    expect(r.decision).toBe('block');
  });

  it('blocks gh-as state-read embedded in compound && chain', async () => {
    // Mixed chain: one allowed clause + one state read. Must block on
    // the state read clause.
    const r = await runHook(
      'echo hello && node scripts/gh-as.mjs lag-ceo pr view 101',
    );
    expect(r.decision).toBe('block');
  });

  it('blocks gh-as state-read inside $(...) substitution', async () => {
    const r = await runHook(
      'result=$(node scripts/gh-as.mjs lag-ceo pr view 101)',
    );
    expect(r.decision).toBe('block');
  });
});

describe('enforce-pr-status-composite hook (write operations pass through)', () => {
  // Writes are legitimate action surfaces; this hook only gates READS.

  it('allows `gh pr create`', async () => {
    const r = await runHook('gh pr create --title X --body Y');
    expect(r.decision).toBe('allow');
  });

  it('allows `gh pr merge`', async () => {
    const r = await runHook('gh pr merge 101 --squash');
    expect(r.decision).toBe('allow');
  });

  it('allows `gh pr comment`', async () => {
    const r = await runHook('gh pr comment 101 --body "@coderabbitai review"');
    expect(r.decision).toBe('allow');
  });

  it('allows `gh api .../pulls/<N>/comments` (POST or LIST)', async () => {
    const r = await runHook(
      'gh api repos/stephengardner/lag/pulls/101/comments -X POST --input -',
    );
    expect(r.decision).toBe('allow');
  });

  it('allows `gh api .../pulls/<N>/merge`', async () => {
    const r = await runHook('gh api repos/stephengardner/lag/pulls/101/merge');
    expect(r.decision).toBe('allow');
  });

  it('allows gh-as.mjs pr merge (same rule via wrapper)', async () => {
    const r = await runHook('node scripts/gh-as.mjs lag-ceo pr merge 101 --squash');
    expect(r.decision).toBe('allow');
  });

  it('allows gh-as.mjs pr create', async () => {
    const r = await runHook(
      'node scripts/gh-as.mjs lag-ceo pr create --title X --body Y',
    );
    expect(r.decision).toBe('allow');
  });
});

describe('enforce-pr-status-composite hook (sanctioned CLI passes through)', () => {
  it('allows `node scripts/pr-status.mjs <N>`', async () => {
    const r = await runHook('node scripts/pr-status.mjs 101');
    expect(r.decision).toBe('allow');
  });

  it('allows pr-status.mjs with flags', async () => {
    const r = await runHook(
      'node scripts/pr-status.mjs 101 --owner o --repo r',
    );
    expect(r.decision).toBe('allow');
  });
});

describe('enforce-pr-status-composite hook (escape hatch)', () => {
  it('honours `# allow-partial-pr-read` comment to bypass', async () => {
    const r = await runHook(
      'gh pr view 101 --json state  # allow-partial-pr-read',
    );
    expect(r.decision).toBe('allow');
  });
});

describe('enforce-pr-status-composite hook (unrelated tools)', () => {
  it('allows Bash commands that never mention gh', async () => {
    const r = await runHook('ls -la && cat package.json');
    expect(r.decision).toBe('allow');
  });

  it('allows `git` commands (not gh)', async () => {
    const r = await runHook('git log --oneline -5');
    expect(r.decision).toBe('allow');
  });

  it('allows a node script that mentions gh in an identifier', async () => {
    // A false-positive would be "any command containing 'gh' somewhere"
    // matching legitimate work. The hook has a fast-path that exits
    // if `gh` isn't a word on its own; verify.
    const r = await runHook('node -e "console.log(\'ght\')"');
    expect(r.decision).toBe('allow');
  });
});
