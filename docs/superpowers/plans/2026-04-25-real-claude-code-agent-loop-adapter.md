# Real Claude Code CLI Agent-Loop Adapter Implementation Plan (PR3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the substrate-validation skeleton at `examples/agent-loops/claude-code/loop.ts` with a production `AgentLoopAdapter` that spawns the Claude Code CLI in agentic-headless mode, streams turn-by-turn NDJSON, writes placeholder `agent-turn` atoms BEFORE each LLM call (per substrate contract), updates them as content lands, captures commit/branch artifacts via post-CLI git commands, and honors signal/budget cancellation.

**Architecture:** One CLI invocation per `run()` call (Claude Code iterates internally). The adapter is plumbing: spawn -> stream-parse -> atom-write -> artifact-capture -> signal-forward. Decomposed into 5 pure helpers (parser / prompt-builder / classifier / artifact-capturer / spawn-wrapper) plus the `ClaudeCodeAgentLoopAdapter` class that composes them through the substrate seam.

**Tech Stack:** Node.js, TypeScript, `execa`, `node:readline`, `node:crypto`, `node:fs/promises`, `vitest`. The substrate types come from `src/substrate/`. The CLI being spawned is the operator's existing `claude` binary (no API key; uses Claude Code OAuth).

**Spec source of truth:** `docs/superpowers/specs/2026-04-25-real-claude-code-agent-loop-adapter-design.md` (committed at `7d072fb`).

**Branch:** `pr3/real-claude-code-agent-loop-adapter` (off main at `ffaa54d`; spec already committed).

**Discipline:** Every task carries a "Security + correctness considerations" subsection. The implementer subagent walks through this BEFORE writing code, not after CR flags it (per memory `feedback_security_correctness_at_write_time`).

---

## File structure

**Create:**
- `examples/agent-loops/claude-code/stream-json-parser.ts` -- pure NDJSON event parser
- `examples/agent-loops/claude-code/prompt-builder.ts` -- pure prompt assembler
- `examples/agent-loops/claude-code/classifier.ts` -- adapter-specific failure classifier
- `examples/agent-loops/claude-code/artifacts.ts` -- post-CLI git command runner
- `examples/agent-loops/claude-code/spawn.ts` -- execa wrapper for `claude -p`
- `test/examples/claude-code/stream-json-parser.test.ts`
- `test/examples/claude-code/prompt-builder.test.ts`
- `test/examples/claude-code/classifier.test.ts`
- `test/examples/claude-code/artifacts.test.ts`
- `test/examples/claude-code/spawn.test.ts`
- `test/examples/claude-code/loop.test.ts` -- adapter-with-stub tests

**Modify:**
- `examples/agent-loops/claude-code/loop.ts` -- replace skeleton with real adapter (delete `ClaudeCodeAgentLoopSkeleton`; export `ClaudeCodeAgentLoopAdapter`)
- `examples/agent-loops/claude-code/index.ts` -- update barrel
- `examples/agent-loops/claude-code/README.md` -- swap "skeleton" wording for production-adapter description
- `test/e2e/agentic-actor-loop-chain.test.ts` -- add a canonical-shape assertion test

**Pre-existing context:**
- Substrate contract: `src/substrate/agent-loop.ts` (the AgentLoopAdapter interface)
- Atom shapes: `src/substrate/types.ts` lines 540-597 (AgentSessionMeta, AgentTurnMeta)
- Workspace shape: `src/substrate/workspace-provider.ts` (Workspace.baseRef field)
- Reference argv pattern: `src/daemon/cli-renderer/claude-streaming.ts` lines 120-135
- Reference stream parser: `src/daemon/cli-renderer/claude-stream-parser.ts` (NOT the same purpose; uses different event shape -- consult for `cost_usd` field name only)

---

## Task 1: `StreamJsonParser` (pure NDJSON event parser)

**Files:**
- Create: `examples/agent-loops/claude-code/stream-json-parser.ts`
- Create: `test/examples/claude-code/stream-json-parser.test.ts`

**Security + correctness considerations:**
- Defensive parsing: malformed lines MUST NOT throw; they produce a `ParseError` event the caller can log + skip. The adapter relies on this to keep the loop alive through partial corruption.
- No prototype-pollution surface: parsed JSON values are read by property name only; no `Object.assign` over user-controlled keys.
- Memory bound: a single line longer than 10MB is treated as a `ParseError` (`reason: 'oversize-line'`). A pathological CLI run cannot exhaust memory by emitting one giant line.
- Type-safety: every emitted event is a typed discriminated union. Downstream consumers cannot accidentally read undefined fields.

- [ ] **Step 1: Write the failing tests**

Create `test/examples/claude-code/stream-json-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine, type StreamJsonEvent } from '../../../examples/agent-loops/claude-code/stream-json-parser.js';

describe('parseStreamJsonLine', () => {
  it('parses a system event', () => {
    const ev = parseStreamJsonLine('{"type":"system","subtype":"init","model":"claude-opus-4-7","session_id":"abc"}');
    expect(ev.kind).toBe('system');
    if (ev.kind !== 'system') throw new Error('unreachable');
    expect(ev.modelId).toBe('claude-opus-4-7');
    expect(ev.sessionId).toBe('abc');
  });

  it('parses an assistant text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    const ev = parseStreamJsonLine(line);
    expect(ev.kind).toBe('assistant-text');
    if (ev.kind !== 'assistant-text') throw new Error('unreachable');
    expect(ev.text).toBe('hello world');
  });

  it('parses an assistant tool_use event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
    });
    const ev = parseStreamJsonLine(line);
    expect(ev.kind).toBe('tool-use');
    if (ev.kind !== 'tool-use') throw new Error('unreachable');
    expect(ev.toolUseId).toBe('tu_1');
    expect(ev.toolName).toBe('Bash');
    expect(ev.input).toEqual({ command: 'ls' });
  });

  it('parses a user tool_result event', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2', is_error: false }] },
    });
    const ev = parseStreamJsonLine(line);
    expect(ev.kind).toBe('tool-result');
    if (ev.kind !== 'tool-result') throw new Error('unreachable');
    expect(ev.toolUseId).toBe('tu_1');
    expect(ev.content).toBe('file1\nfile2');
    expect(ev.isError).toBe(false);
  });

  it('parses a result envelope', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      cost_usd: 0.0042,
      usage: { input_tokens: 100, output_tokens: 200 },
      is_error: false,
    });
    const ev = parseStreamJsonLine(line);
    expect(ev.kind).toBe('result');
    if (ev.kind !== 'result') throw new Error('unreachable');
    expect(ev.costUsd).toBe(0.0042);
    expect(ev.isError).toBe(false);
  });

  it('returns parse-error for malformed JSON', () => {
    const ev = parseStreamJsonLine('not json {');
    expect(ev.kind).toBe('parse-error');
    if (ev.kind !== 'parse-error') throw new Error('unreachable');
    expect(ev.linePreview).toBe('not json {');
  });

  it('returns parse-error for oversize line', () => {
    const big = JSON.stringify({ type: 'system', payload: 'a'.repeat(11_000_000) });
    const ev = parseStreamJsonLine(big);
    expect(ev.kind).toBe('parse-error');
    if (ev.kind !== 'parse-error') throw new Error('unreachable');
    expect(ev.reason).toBe('oversize-line');
  });

  it('returns parse-error for unknown type', () => {
    const ev = parseStreamJsonLine('{"type":"telemetry","unrelated":1}');
    expect(ev.kind).toBe('parse-error');
    if (ev.kind !== 'parse-error') throw new Error('unreachable');
    expect(ev.reason).toBe('unknown-type');
  });

  it('returns parse-error for empty line', () => {
    const ev = parseStreamJsonLine('');
    expect(ev.kind).toBe('parse-error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/stream-json-parser.test.ts`
Expected: FAIL ("Cannot find module" / "parseStreamJsonLine is not defined").

- [ ] **Step 3: Implement the parser**

Create `examples/agent-loops/claude-code/stream-json-parser.ts`:

```ts
/**
 * Pure NDJSON event parser for Claude Code CLI's `--output-format stream-json`.
 *
 * Each call to `parseStreamJsonLine(line)` returns exactly one event.
 * Malformed lines yield `{kind: 'parse-error'}` -- they MUST NOT throw,
 * because the adapter relies on parser-side defensiveness to keep the
 * loop alive through partial corruption.
 *
 * Oversize lines (> 10MB) are rejected up-front to bound memory.
 */

const OVERSIZE_LINE_BYTES = 10 * 1024 * 1024;

export type StreamJsonEvent =
  | { readonly kind: 'system'; readonly modelId: string | undefined; readonly sessionId: string | undefined }
  | { readonly kind: 'assistant-text'; readonly text: string }
  | { readonly kind: 'tool-use'; readonly toolUseId: string; readonly toolName: string; readonly input: unknown }
  | { readonly kind: 'tool-result'; readonly toolUseId: string; readonly content: string; readonly isError: boolean }
  | { readonly kind: 'result'; readonly costUsd: number | undefined; readonly isError: boolean }
  | { readonly kind: 'parse-error'; readonly reason: 'malformed-json' | 'unknown-type' | 'oversize-line' | 'empty'; readonly linePreview: string };

export function parseStreamJsonLine(line: string): StreamJsonEvent {
  if (line.length === 0) {
    return { kind: 'parse-error', reason: 'empty', linePreview: '' };
  }
  if (line.length > OVERSIZE_LINE_BYTES) {
    return { kind: 'parse-error', reason: 'oversize-line', linePreview: line.slice(0, 200) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'parse-error', reason: 'malformed-json', linePreview: line.slice(0, 200) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'parse-error', reason: 'malformed-json', linePreview: line.slice(0, 200) };
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj['type'];
  if (type === 'system') {
    return {
      kind: 'system',
      modelId: typeof obj['model'] === 'string' ? (obj['model'] as string) : undefined,
      sessionId: typeof obj['session_id'] === 'string' ? (obj['session_id'] as string) : undefined,
    };
  }
  if (type === 'assistant') {
    const msg = obj['message'];
    if (msg !== null && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            return { kind: 'assistant-text', text: b['text'] as string };
          }
          if (b['type'] === 'tool_use'
              && typeof b['id'] === 'string'
              && typeof b['name'] === 'string') {
            return {
              kind: 'tool-use',
              toolUseId: b['id'] as string,
              toolName: b['name'] as string,
              input: b['input'] ?? {},
            };
          }
        }
      }
    }
    return { kind: 'parse-error', reason: 'unknown-type', linePreview: line.slice(0, 200) };
  }
  if (type === 'user') {
    const msg = obj['message'];
    if (msg !== null && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
            const c = b['content'];
            const text = typeof c === 'string'
              ? c
              : (Array.isArray(c) ? c.map((x) => typeof x === 'object' && x !== null && 'text' in x ? String((x as { text: unknown }).text) : '').join('') : '');
            return {
              kind: 'tool-result',
              toolUseId: b['tool_use_id'] as string,
              content: text,
              isError: b['is_error'] === true,
            };
          }
        }
      }
    }
    return { kind: 'parse-error', reason: 'unknown-type', linePreview: line.slice(0, 200) };
  }
  if (type === 'result') {
    return {
      kind: 'result',
      costUsd: typeof obj['cost_usd'] === 'number' ? (obj['cost_usd'] as number) : undefined,
      isError: obj['is_error'] === true,
    };
  }
  return { kind: 'parse-error', reason: 'unknown-type', linePreview: line.slice(0, 200) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/stream-json-parser.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/stream-json-parser.ts test/examples/claude-code/stream-json-parser.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): StreamJsonParser pure NDJSON event parser"
```

---

## Task 2: `buildPromptText` (pure prompt assembler)

**Files:**
- Create: `examples/agent-loops/claude-code/prompt-builder.ts`
- Create: `test/examples/claude-code/prompt-builder.test.ts`

**Security + correctness considerations:**
- The prompt is operator/agent-controlled text. Escaping concerns are MINIMAL because the prompt goes verbatim through execa's argv (no shell). The risk is prompt injection from `task.fileContents`, which is itself derived from operator-controlled paths inside the workspace. Defense is layered (workspace boundary, redactor, tool policy); no escaping is added here.
- Output is deterministic (same input -> same output) so it can be content-hashed for replay.
- File paths in injected blocks are NOT shell-escaped; they are inside `<file_contents path="...">` markers. A path containing `"` or `>` would break the wrapper. Tests cover this; the implementation HTML-escapes the path attribute.

- [ ] **Step 1: Write the failing tests**

Create `test/examples/claude-code/prompt-builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { AtomId } from '../../../src/substrate/types.js';
import { buildPromptText } from '../../../examples/agent-loops/claude-code/prompt-builder.js';

const PLAN_ID = 'plan-abc' as AtomId;

describe('buildPromptText', () => {
  it('returns just questionPrompt when no other fields present', () => {
    const out = buildPromptText({ planAtomId: PLAN_ID, questionPrompt: 'do X' });
    expect(out).toBe('do X');
  });

  it('appends file_contents block per entry', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'edit',
      fileContents: [{ path: 'src/a.ts', content: 'aaa' }, { path: 'src/b.ts', content: 'bbb' }],
    });
    expect(out).toContain('<file_contents path="src/a.ts">');
    expect(out).toContain('aaa');
    expect(out).toContain('</file_contents>');
    expect(out).toContain('<file_contents path="src/b.ts">');
    expect(out).toContain('bbb');
  });

  it('appends success_criteria block', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'do X',
      successCriteria: 'all tests pass',
    });
    expect(out).toContain('<success_criteria>all tests pass</success_criteria>');
  });

  it('appends target_paths block', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'do X',
      targetPaths: ['a.ts', 'b.ts'],
    });
    expect(out).toContain('<target_paths>a.ts, b.ts</target_paths>');
  });

  it('escapes a path containing special chars', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'do X',
      fileContents: [{ path: 'src/with"quote.ts', content: '...' }],
    });
    expect(out).toContain('<file_contents path="src/with&quot;quote.ts">');
  });

  it('returns empty string when no questionPrompt and no other fields', () => {
    const out = buildPromptText({ planAtomId: PLAN_ID });
    expect(out).toBe('');
  });

  it('omits empty fileContents array', () => {
    const out = buildPromptText({ planAtomId: PLAN_ID, questionPrompt: 'do X', fileContents: [] });
    expect(out).toBe('do X');
  });

  it('produces deterministic output for the same input', () => {
    const input = {
      planAtomId: PLAN_ID,
      questionPrompt: 'q',
      fileContents: [{ path: 'a.ts', content: 'A' }],
      successCriteria: 'sc',
      targetPaths: ['a.ts'],
    } as const;
    expect(buildPromptText(input)).toBe(buildPromptText(input));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/prompt-builder.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implement the builder**

Create `examples/agent-loops/claude-code/prompt-builder.ts`:

```ts
/**
 * Pure prompt assembler. Composes the user-facing prompt from the
 * substrate's `AgentTask` shape. Output is deterministic (same input
 * -> same string) so it can be content-hashed for replay.
 */

import type { AgentTask } from '../../../src/substrate/agent-loop.js';

export function buildPromptText(task: AgentTask): string {
  const parts: string[] = [];
  if (typeof task.questionPrompt === 'string' && task.questionPrompt.length > 0) {
    parts.push(task.questionPrompt);
  }
  if (task.fileContents !== undefined && task.fileContents.length > 0) {
    for (const fc of task.fileContents) {
      parts.push(`<file_contents path="${escapeAttribute(fc.path)}">\n${fc.content}\n</file_contents>`);
    }
  }
  if (typeof task.successCriteria === 'string' && task.successCriteria.length > 0) {
    parts.push(`<success_criteria>${task.successCriteria}</success_criteria>`);
  }
  if (task.targetPaths !== undefined && task.targetPaths.length > 0) {
    parts.push(`<target_paths>${task.targetPaths.join(', ')}</target_paths>`);
  }
  return parts.join('\n\n');
}

function escapeAttribute(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/prompt-builder.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/prompt-builder.ts test/examples/claude-code/prompt-builder.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): buildPromptText pure prompt assembler"
```

---

## Task 3: `classifyClaudeCliFailure` (adapter-specific failure classifier)

**Files:**
- Create: `examples/agent-loops/claude-code/classifier.ts`
- Create: `test/examples/claude-code/classifier.test.ts`

**Security + correctness considerations:**
- Classification precedence MUST be top-down. A 401 page that also mentions "rate limit" is `catastrophic` (auth), not `transient`. Otherwise an auth misconfig becomes a retry-storm.
- AbortError MUST land as `catastrophic` (operator cancel; no retry).
- The classifier reads `stderr` as a substring match; substring inputs are CLI-emitted, not user-controlled. No injection surface.
- `defaultClassifyFailure` (from `src/substrate/agent-loop.ts`) is the fallback. Any pre-spawn error (ENOENT thrown by execa, internal adapter exceptions) goes to the default.

- [ ] **Step 1: Write the failing tests**

Create `test/examples/claude-code/classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyClaudeCliFailure } from '../../../examples/agent-loops/claude-code/classifier.js';

describe('classifyClaudeCliFailure', () => {
  it('AbortError is catastrophic regardless of exit/stderr', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyClaudeCliFailure(err, null, '')).toBe('catastrophic');
  });

  it('ENOENT (claude not installed) is catastrophic', () => {
    expect(classifyClaudeCliFailure(null, 127, 'claude: command not found')).toBe('catastrophic');
  });

  it('auth error is catastrophic (precedence over rate-limit)', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Error 401: please re-authenticate (rate limit may apply)')).toBe('catastrophic');
  });

  it('budget marker is structural at classifier level (adapter remaps to budget-exhausted)', () => {
    expect(classifyClaudeCliFailure(null, 1, 'budget exhausted')).toBe('structural');
  });

  it('rate limit is transient', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Error 429: rate limit hit')).toBe('transient');
  });

  it('generic non-zero exit is structural', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Some unrelated error')).toBe('structural');
  });

  it('falls through to default for unknown error shape', () => {
    expect(classifyClaudeCliFailure({ statusCode: 502 }, null, '')).toBe('transient');
  });

  it('falls through to default for plain Error', () => {
    expect(classifyClaudeCliFailure(new Error('weird'), null, '')).toBe('structural');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/classifier.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the classifier**

Create `examples/agent-loops/claude-code/classifier.ts`:

```ts
/**
 * Adapter-specific failure classifier. Beats `defaultClassifyFailure`
 * by inspecting Claude CLI stderr shapes. Precedence is top-down:
 * the FIRST matching branch wins.
 */

import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type { FailureKind } from '../../../src/substrate/types.js';

export function classifyClaudeCliFailure(
  err: unknown,
  exitCode: number | null,
  stderr: string,
): FailureKind {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'catastrophic';
  }
  if (/ENOENT|claude:\s*command not found/i.test(stderr)) {
    return 'catastrophic';
  }
  if (/\bauth\b|\b401\b|\b403\b/i.test(stderr)) {
    return 'catastrophic';
  }
  if (/\brate limit\b|\b429\b/i.test(stderr)) {
    return 'transient';
  }
  if (exitCode !== null && exitCode !== 0) {
    return 'structural';
  }
  return defaultClassifyFailure(err);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/classifier.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/classifier.ts test/examples/claude-code/classifier.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): classifyClaudeCliFailure adapter-specific failure classifier"
```

---

## Task 4: `captureArtifacts` (post-CLI git command runner)

**Files:**
- Create: `examples/agent-loops/claude-code/artifacts.ts`
- Create: `test/examples/claude-code/artifacts.test.ts`

**Security + correctness considerations:**
- Reads `workspace.baseRef` from the substrate `Workspace` shape. Trusted (provider-set) input.
- Spawns git as a subprocess. We use execa with argv arrays (no shell), so no command injection from `workspace.path`.
- HEAD == baseRef => returns `undefined` (no commit was made). Executor maps to `agentic/no-artifacts`. Caller MUST distinguish "no commit" from "commit happened" before publishing a PR.
- `git diff --name-only` could in principle return a path with `..` if the agent did something pathological. We do NOT try to validate paths here; the workspace boundary + executor's downstream path checks are responsible.
- ENOENT on `workspace.path` (workspace was released early): execa throws; the caller wraps + classifies. The function itself does not swallow.

- [ ] **Step 1: Write the failing tests**

Create `test/examples/claude-code/artifacts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';
import { captureArtifacts } from '../../../examples/agent-loops/claude-code/artifacts.js';

async function setupRepo(): Promise<{ ws: Workspace; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'lag-pr3-artifacts-'));
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'initial\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir });
  return {
    ws: { id: 'ws-test', path: dir, baseRef: 'main' },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

describe('captureArtifacts', () => {
  it('returns undefined when HEAD === baseRef (no commit)', async () => {
    const { ws, cleanup } = await setupRepo();
    try {
      const out = await captureArtifacts(ws);
      expect(out).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('returns commitSha + branchName + touchedPaths after a commit on a new branch', async () => {
    const { ws, cleanup } = await setupRepo();
    try {
      await execa('git', ['checkout', '-b', 'feat/x'], { cwd: ws.path });
      await writeFile(join(ws.path, 'README.md'), 'updated\n');
      await writeFile(join(ws.path, 'NEW.md'), 'new\n');
      await execa('git', ['add', '.'], { cwd: ws.path });
      await execa('git', ['commit', '-m', 'change'], { cwd: ws.path });
      const out = await captureArtifacts(ws);
      expect(out).toBeDefined();
      if (!out) throw new Error('unreachable');
      expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(out.branchName).toBe('feat/x');
      expect(out.touchedPaths.sort()).toEqual(['NEW.md', 'README.md']);
    } finally {
      await cleanup();
    }
  });

  it('throws if workspace.path does not exist', async () => {
    const ws: Workspace = { id: 'gone', path: join(tmpdir(), 'lag-pr3-nonexistent-' + Date.now()), baseRef: 'main' };
    await expect(captureArtifacts(ws)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/artifacts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the artifact capture**

Create `examples/agent-loops/claude-code/artifacts.ts`:

```ts
/**
 * Post-CLI artifact capture. Runs three git commands inside the
 * workspace to determine whether a commit was made and what files
 * were touched. `workspace.baseRef` is read directly from the
 * substrate `Workspace` shape (provider-set, trusted).
 *
 * Returns `undefined` when HEAD === baseRef (no commit). Executor
 * maps that to `agentic/no-artifacts`.
 */

import { execa, type execa as ExecaType } from 'execa';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';

export interface AgentLoopArtifacts {
  readonly commitSha: string;
  readonly branchName: string;
  readonly touchedPaths: ReadonlyArray<string>;
}

export async function captureArtifacts(
  workspace: Workspace,
  execImpl: typeof ExecaType = execa,
): Promise<AgentLoopArtifacts | undefined> {
  const { stdout: currentSha } = await execImpl('git', ['rev-parse', 'HEAD'], { cwd: workspace.path });
  const { stdout: baseSha } = await execImpl('git', ['rev-parse', workspace.baseRef], { cwd: workspace.path });
  if (currentSha.trim() === baseSha.trim()) {
    return undefined;
  }
  const { stdout: branchName } = await execImpl('git', ['branch', '--show-current'], { cwd: workspace.path });
  const { stdout: namesOnly } = await execImpl(
    'git',
    ['diff', '--name-only', `${workspace.baseRef}..HEAD`],
    { cwd: workspace.path },
  );
  const touchedPaths = namesOnly.split(/\r?\n/).filter((s) => s.length > 0);
  return {
    commitSha: currentSha.trim(),
    branchName: branchName.trim(),
    touchedPaths,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/artifacts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/artifacts.ts test/examples/claude-code/artifacts.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): captureArtifacts post-CLI git command runner"
```

---

## Task 5: `spawnClaudeCli` (execa wrapper for `claude -p`)

**Files:**
- Create: `examples/agent-loops/claude-code/spawn.ts`
- Create: `test/examples/claude-code/spawn.test.ts`

**Security + correctness considerations:**
- Argv-injection resistant: every arg is a separate array element. No shell. `--disallowedTools` joined with `' '` per CLI documentation; tool names are operator-controlled (substrate `toolPolicy.disallowedTools`), not adversary-controlled.
- `cwd: workspace.path` is set via execa option (NOT a `--cwd` flag; the CLI does not accept that). The CLI's relative-path operations resolve inside the worktree.
- Uses `--mcp-config '{"mcpServers":{}}'` to disable all MCP servers (mirrors `src/daemon/cli-renderer/claude-streaming.ts`). Without this the CLI would auto-start every configured server, which we do NOT want for code-author.
- `--verbose` is REQUIRED for stream-json to emit per-turn lines. Omitting it produces a single batched output which the parser cannot handle.
- `budget.max_usd === 0` is a valid no-spend cap. `!== undefined` check handles it correctly (truthy check would skip the flag).
- `signal: input.signal` forwards AbortSignal to the subprocess at execa level. Adapter-side wall-clock + max-turns enforcement happens at a layer above.

- [ ] **Step 1: Write the failing tests**

Create `test/examples/claude-code/spawn.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/spawn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the spawn wrapper**

Create `examples/agent-loops/claude-code/spawn.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/spawn.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/spawn.ts test/examples/claude-code/spawn.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): spawnClaudeCli execa wrapper for agentic stream-json mode"
```

---

## Task 6: `ClaudeCodeAgentLoopAdapter` happy-path lifecycle

**Files:**
- Create: `test/examples/claude-code/loop.test.ts`
- Modify (replace): `examples/agent-loops/claude-code/loop.ts`

**Security + correctness considerations:**
- Session atom is written on entry BEFORE any LLM call. Mid-spawn crash leaves the audit trail showing the session was opened but never produced output. Required by substrate contract.
- Session atom is updated on exit with `terminal_state`, `budget_consumed.{turns,wall_clock_ms,usd}`, `completed_at`. The update is in a `finally` block so it runs even on throw.
- Redaction on EVERY user-or-LLM-derived payload before atom write (turn output, tool args, tool result). A redactor crash MUST surface as `kind: 'error'` with `failure: catastrophic`; never write unredacted content.
- The placeholder turn 0 is written on the `system` event from the parser (the boundary that signals an LLM call is about to start). `host.atoms.update()` enriches it as `assistant-text` arrives.
- Subprocess errors that occur BEFORE the parser sees a `system` event still produce a session atom + a finally-block update; turn count stays 0.
- `host.atoms.put(sessionAtom)` and `host.atoms.update()` are awaited; the adapter cannot leak a partially-written atom by race.

- [ ] **Step 1: Write the failing tests**

Create `test/examples/claude-code/loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { ClaudeCodeAgentLoopAdapter } from '../../../examples/agent-loops/claude-code/loop.js';
import type { AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider } from '../../../src/substrate/workspace-provider.js';
import type { BlobStore, BlobRef } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { AtomId, Atom, PrincipalId } from '../../../src/substrate/types.js';
import { randomBytes } from 'node:crypto';

const NOOP_REDACTOR: Redactor = { redact: (s) => s };
const PRINCIPAL = 'agentic-code-author' as PrincipalId;
const WS: Workspace = { id: 'ws-1', path: '/tmp/stub-ws', baseRef: 'main' };

function inMemBlob(): BlobStore {
  const m = new Map<string, Buffer>();
  return {
    put: async (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
      m.set(ref, buf);
      return ref;
    },
    get: async (r) => m.get(r as string)!,
    has: async (r) => m.has(r as string),
  };
}

function makeStubExeca(stdoutLines: string[], opts: { exitCode?: number; stderr?: string } = {}) {
  // Real `execa()` returns a `ResultPromise` -- a Promise that ALSO
  // exposes `.stdout` / `.stderr` (Readables) AND a `.kill()` method
  // synchronously, before the promise resolves. Plain
  // `async (..._args) => obj` fails this contract because the result
  // is just a Promise<obj>, with no `.stdout` accessor on the promise
  // itself. The adapter does `proc.stdout!` BEFORE `await proc`, so
  // the stub MUST expose `.stdout` on the synchronously-returned
  // promise. Object.assign onto a Promise is the canonical pattern.
  return ((..._args: unknown[]) => {
    const stdoutStream = Readable.from(stdoutLines.map((l) => `${l}\n`));
    const stderrText = opts.stderr ?? '';
    const stderrStream = Readable.from([stderrText]);
    const resultPromise = Promise.resolve({
      stdout: stdoutLines.join('\n'),
      stderr: stderrText,
      exitCode: opts.exitCode ?? 0,
    });
    return Object.assign(resultPromise, {
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: (_signal?: NodeJS.Signals) => true,
    }) as never;
  }) as never;
}

function mkInput(host: ReturnType<typeof createMemoryHost>, execImpl: unknown, signal?: AbortSignal): AgentLoopInput {
  return {
    host,
    principal: PRINCIPAL,
    workspace: WS,
    task: { planAtomId: 'plan-1' as AtomId, questionPrompt: 'do X' },
    budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
    toolPolicy: { disallowedTools: [] },
    redactor: NOOP_REDACTOR,
    blobStore: inMemBlob(),
    replayTier: 'content-addressed',
    blobThreshold: 4096,
    correlationId: 'corr-1',
    ...(signal !== undefined ? { signal } : {}),
  };
}

describe('ClaudeCodeAgentLoopAdapter -- happy path lifecycle', () => {
  it('writes session atom on entry, updates terminal_state + completed_at on exit', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const result = await adapter.run(mkInput(host, makeStubExeca(stdoutLines)));
    expect(result.kind).toBe('completed');
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    const meta = session.metadata as Record<string, unknown>;
    const agentSession = meta['agent_session'] as Record<string, unknown>;
    expect(agentSession['terminal_state']).toBe('completed');
    expect(agentSession['completed_at']).toBeDefined();
    const budget = agentSession['budget_consumed'] as Record<string, unknown>;
    expect(budget['usd']).toBe(0.01);
    expect(budget['turns']).toBe(1);
  });

  it('emits exactly one agent-turn atom for a single-turn run', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host, makeStubExeca(stdoutLines)));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turns).toHaveLength(1);
    const turnMeta = (turns[0]!.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    expect(turnMeta['turn_index']).toBe(0);
    const llmOutput = turnMeta['llm_output'] as Record<string, unknown>;
    expect(llmOutput).toHaveProperty('inline');
    expect(llmOutput['inline']).toBe('done');
  });

  it('redactor is applied to llm_input + llm_output before atom write', async () => {
    const host = createMemoryHost();
    let redactCalls = 0;
    const counting: Redactor = { redact: (s) => { redactCalls += 1; return s.replace('secret', '<redacted>'); } };
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'output with secret' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host, makeStubExeca(stdoutLines)), redactor: counting };
    await adapter.run(input);
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turnMeta = (turns[0]!.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const llmOutput = turnMeta['llm_output'] as Record<string, unknown>;
    expect(llmOutput['inline']).toContain('<redacted>');
    expect(llmOutput['inline']).not.toContain('secret');
    expect(redactCalls).toBeGreaterThan(0);
  });

  it('returns error result with failure: catastrophic when redactor throws', async () => {
    const host = createMemoryHost();
    const explodingRedactor: Redactor = {
      redact: () => { throw new Error('redactor went boom'); },
    };
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'anything' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host, makeStubExeca(stdoutLines)), redactor: explodingRedactor };
    const result = await adapter.run(input);
    expect(result.kind).toBe('error');
    expect(result.failure?.kind).toBe('catastrophic');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the adapter shell + run() lifecycle**

Replace `examples/agent-loops/claude-code/loop.ts` (the WHOLE file; the skeleton goes away):

```ts
/**
 * Production AgentLoopAdapter that spawns the Claude Code CLI in
 * agentic-headless mode (`claude -p --output-format stream-json
 * --verbose ...`), parses the streamed NDJSON, writes session +
 * placeholder turn atoms BEFORE each LLM call (per substrate
 * contract `src/substrate/agent-loop.ts:46-47`), and updates them
 * as content streams in.
 *
 * Composes the helpers in this directory:
 *   - parseStreamJsonLine (`./stream-json-parser.ts`)
 *   - buildPromptText     (`./prompt-builder.ts`)
 *   - classifyClaudeCliFailure (`./classifier.ts`)
 *   - captureArtifacts    (`./artifacts.ts`)
 *   - spawnClaudeCli      (`./spawn.ts`)
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { execa as ExecaType, ExecaError } from 'execa';
import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type {
  AdapterCapabilities,
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../src/substrate/agent-loop.js';
import type {
  AgentSessionMeta,
  AgentTurnMeta,
  Atom,
  AtomId,
  PrincipalId,
} from '../../../src/substrate/types.js';
import { parseStreamJsonLine } from './stream-json-parser.js';
import { buildPromptText } from './prompt-builder.js';
import { classifyClaudeCliFailure } from './classifier.js';
import { captureArtifacts } from './artifacts.js';
import { spawnClaudeCli } from './spawn.js';

export interface ClaudeCodeAgentLoopOptions {
  readonly claudePath?: string;
  readonly extraArgs?: ReadonlyArray<string>;
  readonly verbose?: boolean;
  readonly execImpl?: typeof ExecaType;
  readonly killGracePeriodMs?: number;
}

export class ClaudeCodeAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities = {
    tracks_cost: true,
    supports_signal: true,
    classify_failure: classifyClaudeCliFailure,
  };

  constructor(private readonly opts: ClaudeCodeAgentLoopOptions = {}) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
    const sessionAtom: Atom = mkAtom(sessionId, 'agent-session', input.principal, [], {
      agent_session: {
        model_id: 'claude-opus-4-7',
        adapter_id: 'claude-code-agent-loop',
        workspace_id: input.workspace.id,
        started_at: startedAt,
        terminal_state: 'completed',
        replay_tier: input.replayTier,
        budget_consumed: { turns: 0, wall_clock_ms: 0 },
      } satisfies AgentSessionMeta,
    });
    await input.host.atoms.put(sessionAtom);

    const turnAtomIds: AtomId[] = [];
    let costUsd: number | undefined;
    let kind: AgentLoopResult['kind'] = 'completed';
    let failure: AgentLoopResult['failure'] | undefined;

    try {
      const prompt = buildPromptText(input.task);
      const proc = spawnClaudeCli({
        prompt,
        workspaceDir: input.workspace.path,
        budget: input.budget,
        disallowedTools: input.toolPolicy.disallowedTools,
        ...(this.opts.claudePath !== undefined ? { claudePath: this.opts.claudePath } : {}),
        ...(this.opts.extraArgs !== undefined ? { extraArgs: this.opts.extraArgs } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(this.opts.execImpl !== undefined ? { execImpl: this.opts.execImpl } : {}),
      });

      // proc has stdout (Readable). Consume line-by-line via readline.
      // execa promise also resolves with exitCode + stderr; we await
      // it after the stream ends.
      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

      let currentTurnAtomId: AtomId | null = null;
      let currentTurnIndex = 0;
      let pendingFirstTurnOpened = false;
      const toolUseToTurn = new Map<string, AtomId>(); // tool_use_id -> turn atom id

      const openPlaceholderTurn = async (turnIndex: number, llmInputText: string): Promise<AtomId> => {
        const turnId = `agent-turn-${randomBytes(6).toString('hex')}` as AtomId;
        let redactedInput: string;
        try {
          redactedInput = input.redactor.redact(llmInputText, { kind: 'llm-input', principal: input.principal });
        } catch (e) {
          throw Object.assign(new Error('redactor crashed on llm-input'), { name: 'RedactorError', cause: e });
        }
        const turnMeta: AgentTurnMeta = {
          session_atom_id: sessionId,
          turn_index: turnIndex,
          llm_input: { inline: redactedInput },
          llm_output: { inline: '' },
          tool_calls: [],
          latency_ms: 0,
        };
        const turnAtom: Atom = mkAtom(turnId, 'agent-turn', input.principal, [sessionId], { agent_turn: turnMeta });
        await input.host.atoms.put(turnAtom);
        turnAtomIds.push(turnId);
        return turnId;
      };

      for await (const rawLine of rl) {
        const line = rawLine;
        const ev = parseStreamJsonLine(line);
        if (ev.kind === 'system') {
          if (!pendingFirstTurnOpened) {
            currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, prompt);
            pendingFirstTurnOpened = true;
          }
        } else if (ev.kind === 'assistant-text') {
          if (currentTurnAtomId === null) {
            currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, prompt);
          }
          let redactedOut: string;
          try {
            redactedOut = input.redactor.redact(ev.text, { kind: 'llm-output', principal: input.principal });
          } catch (e) {
            throw Object.assign(new Error('redactor crashed on llm-output'), { name: 'RedactorError', cause: e });
          }
          // Read the existing turn atom + preserve llm_input + tool_calls;
          // update only llm_output + latency_ms. The placeholder set
          // llm_input at open-time using a redacted prompt; re-redacting
          // here would double-call the redactor and waste work.
          const existing = await input.host.atoms.get(currentTurnAtomId);
          const existingMeta = existing !== null
            ? ((existing.metadata as Record<string, unknown>)['agent_turn'] as AgentTurnMeta)
            : undefined;
          await input.host.atoms.update(currentTurnAtomId, {
            metadata: {
              agent_turn: {
                session_atom_id: sessionId,
                turn_index: currentTurnIndex,
                llm_input: existingMeta?.llm_input ?? { inline: '' },
                llm_output: { inline: redactedOut },
                tool_calls: existingMeta?.tool_calls ?? [],
                latency_ms: Date.now() - startedAtMs,
              } satisfies AgentTurnMeta,
            },
          });
        } else if (ev.kind === 'result') {
          if (typeof ev.costUsd === 'number') costUsd = ev.costUsd;
        }
        // tool-use / tool-result handled in later tasks
        // parse-error: log + skip
      }

      // proc resolves with exitCode + stderr now.
      const procResult = await proc;
      if (procResult.exitCode !== 0) {
        const failureKind = classifyClaudeCliFailure(null, procResult.exitCode, String(procResult.stderr ?? ''));
        kind = 'error';
        failure = {
          kind: failureKind,
          reason: String(procResult.stderr ?? '').slice(0, 1000),
          stage: 'claude-cli',
        };
      }
    } catch (err) {
      kind = 'error';
      const isRedactorErr = err instanceof Error && err.name === 'RedactorError';
      failure = {
        kind: isRedactorErr ? 'catastrophic' : classifyClaudeCliFailure(err, null, ''),
        reason: err instanceof Error ? err.message : String(err),
        stage: isRedactorErr ? 'redactor' : 'claude-cli',
      };
    } finally {
      // Update session atom on exit. Always. Never let a writer error
      // swallow the upstream result.
      const completedAt = new Date().toISOString();
      try {
        await input.host.atoms.update(sessionId, {
          metadata: {
            agent_session: {
              model_id: 'claude-opus-4-7',
              adapter_id: 'claude-code-agent-loop',
              workspace_id: input.workspace.id,
              started_at: startedAt,
              completed_at: completedAt,
              terminal_state: kind === 'completed' ? 'completed' : kind,
              replay_tier: input.replayTier,
              budget_consumed: {
                turns: turnAtomIds.length,
                wall_clock_ms: Date.now() - startedAtMs,
                ...(costUsd !== undefined ? { usd: costUsd } : {}),
              },
              ...(failure !== undefined ? { failure } : {}),
            } satisfies AgentSessionMeta,
          },
        });
      } catch {
        // Atom-store update failure on session close is logged to stderr
        // by the host; we do not let it overwrite the upstream `kind`.
      }
    }

    return {
      kind,
      sessionAtomId: sessionId,
      turnAtomIds,
      ...(failure !== undefined ? { failure } : {}),
    };
  }
}

function mkAtom(
  id: AtomId,
  type: 'agent-session' | 'agent-turn',
  principal: PrincipalId,
  derived: ReadonlyArray<AtomId>,
  metadata: Record<string, unknown>,
): Atom {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id,
    content: '',
    type,
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: principal as unknown as string }, derived_from: derived as AtomId[] },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: principal,
    taint: 'clean',
    metadata,
  };
}
```

Note: this task implements the happy-path lifecycle ONLY. Multi-turn placeholder, tool_calls, blob threshold, budget guards, and signal forwarding land in subsequent tasks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/loop.ts test/examples/claude-code/loop.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): ClaudeCodeAgentLoopAdapter happy-path lifecycle"
```

---

## Task 7: Multi-turn placeholder + tool_calls correlation

**Files:**
- Modify: `examples/agent-loops/claude-code/loop.ts`
- Modify: `test/examples/claude-code/loop.test.ts`

**Security + correctness considerations:**
- Each `tool_use` event REDACTS args before atom write. Tool args may contain operator-controlled strings (e.g., a Bash command that includes a token); the redactor catches secret-shaped patterns.
- `tool_result` content is similarly redacted. A tool that exfiltrates a secret-shaped value through its result still gets redacted before the atom lands.
- `tool_use_id` correlation map is in-memory only; never persisted. If the CLI emits a `tool_result` for an unknown id (corruption / version skew), we log + skip rather than throw.
- Optimistic `outcome: 'success'` becomes `'tool-error'` or `'policy-refused'` when the result lands. If the subprocess crashes between `tool_use` and `tool_result`, the atom keeps `'success'` -- the audit trail shows "we issued the call but never saw the result", which is the truth.
- `is_error: true` AND content matching the policy-denial phrase ("Permission denied" / "tool not allowed", case-insensitive) -> `'policy-refused'`. Otherwise `is_error: true` -> `'tool-error'`.
- Each `tool_result` event also OPENS the next placeholder turn (the CLI is feeding tool results back to the LLM, which triggers a new LLM call).

- [ ] **Step 1: Add failing tests for multi-turn + tool_calls**

Append to `test/examples/claude-code/loop.test.ts`:

```ts
describe('ClaudeCodeAgentLoopAdapter -- multi-turn + tool_calls', () => {
  it('opens turn N+1 placeholder on tool_result, closes on next assistant-text', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two files' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.02, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host, makeStubExeca(stdoutLines)));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turns).toHaveLength(2);
    const idx = (a: typeof turns[number]) =>
      ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] as number;
    expect(turns.map(idx).sort()).toEqual([0, 1]);
  });

  it('records tool_calls with canonical AgentTurnMeta shape (tool, args, result, outcome)', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host, makeStubExeca(stdoutLines)));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turn0 = turns.find(
      (a) => ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] === 0
    )!;
    const meta = (turn0.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const toolCalls = meta['tool_calls'] as ReadonlyArray<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0]!;
    expect(tc['tool']).toBe('Bash');
    expect(tc).toHaveProperty('args');
    expect(tc).toHaveProperty('result');
    expect(tc).toHaveProperty('outcome');
    expect(tc).toHaveProperty('latency_ms');
    expect(tc['outcome']).toBe('success');
  });

  it('classifies tool_result with is_error AND "Permission denied" content as policy-refused', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'rm -rf /' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Permission denied: tool not allowed', is_error: true }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host, makeStubExeca(stdoutLines)));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turn0 = turns.find(
      (a) => ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] === 0
    )!;
    const meta = (turn0.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const tc = (meta['tool_calls'] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(tc['outcome']).toBe('policy-refused');
  });

  it('classifies tool_result with is_error AND no policy phrase as tool-error', async () => {
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'cat /nope' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ENOENT', is_error: true }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host, makeStubExeca(stdoutLines)));
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turn0 = turns.find(
      (a) => ((a.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>)['turn_index'] === 0
    )!;
    const meta = (turn0.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const tc = (meta['tool_calls'] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(tc['outcome']).toBe('tool-error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: 4 NEW failures (existing tests still pass).

- [ ] **Step 3: Implement multi-turn + tool_calls in `loop.ts`**

In the `for await` loop in `run()`, add cases:

```ts
} else if (ev.kind === 'tool-use') {
  if (currentTurnAtomId === null) {
    // CLI emitted tool_use before any system event; open turn 0 lazily.
    currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, prompt);
    pendingFirstTurnOpened = true;
  }
  const argsStr = JSON.stringify(ev.input);
  let redactedArgs: string;
  try {
    redactedArgs = input.redactor.redact(argsStr, { kind: 'tool-args', principal: input.principal });
  } catch (e) {
    throw Object.assign(new Error('redactor crashed on tool_use args'), { name: 'RedactorError', cause: e });
  }
  // Append a tool_call entry on the current turn atom; result is empty
  // pending; outcome is optimistic 'success' until tool_result lands.
  const turnAtom = await input.host.atoms.get(currentTurnAtomId);
  if (turnAtom !== null) {
    const meta = turnAtom.metadata as Record<string, unknown>;
    const turnMeta = meta['agent_turn'] as AgentTurnMeta;
    const newIndex = turnMeta.tool_calls.length; // index BEFORE we append
    const updated: AgentTurnMeta = {
      ...turnMeta,
      tool_calls: [...turnMeta.tool_calls, {
        tool: ev.toolName,
        args: { inline: redactedArgs },
        result: { inline: '' },
        latency_ms: 0,
        outcome: 'success',
      }],
    };
    await input.host.atoms.update(currentTurnAtomId, { metadata: { agent_turn: updated } });
    // Track BOTH which turn AND which tool_call index this id maps
    // to. Parallel tool_use blocks within one assistant message land
    // as multiple entries in tool_calls; the LAST-empty-result
    // heuristic could write the wrong tool's result into the wrong
    // entry. The (tool_use_id -> turn_id, index) pair is the only
    // safe correlation.
    toolUseToTurn.set(ev.toolUseId, currentTurnAtomId);
    toolUseToCallIndex.set(ev.toolUseId, newIndex);
    toolUseStartMs.set(ev.toolUseId, Date.now());
  }
} else if (ev.kind === 'tool-result') {
  const targetTurnId = toolUseToTurn.get(ev.toolUseId);
  const targetCallIndex = toolUseToCallIndex.get(ev.toolUseId);
  if (targetTurnId === undefined || targetCallIndex === undefined) {
    // Unknown tool_use_id -- log + skip; never throw.
    continue;
  }
  let redactedResult: string;
  try {
    redactedResult = input.redactor.redact(ev.content, { kind: 'tool-result', principal: input.principal });
  } catch (e) {
    throw Object.assign(new Error('redactor crashed on tool_result'), { name: 'RedactorError', cause: e });
  }
  const targetAtom = await input.host.atoms.get(targetTurnId);
  if (targetAtom !== null) {
    const meta = targetAtom.metadata as Record<string, unknown>;
    const turnMeta = meta['agent_turn'] as AgentTurnMeta;
    const startedToolMs = toolUseStartMs.get(ev.toolUseId) ?? Date.now();
    const policyDenied = ev.isError && /permission denied|tool not allowed/i.test(ev.content);
    const outcome: 'success' | 'tool-error' | 'policy-refused' = ev.isError
      ? (policyDenied ? 'policy-refused' : 'tool-error')
      : 'success';
    // Replace the SPECIFIC tool_calls[targetCallIndex] entry. This is
    // safe under parallel tool_use blocks because the index was
    // recorded at tool_use time, before the result arrived.
    const newCalls = turnMeta.tool_calls.slice();
    const existing = newCalls[targetCallIndex];
    if (existing !== undefined) {
      newCalls[targetCallIndex] = {
        tool: existing.tool,
        args: existing.args,
        result: { inline: redactedResult },
        latency_ms: Date.now() - startedToolMs,
        outcome,
      };
    }
    const updated: AgentTurnMeta = { ...turnMeta, tool_calls: newCalls };
    await input.host.atoms.update(targetTurnId, { metadata: { agent_turn: updated } });
  }
  toolUseToTurn.delete(ev.toolUseId);
  toolUseToCallIndex.delete(ev.toolUseId);
  toolUseStartMs.delete(ev.toolUseId);
  // Now open the NEXT placeholder turn -- the CLI is feeding tool
  // results back to the LLM, which triggers a new LLM call.
  currentTurnIndex += 1;
  currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, '<tool-results-summary>');
}
```

Also add these correlation maps alongside `toolUseToTurn`:

```ts
const toolUseToCallIndex = new Map<string, number>();   // tool_use_id -> index in current turn's tool_calls
const toolUseStartMs = new Map<string, number>();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: PASS (8 tests now total).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/loop.ts test/examples/claude-code/loop.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): multi-turn placeholder + tool_calls correlation"
```

---

## Task 8: Blob-threshold routing for over-threshold payloads

**Files:**
- Modify: `examples/agent-loops/claude-code/loop.ts`
- Modify: `test/examples/claude-code/loop.test.ts`

**Security + correctness considerations:**
- Threshold check is on the BYTE length of the redacted payload (not pre-redaction). A redactor could shrink a secret-laden input below the threshold; that's fine.
- Blob-store put MUST happen before atom write so the BlobRef is valid when the atom is read by a consumer.
- BlobStore failure (put throws) escalates to `kind: 'error'` with `failure: catastrophic` (cannot fall through to inline because the data may be too large to fit safely in an atom).

- [ ] **Step 1: Add failing tests**

Append to `test/examples/claude-code/loop.test.ts`:

```ts
describe('ClaudeCodeAgentLoopAdapter -- blob threshold', () => {
  it('routes large llm_output through blobStore.put when over threshold', async () => {
    const host = createMemoryHost();
    let putCount = 0;
    const counting: BlobStore = {
      put: async (c) => {
        putCount += 1;
        const buf = typeof c === 'string' ? Buffer.from(c) : c;
        const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
        return ref;
      },
      get: async () => Buffer.alloc(0),
      has: async () => true,
    };
    const longText = 'x'.repeat(8192);
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const input = { ...mkInput(host, makeStubExeca(stdoutLines)), blobStore: counting, blobThreshold: 4096 };
    await adapter.run(input);
    expect(putCount).toBeGreaterThanOrEqual(1);
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turnMeta = (turns[0]!.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
    const llmOutput = turnMeta['llm_output'] as Record<string, unknown>;
    expect(llmOutput).toHaveProperty('ref');
    expect(typeof llmOutput['ref']).toBe('string');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: 1 NEW failure.

- [ ] **Step 3: Implement blob-threshold routing**

Add helper in `loop.ts`:

```ts
async function routePayload(
  payload: string,
  blobStore: BlobStore,
  threshold: number,
): Promise<{ inline: string } | { ref: BlobRef }> {
  if (Buffer.byteLength(payload, 'utf8') > threshold) {
    const ref = await blobStore.put(payload);
    return { ref };
  }
  return { inline: payload };
}
```

Then update the `assistant-text` branch to call `routePayload` for `llm_output` and the `tool_use` / `tool_result` branches similarly for `args` / `result`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/loop.ts test/examples/claude-code/loop.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): blob-threshold routing for over-threshold payloads"
```

---

## Task 9: Adapter-side budget guards (wall_clock_ms + max_turns)

**Files:**
- Modify: `examples/agent-loops/claude-code/loop.ts`
- Modify: `test/examples/claude-code/loop.test.ts`

**Security + correctness considerations:**
- `setTimeout(killSubprocess, max_wall_clock_ms)` MUST be cleared on normal exit; otherwise a hung timer leaks the closure (memory leak in a long-lived host).
- `max_turns` counter is incremented when a placeholder turn opens. Trigger: the *next* placeholder open is BLOCKED if we'd exceed `max_turns`.
- Budget exhaustion -> `kind: 'budget-exhausted'` (NOT `kind: 'error'`). Substrate distinguishes these.
- SIGTERM is the soft signal; SIGKILL after `killGracePeriodMs` (default 5000) is the hard fallback.

- [ ] **Step 1: Add failing tests**

Append to `test/examples/claude-code/loop.test.ts`:

```ts
describe('ClaudeCodeAgentLoopAdapter -- budget guards', () => {
  it('terminates with kind=budget-exhausted when max_turns is reached', async () => {
    const host = createMemoryHost();
    // Stream emits 5 turn-result-turn cycles; max_turns=2 should kill after 2.
    const lines: string[] = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
    ];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: {} }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'ok', is_error: false }] } }));
    }
    lines.push(JSON.stringify({ type: 'result', cost_usd: 0.05, is_error: false }));
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(lines) });
    const input = {
      ...mkInput(host, makeStubExeca(lines)),
      budget: { max_turns: 2, max_wall_clock_ms: 60_000, max_usd: 1 },
    };
    const result = await adapter.run(input);
    expect(result.kind).toBe('budget-exhausted');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: 1 NEW failure.

- [ ] **Step 3: Implement budget guards**

In `run()`:
- Set up `const wallClockTimer = setTimeout(() => proc.kill('SIGTERM'), input.budget.max_wall_clock_ms);` after `spawnClaudeCli`.
- In the placeholder-open path, check `if (currentTurnIndex >= input.budget.max_turns) { proc.kill('SIGTERM'); kind = 'budget-exhausted'; failure = {kind: 'structural', reason: 'turn budget hit', stage: 'max-turns-cap'}; break; }`.
- In `finally`, `clearTimeout(wallClockTimer)`.
- After the loop, if `kind === 'completed'` and the proc exited because of our timer, set `kind = 'aborted'` and `failure = {kind: 'catastrophic', reason: 'wall-clock budget exhausted'}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/loop.ts test/examples/claude-code/loop.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): adapter-side budget guards (wall_clock + max_turns)"
```

---

## Task 10: AbortSignal forwarding (SIGTERM + SIGKILL after grace)

**Files:**
- Modify: `examples/agent-loops/claude-code/loop.ts`
- Modify: `test/examples/claude-code/loop.test.ts`

**Security + correctness considerations:**
- AbortSignal already aborted at entry: throw immediately, do NOT spawn subprocess.
- AbortSignal fires mid-run: forward SIGTERM. Wait `killGracePeriodMs` (default 5000). If still alive, SIGKILL.
- Result: `kind: 'aborted'`, `failure: {kind: 'catastrophic', reason: 'caller cancelled'}`.

- [ ] **Step 1: Add failing tests**

Append to `test/examples/claude-code/loop.test.ts`:

```ts
describe('ClaudeCodeAgentLoopAdapter -- signal handling', () => {
  it('throws AbortError-equivalent when signal is already aborted', async () => {
    const host = createMemoryHost();
    const ac = new AbortController();
    ac.abort();
    const stdoutLines = [JSON.stringify({ type: 'result', cost_usd: 0, is_error: false })];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    const result = await adapter.run(mkInput(host, makeStubExeca(stdoutLines), ac.signal));
    expect(result.kind).toBe('aborted');
    expect(result.failure?.kind).toBe('catastrophic');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: 1 NEW failure.

- [ ] **Step 3: Implement signal forwarding**

In `run()`:
- At the very top of `try`, check `if (input.signal?.aborted) { kind = 'aborted'; failure = {kind: 'catastrophic', reason: 'signal already aborted at entry', stage: 'signal'}; return; }`.
- Listener: `input.signal?.addEventListener('abort', () => { proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), this.opts.killGracePeriodMs ?? 5000); });`.
- The execa `signal:` option already forwards.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/claude-code/loop.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/loop.ts test/examples/claude-code/loop.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): AbortSignal forwarding with SIGTERM + SIGKILL grace"
```

---

## Task 11: Update barrel + README

**Files:**
- Modify: `examples/agent-loops/claude-code/index.ts`
- Modify: `examples/agent-loops/claude-code/README.md`

**Security + correctness considerations:**
- The barrel is a downstream-import surface. Removing the skeleton class is a breaking change for any consumer (this PR landed alongside; no external consumer exists today).
- The README is the first place a developer reads. It MUST describe the production adapter accurately, not the skeleton.

- [ ] **Step 1: Update barrel**

Replace `examples/agent-loops/claude-code/index.ts`:

```ts
export { ClaudeCodeAgentLoopAdapter } from './loop.js';
export type { ClaudeCodeAgentLoopOptions } from './loop.js';
```

- [ ] **Step 2: Update README**

Replace `examples/agent-loops/claude-code/README.md`:

```markdown
# Claude Code Agent Loop Adapter

Production `AgentLoopAdapter` that spawns the Claude Code CLI in agentic-headless mode and streams turn-by-turn output as `agent-turn` atoms.

## Usage

```ts
import { ClaudeCodeAgentLoopAdapter } from 'layered-autonomous-governance/examples/agent-loops/claude-code';

const adapter = new ClaudeCodeAgentLoopAdapter({
  // claudePath?: string -- default: 'claude' on PATH
  // killGracePeriodMs?: number -- default: 5000
});

// Pass to AgenticCodeAuthorExecutor:
const executor = buildAgenticCodeAuthorExecutor({
  agentLoop: adapter,
  workspaceProvider, blobStore, redactor, ghClient, host, principal, /* ... */
});
```

## Capabilities

- `tracks_cost: true` -- reads `cost_usd` from the stream-json `result` envelope.
- `supports_signal: true` -- forwards SIGTERM, then SIGKILL after `killGracePeriodMs`.
- `classify_failure` -- adapter-specific classifier for CLI stderr shapes.

## CLI invocation

`claude -p "<prompt>" --output-format stream-json --verbose --disable-slash-commands --mcp-config '{"mcpServers":{}}' [--max-budget-usd N] [--disallowedTools "tool1 tool2"]`

`--verbose` is REQUIRED for stream-json to emit per-turn lines. The adapter sets `cwd:` via execa option (the CLI does not accept `--cwd`).

## Authentication

Uses the operator's existing Claude Code OAuth install. No `ANTHROPIC_API_KEY` required.

See the spec at `docs/superpowers/specs/2026-04-25-real-claude-code-agent-loop-adapter-design.md` for the full design.
```

- [ ] **Step 3: Run build to verify nothing broke**

Run: `npm run build`
Expected: tsc clean.

- [ ] **Step 4: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/index.ts examples/agent-loops/claude-code/README.md
node scripts/git-as.mjs lag-ceo commit -m "feat(claude-code): update barrel + README for production adapter"
```

---

## Task 12: End-to-end on `MemoryHost` with canonical-shape assertion

**Files:**
- Modify: `test/e2e/agentic-actor-loop-chain.test.ts`

**Security + correctness considerations:**
- The test asserts canonical `AgentTurnMeta` field NAMES exactly (`tool` not `tool_name`, etc). This is a regression guard: a future refactor cannot silently drift back to a non-canonical shape (which CR caught in PR3 round 1).

- [ ] **Step 1: Add the new test**

Append to `test/e2e/agentic-actor-loop-chain.test.ts`:

```ts
describe('agentic-actor-loop end-to-end -- canonical AgentTurnMeta shape', () => {
  it('emitted agent-turn atoms match the canonical substrate field names exactly', async () => {
    // Use the real adapter + a stubbed CLI so the test exercises the
    // production code path that emits atoms.
    const host = createMemoryHost();
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
    ];
    const { Readable } = await import('node:stream');
    const stub = (async () => ({
      stdout: Readable.from(stdoutLines.map((l) => `${l}\n`)),
      stderr: { on: () => {}, [Symbol.asyncIterator]: async function* () { yield ''; } },
      exitCode: 0,
    } as never)) as never;
    const { ClaudeCodeAgentLoopAdapter } = await import('../../examples/agent-loops/claude-code/loop.js');
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: stub });
    // ... wire through the executor (mirror the existing chain test) ...
    // After execute, query agent-turn atoms.
    // Assert each turn's metadata.agent_turn has these keys EXACTLY:
    //   ['session_atom_id', 'turn_index', 'llm_input', 'llm_output', 'tool_calls', 'latency_ms']
    // Assert tool_calls[i] has these keys:
    //   ['tool', 'args', 'result', 'latency_ms', 'outcome']
    // Assert outcome is one of 'success' | 'tool-error' | 'policy-refused'.
  });
});
```

(This task's full test body is in the plan-execution working set; the implementer fills in the executor wiring by mirroring `chain: plan -> agentic executor -> stub adapter -> stub gh -> dispatched success` from earlier in the same file.)

- [ ] **Step 2: Run the e2e test to verify it fails**

Run: `npx vitest run test/e2e/agentic-actor-loop-chain.test.ts`
Expected: FAIL.

- [ ] **Step 3: Run the e2e test to verify it passes after the field-name assertions are wired correctly**

Run: `npx vitest run test/e2e/agentic-actor-loop-chain.test.ts`
Expected: PASS (4 tests now).

- [ ] **Step 4: Commit**

```bash
node scripts/git-as.mjs lag-ceo add test/e2e/agentic-actor-loop-chain.test.ts
node scripts/git-as.mjs lag-ceo commit -m "test(e2e): assert canonical AgentTurnMeta shape from real adapter"
```

---

## Task 13: Pre-push validation + open PR + drive to merge

**Files:** none (this task is operational).

**Security + correctness considerations:**
- Pre-push grep MUST scan the same scope as CI (per memory `feedback_lint_ci_fidelity_discipline`): emdashes, private terms, design/ADR refs in `src/`, AI attribution leaks.
- Push via `git-as lag-ceo` WITHOUT the `-u` flag (per memory `feedback_git_as_minus_u_leaks_token`).
- PR body cites the spec + plan paths and the parent PRs (#166, #167) so the reviewer has full context.

- [ ] **Step 1: Run the full pre-push grep checklist**

```bash
# emdash check (matches CI scope exactly)
grep -rP --exclude-dir=fixtures --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist $'\u2014' src/ test/ docs/ examples/ README.md design/ 2>/dev/null && echo "FAIL: emdashes" || echo "OK: no emdashes"

# Private terms (matches CI)
git ls-files | grep -v '^\.github/workflows/ci\.yml$' | xargs grep -lEi '\bphx\b|Phoenix|palace-phoenix' 2>/dev/null && echo "FAIL: private terms" || echo "OK"

# AI attribution
grep -rEn 'Co-Authored-By|🤖|Generated with.*Claude|claude\.ai' --include='*.ts' --include='*.md' src/ test/ docs/ examples/ 2>/dev/null && echo "FAIL: AI attribution" || echo "OK"

# Framework src/ docs purity
grep -rEn 'design/|DECISIONS\.md|\bPR1\b|\bPR2\b|\bPR3\b' src/ 2>/dev/null && echo "FAIL: PR-phase or design refs in src/" || echo "OK"
```

- [ ] **Step 2: Run the full test suite**

```bash
npm run build && npm run test
```

Expected: tsc clean, 1900+ tests pass (up from 1902 on PR2's tip; PR3 adds ~30+ new tests across the helpers).

- [ ] **Step 3: Push the branch**

```bash
node scripts/git-as.mjs lag-ceo push origin pr3/real-claude-code-agent-loop-adapter
```

- [ ] **Step 4: Open the PR**

```bash
node scripts/gh-as.mjs lag-ceo pr create \
  --base main \
  --head pr3/real-claude-code-agent-loop-adapter \
  --title "feat(examples/agent-loops/claude-code): real Claude Code CLI adapter (PR3 of agentic-actor-loop)" \
  --body "$(cat <<'EOF'
## Summary

PR3 of the agentic-actor-loop spec at `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md` (deferred follow-up per Section 8.3). Replaces the substrate-validation skeleton at `examples/agent-loops/claude-code/loop.ts` with a production adapter.

Builds on PR1 (#166) substrate + PR2 (#167) AgenticCodeAuthorExecutor.

The adapter:
- Spawns `claude -p --output-format stream-json --verbose ...` via execa, with `cwd: workspace.path` set as an execa option.
- Parses NDJSON line-by-line; emits typed events (`system`, `assistant-text`, `tool-use`, `tool-result`, `result`, `parse-error`).
- Writes a placeholder `agent-turn` atom on each LLM-call boundary (the `system` event for turn 0; the `user.tool_result` event for turn N+1) BEFORE the assistant message lands. Subprocess crash mid-turn leaves a complete audit trail through turn N + a placeholder for the in-flight turn N+1.
- Updates the placeholder atom as `assistant-text`, `tool_use`, and `tool_result` events arrive, applying redactor to every payload before atom write.
- Routes over-threshold payloads through `BlobStore.put()` (returns `{ref: BlobRef}` form of the discriminated union; under-threshold payloads stay `{inline: string}`).
- Honors `BudgetCap.max_turns` (counter; SIGTERM at limit), `BudgetCap.max_wall_clock_ms` (timer; SIGTERM at limit), `BudgetCap.max_usd` (forwarded to CLI's `--max-budget-usd`).
- Honors `AbortSignal` via execa's `signal:` option PLUS an explicit listener that forwards SIGTERM, then SIGKILL after `killGracePeriodMs` (default 5000ms).
- Captures commit SHA + branch + touched paths via post-CLI git commands inside `workspace.path`.

Spec: `docs/superpowers/specs/2026-04-25-real-claude-code-agent-loop-adapter-design.md` (committed at `7d072fb`).
Plan: `docs/superpowers/plans/2026-04-25-real-claude-code-agent-loop-adapter.md`.

## Cross-cutting discipline

Every plan task carried a "Security + correctness considerations" subsection that the implementer subagent walked through BEFORE writing code, not after CR flagged it. Same discipline as PR1 + PR2.

## Test plan

- Full vitest suite passes.
- `tsc` build clean.
- Pre-push grep parity with CI.
- New unit tests cover all 5 helpers.
- New adapter-with-stub tests cover happy-path lifecycle, multi-turn, tool_calls, blob threshold, budget guards, signal forwarding.
- New e2e test asserts canonical `AgentTurnMeta` shape from the real adapter through the executor on `MemoryHost`.

## Out of scope

- Real-process integration test (opt-in via `process.env.CLAUDE_CODE_INTEGRATION_TEST`; ships a skipped placeholder that operators can flip on locally).
- Strict replay tier (canon snapshot pinning) -- separate follow-up.
- Other-actor migrations (planning / auditor / pr-landing).

## Related

- PR #166 (substrate foundations).
- PR #167 (AgenticCodeAuthorExecutor).
- Memory: `project_pr2_agentic_code_author_executor_landed.md` (named real Claude Code CLI integration as next).
EOF
)"
```

- [ ] **Step 5: Trigger CodeRabbit review**

```bash
node scripts/trigger-cr-review.mjs --pr <pr-number>
```

- [ ] **Step 6: Drive to merge**

Wait for CR + CI. Address findings (use the same reply-with-rationale + GraphQL resolveReviewThread pattern as PR1 + PR2). Merge when CR APPROVED + CodeRabbit status SUCCESS + all checks green + zero unresolved threads.

```bash
node scripts/gh-as.mjs lag-ceo pr merge <pr-number> --squash --delete-branch --admin
```

- [ ] **Step 7: Pull main locally**

```bash
git checkout main
node scripts/git-as.mjs lag-ceo pull origin main
```

- [ ] **Step 8: Save milestone memory**

Save `project_pr3_real_claude_code_agent_loop_adapter_landed.md` and update `MEMORY.md` index.

---

## Notes for the implementer

1. **Existing skeleton is the reference.** `examples/agent-loops/claude-code/loop.ts` (current main version) shows the substrate-side patterns (atom write shape, redactor application, session atom lifecycle). The production adapter replaces it; do not preserve the skeleton class.

2. **Reference argv pattern.** `src/daemon/cli-renderer/claude-streaming.ts:120-135` is the canonical reference for `claude -p` argv in stream-json mode. Mirror exactly: `--verbose`, `--disable-slash-commands`, `--mcp-config '{"mcpServers":{}}'` are all required. The CLI does NOT accept `--cwd`; cwd is set via execa's option.

3. **Cost field name.** The stream-json envelope's cost field is `cost_usd`, NOT `total_cost_usd` (the latter is on the JSON-format envelope used by `src/adapters/claude-cli/llm.ts`). Validated against `src/daemon/cli-renderer/claude-stream-parser.ts:159`.

4. **AgentTurnMeta field names are load-bearing.** `tool` (not `tool_name`); `args` / `result` as `{inline: string} | {ref: BlobRef}`; `outcome` in `'success' | 'tool-error' | 'policy-refused'`. CR caught a non-canonical drift in spec round 1; the e2e test (Task 12) is the regression guard.

5. **Substrate contract: write atom BEFORE LLM call.** The placeholder pattern in §4.0 of the spec satisfies this. Open the placeholder on `system` event for turn 0; on `user.tool_result` for turn N+1. Update with content as `assistant-text` / `tool_use` / `tool_result` arrive.

6. **Redactor crash = `failure: catastrophic`.** Substrate-level invariant. Never write unredacted content.

7. **Budget exhaustion `kind: 'budget-exhausted'`, NOT `kind: 'error'`.** Substrate distinguishes them.

8. **Frequent commits per task.** Each task ends with a commit. PR3 should land with ~13 commits (one per task).

9. **Bot identity discipline:**
   - Every commit: `node scripts/git-as.mjs lag-ceo commit ...`
   - Every push: `node scripts/git-as.mjs lag-ceo push origin pr3/real-claude-code-agent-loop-adapter` (NO `-u`).
   - Every gh action: `node scripts/gh-as.mjs lag-ceo ...`.

10. **Pre-push grep before EVERY push.** The full one-liner is in Task 13.

11. **Validate parallel tool_use against real CLI output.** Plan-reviewer round 2 flagged this as advisory: Claude Code CLI's stream-json format may emit multiple `tool_use` blocks under ONE `assistant` event (parallel tool calls in a single LLM turn), and their results back-to-back under ONE `user` event before the next assistant turn. The current parser at Task 1 returns ONE event per line; with parallel tool_use blocks, additional blocks would be silently lost. The current adapter at Task 7 opens a new placeholder turn on EVERY `tool-result`; with N parallel tool_results, that would over-increment `currentTurnIndex` to N when it should be 1. **Implementer action**: during Task 1's tests, feed a real CLI capture (or a synthetic line containing two `tool_use` blocks) and observe behavior. If real CLI does emit parallel blocks per line, change `parseStreamJsonLine` to return `ReadonlyArray<StreamJsonEvent>` (collect all blocks; tests updated to check `events[0].kind`), and change the adapter loop to iterate per-line events with one placeholder-bump per `user`-line cluster. This is a known gap the spec did not anticipate; surface it during implementation if real CLI behavior confirms it.

12. **Performance hint (advisory):** The current `assistant-text` branch reads the full turn atom from the AtomStore on every event to preserve `llm_input` + `tool_calls`. For long streaming runs this is many round-trips. A future optimization mirrors `tool_calls` in a local map and avoids the read-back. Not required for correctness; flag for follow-up if observed at scale.
